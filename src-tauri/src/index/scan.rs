//! フォルダ走査と索引の差分更新。
//!
//! 流れ:
//! 1. `jwalk` でファイルを列挙（`follow_links(false)`、除外ディレクトリあり・並列）
//! 2. 10,000 件ずつ `rayon` でメタデータと実体 ID を取得
//! 3. 10,000 件を 1 トランザクションで UPSERT
//! 4. 走査後に集計 SQL で `works` を再計算し、消えたファイル・作品を削除
//!
//! 全ファイルをメモリに溜めないよう、常にチャンク単位で書き込む。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use jwalk::WalkDir;
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use crate::config::DEFAULT_EXCLUDE_PATTERNS;
use crate::exclude;

use super::db::{self, Root};
use super::{file_kind, metadata_and_identity, IndexError, Result};

/// 1 トランザクションで書き込むファイル数。
///
/// #50: 1,000 → 10,000。トランザクションとコミットの回数を 1/10 に減らす。
pub const CHUNK_SIZE: usize = 10_000;

/// 進捗イベントの間引き間隔。
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// 走査中に UI へ流す進捗。`scan://progress` のペイロード。
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub root_id: i64,
    pub phase: String,
    pub files: u64,
    pub works: u64,
    pub bytes: u64,
}

/// 走査完了サマリ。`scan://done` のペイロードでもある。
#[derive(Debug, Clone, Serialize)]
pub struct ScanSummary {
    pub root_id: i64,
    /// `done` | `cancelled` | `duplicate`（実体が他ルートと同一）
    pub status: String,
    pub files: u64,
    pub works: u64,
    pub total_bytes: i64,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub unchanged: u64,
    pub duplicates: u64,
    pub duration_ms: u64,
    /// このルートの全ファイルが他ルートと同一実体だった場合、その代表ルート。
    pub duplicate_of: Option<i64>,
}

#[derive(Debug)]
pub struct ScanConfig {
    pub chunk_size: usize,
    pub progress_interval: Duration,
    /// #8: 除外パターン（1 行 1 glob）。空なら何も除外しない。
    pub exclude_patterns: Vec<String>,
    /// `.ts` を MPEG-TS として索引するか（設定 `index_mpeg_ts`）。既定は `false`。
    pub index_mpeg_ts: bool,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            chunk_size: 0,
            progress_interval: Duration::ZERO,
            exclude_patterns: DEFAULT_EXCLUDE_PATTERNS
                .iter()
                .map(|pattern| (*pattern).to_string())
                .collect(),
            index_mpeg_ts: false,
        }
    }
}

impl ScanConfig {
    fn chunk_size(&self) -> usize {
        if self.chunk_size == 0 {
            CHUNK_SIZE
        } else {
            self.chunk_size
        }
    }

    fn progress_interval(&self) -> Duration {
        if self.progress_interval.is_zero() {
            PROGRESS_INTERVAL
        } else {
            self.progress_interval
        }
    }
}

struct PendingFile {
    rel_path: String,
    work_rel: String,
    name: String,
    kind: &'static str,
}

struct FileRecord {
    rel_path: String,
    work_rel: String,
    name: String,
    kind: &'static str,
    bytes: i64,
    mtime: i64,
    volume_serial: Option<u32>,
    file_index: Option<u64>,
}

#[derive(Default)]
struct ScanState {
    work_ids: HashMap<String, i64>,
    /// この走査で見た (volume_serial, file_index)。同一ルート内の重複（ハードリンク）を弾く。
    seen_identities: HashSet<(u32, u64)>,
    /// 他ルートに既に索引されている実体 → そのルート ID。
    foreign_identities: HashMap<(u32, u64), i64>,
    duplicate_by_root: HashMap<i64, u64>,
    added: u64,
    updated: u64,
    unchanged: u64,
    removed: u64,
    duplicates: u64,
    scanned: u64,
    bytes: u64,
}

/// ルートを走査して索引を更新する。
///
/// `progress` は 200ms（`config.progress_interval`）間隔で呼ばれる。
pub fn scan_root(
    conn: &mut Connection,
    root: &Root,
    cancel: &AtomicBool,
    config: &ScanConfig,
    progress: &mut dyn FnMut(ScanProgress),
) -> Result<ScanSummary> {
    let run_id = db::start_scan_run(conn, root.id)?;
    let outcome = scan_inner(conn, root, run_id, cancel, config, progress);
    if outcome.is_err() {
        // 失敗しても走査記録は残す（UI で原因を追えるように）
        let _ = db::fail_scan_run(conn, run_id);
    }
    outcome
}

fn scan_inner(
    conn: &mut Connection,
    root: &Root,
    run_id: i64,
    cancel: &AtomicBool,
    config: &ScanConfig,
    progress: &mut dyn FnMut(ScanProgress),
) -> Result<ScanSummary> {
    let started = Instant::now();
    let chunk_size = config.chunk_size();
    let interval = config.progress_interval();
    let root_path = PathBuf::from(&root.real_path);

    // 実体が既に別ルートで索引されている場合は走査そのものを省略する
    if let Some(owner) = root.duplicate_of {
        let (files, works, total_bytes) = root_totals(conn, root.id)?;
        let summary = ScanSummary {
            root_id: root.id,
            status: "duplicate".to_string(),
            files,
            works,
            total_bytes,
            added: 0,
            updated: 0,
            removed: 0,
            unchanged: 0,
            duplicates: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            duplicate_of: Some(owner),
        };
        db::finish_scan_run(
            conn,
            run_id,
            &db::ScanRunResult {
                status: "duplicate",
                added: 0,
                updated: 0,
                removed: 0,
                duplicates: 0,
                files,
                works,
                total_bytes,
            },
        )?;
        return Ok(summary);
    }

    // 同一実体の判定に使う「他ルートの実体 ID」を先に読み込む（数 MB 程度）。
    let mut state = ScanState {
        foreign_identities: load_foreign_identities(conn, root.id)?,
        ..ScanState::default()
    };

    conn.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS scan_seen (file_id INTEGER PRIMARY KEY);
     DELETE FROM scan_seen;",
    )?;

    let mut pending: Vec<PendingFile> = Vec::with_capacity(chunk_size);
    let mut last_emit: Option<Instant> = None;
    let mut cancelled = cancel.load(Ordering::Relaxed);

    if !cancelled {
        let patterns = config.exclude_patterns.clone();
        let filter_root = root_path.clone();
        // #50: ディレクトリ列挙を並列化する。`process_read_dir` で除外を落とすので、
        // 除外ディレクトリには降りない（walkdir の `filter_entry` と同じ）。
        let walker = WalkDir::new(&root_path)
            .skip_hidden(false)
            .follow_links(false)
            .process_read_dir(move |_depth, _path, _state, children| {
                children.retain(|entry| match entry {
                    // jwalk はルートの親ディレクトリも読む。ルート自身は除外判定しない
                    // （`.*` に一致する名前のフォルダをルートに指定できるようにする）。
                    Ok(entry) => {
                        let path = entry.path();
                        path == filter_root || !is_excluded_path(&path, &filter_root, &patterns)
                    }
                    Err(_) => false,
                });
            });

        for entry in walker {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }

            let Ok(entry) = entry else {
                // 権限なしなどは黙って飛ばす（走査全体は止めない）
                continue;
            };
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let Some(kind) = file_kind(&path, config.index_mpeg_ts) else {
                continue;
            };
            let Ok(rel) = path.strip_prefix(&root_path) else {
                continue;
            };
            let Some(work_rel) = work_rel_path(rel, root.depth) else {
                // depth より浅い位置のファイル（ルート直下のバラ置き等）は作品に属さない
                continue;
            };
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };

            pending.push(PendingFile {
                rel_path: native_string(rel),
                work_rel,
                name: name.to_string(),
                kind,
            });

            if pending.len() >= chunk_size {
                let records = build_records(&root_path, &pending);
                write_chunk(conn, root, &records, &mut state)?;
                pending.clear();

                if should_emit(last_emit, interval) {
                    emit_progress(root.id, "scanning", &state, progress);
                    last_emit = Some(Instant::now());
                }
            }
        }
    }

    if !cancelled && !pending.is_empty() {
        let records = build_records(&root_path, &pending);
        write_chunk(conn, root, &records, &mut state)?;
    }
    pending.clear();

    if !cancelled {
        emit_progress(root.id, "finalizing", &state, progress);
        state.removed = delete_missing(conn, root.id)?;
        aggregate_works(conn, root.id)?;
        state.duplicate_of_root(conn, root.id)?;
    } else {
        // キャンセル時も、書き込み済みの範囲で作品の集計だけは整えておく
        aggregate_works(conn, root.id)?;
    }

    let (files, works, total_bytes) = root_totals(conn, root.id)?;
    let status = if cancelled { "cancelled" } else { "done" };
    let summary = ScanSummary {
        root_id: root.id,
        status: status.to_string(),
        files,
        works,
        total_bytes,
        added: state.added,
        updated: state.updated,
        removed: state.removed,
        unchanged: state.unchanged,
        duplicates: state.duplicates,
        duration_ms: started.elapsed().as_millis() as u64,
        duplicate_of: None,
    };

    let duplicate_of = duplicate_of(conn, root.id)?;
    db::finish_scan_run(
        conn,
        run_id,
        &db::ScanRunResult {
            status,
            added: summary.added,
            updated: summary.updated,
            removed: summary.removed,
            duplicates: summary.duplicates,
            files: summary.files,
            works: summary.works,
            total_bytes: summary.total_bytes,
        },
    )?;

    conn.execute_batch("DROP TABLE IF EXISTS scan_seen;")?;

    Ok(ScanSummary {
        duration_ms: started.elapsed().as_millis() as u64,
        duplicate_of,
        ..summary
    })
}

fn should_emit(last: Option<Instant>, interval: Duration) -> bool {
    last.is_none_or(|last| last.elapsed() >= interval)
}

fn emit_progress(
    root_id: i64,
    phase: &str,
    state: &ScanState,
    progress: &mut dyn FnMut(ScanProgress),
) {
    progress(ScanProgress {
        root_id,
        phase: phase.to_string(),
        files: state.scanned,
        works: state.work_ids.len() as u64,
        bytes: state.bytes,
    });
}

/// フォルダ / ファイル名と相対パスを除外パターンに当てる（#8）。
fn is_excluded_path(path: &Path, root: &Path, patterns: &[String]) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let rel = path
        .strip_prefix(root)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| name.clone());
    exclude::is_excluded(&rel, &name, patterns)
}

/// 走査・監視で共通の除外ディレクトリ名（`.git` / `node_modules` など）。
///
/// 監視（#7）も同じ規則でイベントを捨てる。`walk` と判定がずれると
/// 「走査では入らないのに監視では入る」ファイルができるため、ここに集約する。
/// #8 のカスタム除外は [`is_excluded_entry`] が設定から読む。
pub(crate) fn is_excluded_name(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("node_modules")
        || name.eq_ignore_ascii_case("__pycache__")
}

/// OS の区切り文字のまま保存する（Windows なら `\`）。
fn native_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// `rel_path` の先頭 `depth` 要素を作品キーにする。
///
/// - `depth = 0`: ルート直下のファイルだけを 1 作品（`""`）にまとめる
/// - `depth = n`: 先頭 n 階層。n 階層目より浅いファイルは、存在する階層までを作品名にする
///
/// 例: `depth = 1` のとき `作品/ファイル` は `作品`、ルート直下の `ファイル` は
/// ルート自体の作品（`""`）に入る。ルート直下のバラ置きを取りこぼさないための扱い。
pub(crate) fn work_rel_path(rel: &Path, depth: i64) -> Option<String> {
    let components: Vec<String> = rel
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();

    if depth <= 0 {
        return (components.len() == 1).then(String::new);
    }

    // ファイル名を除いた階層のうち、depth までを作品キーにする
    let take = (depth as usize).min(components.len().saturating_sub(1));
    Some(components[..take].join(std::path::MAIN_SEPARATOR_STR))
}

/// チャンク内のファイルを並列に stat してレコード化する。
///
/// #50: メタデータと実体 ID を 1 回の `open` で取る（以前は 2 回開いていた）。
fn build_records(root_path: &Path, pending: &[PendingFile]) -> Vec<FileRecord> {
    pending
        .par_iter()
        .filter_map(|pending| {
            let absolute = root_path.join(&pending.rel_path);
            let (meta, identity) = metadata_and_identity(&absolute)?;
            if !meta.is_file() {
                return None;
            }
            Some(FileRecord {
                rel_path: pending.rel_path.clone(),
                work_rel: pending.work_rel.clone(),
                name: pending.name.clone(),
                kind: pending.kind,
                bytes: meta.len() as i64,
                mtime: db::modified_ms(&meta),
                volume_serial: identity.map(|(volume, _)| volume),
                file_index: identity.map(|(_, index)| index),
            })
        })
        .collect()
}

/// 他ルートに索引済みの実体 ID → ルート ID。
fn load_foreign_identities(conn: &Connection, root_id: i64) -> Result<HashMap<(u32, u64), i64>> {
    let mut stmt = conn.prepare(
        "SELECT f.volume_serial, f.file_index, w.root_id
     FROM files f JOIN works w ON w.id = f.work_id
     WHERE w.root_id <> ?1 AND f.volume_serial IS NOT NULL AND f.file_index IS NOT NULL",
    )?;
    let rows = stmt.query_map([root_id], |row| {
        let volume: i64 = row.get(0)?;
        let index: i64 = row.get(1)?;
        let owner: i64 = row.get(2)?;
        Ok(((volume as u32, index as u64), owner))
    })?;

    let mut map = HashMap::new();
    for row in rows {
        let (identity, owner) = row?;
        map.entry(identity).or_insert(owner);
    }
    Ok(map)
}

/// 1 チャンクを 1 トランザクションで UPSERT する。
fn write_chunk(
    conn: &mut Connection,
    root: &Root,
    records: &[FileRecord],
    state: &mut ScanState,
) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }

    let transaction = conn.transaction()?;
    write_chunk_inner(&transaction, root, records, state)?;
    transaction.commit()?;
    Ok(())
}

fn write_chunk_inner(
    transaction: &Transaction<'_>,
    root: &Root,
    records: &[FileRecord],
    state: &mut ScanState,
) -> Result<()> {
    let now = db::now_ms();
    let mut upsert_work = transaction.prepare(
        "INSERT INTO works(root_id, rel_path, title, kind, mtime, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'image', ?4, ?4, ?4)
     ON CONFLICT(root_id, rel_path) DO UPDATE SET updated_at = excluded.updated_at
     RETURNING id",
    )?;
    let mut find_file = transaction
        .prepare("SELECT id, bytes, mtime FROM files WHERE work_id = ?1 AND rel_path = ?2")?;
    let mut insert_file = transaction.prepare(
        "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime, volume_serial, file_index)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    let mut update_file = transaction.prepare(
    "UPDATE files SET bytes = ?2, mtime = ?3, volume_serial = ?4, file_index = ?5 WHERE id = ?1",
  )?;
    let mut mark_seen =
        transaction.prepare("INSERT OR IGNORE INTO scan_seen(file_id) VALUES (?1)")?;

    for record in records {
        state.scanned += 1;
        state.bytes += record.bytes.max(0) as u64;

        // 同一実体（他ルート / 同一ルート内のハードリンク）は先勝ちでスキップ
        if let (Some(volume), Some(index)) = (record.volume_serial, record.file_index) {
            let identity = (volume, index);
            if let Some(owner) = state.foreign_identities.get(&identity) {
                state.duplicates += 1;
                *state.duplicate_by_root.entry(*owner).or_default() += 1;
                continue;
            }
            if !state.seen_identities.insert(identity) {
                state.duplicates += 1;
                continue;
            }
        }

        let work_id = match state.work_ids.get(&record.work_rel) {
            Some(id) => *id,
            None => {
                let title = if record.work_rel.is_empty() {
                    root.label.clone()
                } else {
                    Path::new(&record.work_rel)
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| record.work_rel.clone())
                };
                let id: i64 = upsert_work
                    .query_row(params![root.id, record.work_rel, title, now], |row| {
                        row.get(0)
                    })?;
                state.work_ids.insert(record.work_rel.clone(), id);
                id
            }
        };

        let existing: Option<(i64, i64, i64)> = find_file
            .query_row(params![work_id, record.rel_path], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()?;

        match existing {
            Some((file_id, bytes, mtime)) => {
                mark_seen.execute([file_id])?;
                if bytes != record.bytes || mtime != record.mtime {
                    update_file.execute(params![
                        file_id,
                        record.bytes,
                        record.mtime,
                        record.volume_serial,
                        record.file_index.map(|index| index as i64)
                    ])?;
                    state.updated += 1;
                } else {
                    state.unchanged += 1;
                }
            }
            None => {
                insert_file.execute(params![
                    work_id,
                    record.rel_path,
                    record.name,
                    record.kind,
                    record.bytes,
                    record.mtime,
                    record.volume_serial,
                    record.file_index.map(|index| index as i64)
                ])?;
                mark_seen.execute([transaction.last_insert_rowid()])?;
                state.added += 1;
            }
        }
    }

    Ok(())
}

/// 今回見つからなかったファイルを削除する（差分更新の「削除」）。
fn delete_missing(conn: &mut Connection, root_id: i64) -> Result<u64> {
    let transaction = conn.transaction()?;
    {
        let mut delete_files = transaction.prepare(
            "DELETE FROM files
       WHERE work_id IN (SELECT id FROM works WHERE root_id = ?1)
         AND id NOT IN (SELECT file_id FROM scan_seen)",
        )?;
        delete_files.execute([root_id])?;
    }
    let removed = transaction.changes();

    // ファイルが 1 つも残らない作品は消す（作品の削除 = 空フォルダ相当）
    transaction.execute(
        "DELETE FROM works
     WHERE root_id = ?1 AND NOT EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id)",
        [root_id],
    )?;
    transaction.commit()?;
    Ok(removed)
}

/// 作品ごとの集計を SQL 1 本で再計算する。
///
/// 削除・UPSERT・集計を 1 トランザクションにまとめたい監視（#7）でも使えるよう
/// `&Connection` を受ける（`Transaction` は `Deref` でそのまま渡せる）。
pub(crate) fn aggregate_works(conn: &Connection, root_id: i64) -> Result<()> {
    let now = db::now_ms();
    conn.execute(
    "UPDATE works SET
       file_count = (SELECT COUNT(*) FROM files WHERE files.work_id = works.id),
       total_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM files WHERE files.work_id = works.id),
       mtime = (SELECT COALESCE(MAX(mtime), works.mtime) FROM files WHERE files.work_id = works.id),
       kind = CASE
         WHEN EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'image')
          AND EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'video') THEN 'mixed'
         WHEN EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'video') THEN 'video'
         ELSE 'image'
       END,
       updated_at = ?2
     WHERE root_id = ?1
       AND EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id)",
    params![root_id, now],
  )?;

    // カバーは「最初の動画 → 最初の画像 → 先頭ファイル」（#3）
    db::refresh_covers(conn)?;
    Ok(())
}

impl ScanState {
    /// 全ファイルが他ルートの重複実体だった場合、このルートを `duplicate_of` に記録し、
    /// 索引済みの作品を落とす（片方だけ索引するという設計に合わせる）。
    fn duplicate_of_root(&mut self, conn: &mut Connection, root_id: i64) -> Result<()> {
        let unique = self.added + self.updated + self.unchanged;
        if unique > 0 || self.duplicates == 0 {
            return Ok(());
        }

        let Some((&owner, _)) = self
            .duplicate_by_root
            .iter()
            .max_by_key(|(_, count)| **count)
        else {
            return Ok(());
        };

        conn.execute(
            "UPDATE roots SET duplicate_of = ?1 WHERE id = ?2",
            params![owner, root_id],
        )?;
        conn.execute("DELETE FROM works WHERE root_id = ?1", [root_id])?;
        Ok(())
    }
}

fn duplicate_of(conn: &Connection, root_id: i64) -> Result<Option<i64>> {
    conn.query_row(
        "SELECT duplicate_of FROM roots WHERE id = ?1",
        [root_id],
        |row| row.get(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(IndexError::from)
}

fn root_totals(conn: &Connection, root_id: i64) -> Result<(u64, u64, i64)> {
    conn.query_row(
    "SELECT
       (SELECT COUNT(*) FROM files f JOIN works w ON w.id = f.work_id WHERE w.root_id = ?1),
       (SELECT COUNT(*) FROM works w WHERE w.root_id = ?1),
       (SELECT COALESCE(SUM(f.bytes), 0) FROM files f JOIN works w ON w.id = f.work_id WHERE w.root_id = ?1)",
    [root_id],
    |row| {
      let files: i64 = row.get(0)?;
      let works: i64 = row.get(1)?;
      let bytes: i64 = row.get(2)?;
      Ok((files as u64, works as u64, bytes))
    },
  )
  .map_err(IndexError::from)
}
