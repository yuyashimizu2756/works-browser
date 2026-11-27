//! 選択したファイルの削除（#15）。
//!
//! - 既定は **ゴミ箱へ移動**（Windows は `trash` crate の `IFileOperation`）
//! - `permanent = true` のときだけ `fs::remove_file` で恒久削除（UI は Shift+Delete）
//! - 登録ルートの外・シンボリックリンク / ジャンクション・ルート外を指すリンクは拒否
//! - 読み取り専用・使用中・権限なしはスキップし、`{ id, reason }` で返す
//! - 実ファイルの削除に成功したものだけ DB から消す（空の作品も消す）
//! - サムネイルキャッシュ（`thumbs/<sha1>.webp`）も一緒に消す
//!
//! UI からは `files.id` だけを受け取り、パスは必ず DB から引く。
//! 大量削除でも UI が固まらないよう、1 件ごとに [`DeleteProgress`] を返す。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;
use serde::Serialize;

use crate::index::db::{self, FileSnapshot};
use crate::index::Result;
use crate::thumbs;

/// 削除できなかった 1 件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeleteFailure {
    pub id: i64,
    pub reason: String,
}

/// `delete_files` の戻り値。UI はこれをそのまま確認結果に使う。
#[derive(Debug, Clone, Serialize)]
pub struct DeleteResult {
    /// 削除できた件数。
    pub deleted: i64,
    /// スキップした件数と理由。
    pub failed: Vec<DeleteFailure>,
    /// 恒久削除だったか（false = ゴミ箱）。
    pub permanent: bool,
    /// ゴミ箱から戻せる場合の Undo トークン。恒久削除・復元不可なら `None`。
    pub undo_id: Option<String>,
    /// 削除できたファイルの合計サイズ。
    pub deleted_bytes: i64,
    /// キャンセルされたか（成功分は確定済み）。
    pub cancelled: bool,
}

/// `delete://progress` のペイロード。
#[derive(Debug, Clone, Serialize)]
pub struct DeleteProgress {
    /// 処理済み件数（成功 + 失敗）。
    pub done: i64,
    pub total: i64,
    pub id: i64,
    pub name: String,
}

/// 削除の実行条件。
pub struct DeleteOptions<'a> {
    pub permanent: bool,
    /// サムネイルキャッシュのルート（`thumbs/default_cache_dir`）。
    pub cache_dir: &'a Path,
    /// キャンセルフラグ。1 件処理するたびに確認する。
    pub cancel: &'a AtomicBool,
}

/// 削除の内部結果。Undo 用の控えをコマンド層へ渡す。
pub struct DeleteOutcome {
    pub result: DeleteResult,
    pub snapshots: Vec<FileSnapshot>,
    pub trashed_paths: Vec<PathBuf>,
    pub root_ids: Vec<i64>,
}

/// Undo 1 回分。ゴミ箱の項目と、DB に戻すためのスナップショット。
#[derive(Debug)]
pub struct UndoBatch {
    pub id: String,
    pub items: Vec<trash::TrashItem>,
    pub snapshots: Vec<FileSnapshot>,
    pub root_ids: Vec<i64>,
}

/// `undo_delete` の戻り値。
#[derive(Debug, Clone, Default, Serialize)]
pub struct UndoResult {
    /// ゴミ箱から戻した件数（推定）。
    pub restored: i64,
    /// DB に索引し直したファイル行数。
    pub reindexed: i64,
    /// 戻せなかった理由。
    pub failed: Vec<String>,
    /// 表示を更新するルート。
    pub root_ids: Vec<i64>,
}

// ---------------------------------------------------------------------------
// パス検証
// ---------------------------------------------------------------------------

/// 比較用の正規化（区切り・大文字小文字を揃える）。`roots.rs` と同じ考え方。
fn comparable(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('/', "\\");
    raw.trim_end_matches('\\').to_lowercase()
}

fn is_within(path: &Path, base: &Path) -> bool {
    let target = comparable(path);
    let base = comparable(base);
    if base.is_empty() || target.is_empty() {
        return false;
    }
    target == base || target.starts_with(&format!("{base}\\"))
}

/// Windows のジャンクション / シンボリックリンク（再解析ポイント）か。
#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

/// `rel_path` がルート直下に閉じているか（`..` や絶対パスを拒否）。
fn relative_is_safe(rel_path: &str) -> bool {
    let mut components = Path::new(rel_path).components();
    if !components.any(|component| matches!(component, Component::Normal(_))) {
        return false;
    }
    !Path::new(rel_path).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

/// 1 ファイルの削除可否を検証し、実ファイルのパスを返す。
///
/// `canonical_root` は呼び出し側で `fs::canonicalize(root)` したもの（毎回の
/// 正規化を避ける）。返る `Err` の文字列はそのまま失敗理由として UI に出る。
pub fn validate_target(
    canonical_root: &Path,
    root_real_path: &str,
    rel_path: &str,
) -> std::result::Result<PathBuf, String> {
    if !relative_is_safe(rel_path) {
        return Err("登録ルートの外を指すパスのため削除できません".to_string());
    }

    let path = db::join_root(root_real_path, rel_path);
    let meta = fs::symlink_metadata(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "ファイルが見つかりません".to_string(),
        _ => format!("ファイルを確認できません: {error}"),
    })?;

    if meta.file_type().is_symlink() || is_reparse_point(&meta) {
        return Err("シンボリックリンク / ジャンクションは削除できません".to_string());
    }
    if !meta.is_file() {
        return Err("ファイルではありません".to_string());
    }
    if meta.permissions().readonly() {
        return Err("読み取り専用のためスキップしました".to_string());
    }

    let resolved = fs::canonicalize(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "ファイルが見つかりません".to_string()
        } else {
            format!("パスを解決できません: {error}")
        }
    })?;
    if !is_within(&resolved, canonical_root) {
        return Err("登録ルートの外にあるため削除できません".to_string());
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

fn io_reason(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => {
            "使用中か、権限がないためスキップしました".to_string()
        }
        std::io::ErrorKind::NotFound => "ファイルが見つかりません".to_string(),
        _ => format!("削除できません: {error}"),
    }
}

fn trash_reason(error: &trash::Error) -> String {
    match error {
        trash::Error::CouldNotAccess { .. } => {
            "使用中か、権限がないためゴミ箱へ移動できません".to_string()
        }
        trash::Error::Os { code: 5 | 32, .. } => {
            "使用中か、権限がないためゴミ箱へ移動できません".to_string()
        }
        trash::Error::TargetedRoot => "ドライブ直下は削除できません".to_string(),
        other => format!("ゴミ箱へ移動できません: {other}"),
    }
}

fn remove_one(path: &Path, permanent: bool) -> std::result::Result<(), String> {
    if permanent {
        fs::remove_file(path).map_err(|error| io_reason(&error))
    } else {
        trash::delete(path).map_err(|error| trash_reason(&error))
    }
}

/// サムネイルキャッシュの削除対象。
///
/// DB に入っている `thumb_path` と、`root_real_path + rel_path` から計算する
/// 正規の `thumbs/<sha1>.webp` の両方を見る（設定変更で場所がずれた過去分も消す）。
fn thumbnail_paths(snapshot: &FileSnapshot, cache_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![thumbs::cache_path(
        cache_dir,
        &snapshot.root_real_path,
        &snapshot.rel_path,
    )];
    if let Some(stored) = snapshot.thumb_path.as_deref() {
        let stored = PathBuf::from(stored);
        if is_within(&stored, cache_dir) {
            paths.push(stored);
        }
    }
    paths
}

fn remove_thumbnails(snapshots: &[FileSnapshot], cache_dir: &Path) {
    let mut removed = HashSet::new();
    for snapshot in snapshots {
        for path in thumbnail_paths(snapshot, cache_dir) {
            if removed.insert(comparable(&path)) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// ゴミ箱へまとめて移す単位。
///
/// `IFileOperation` は 1 回の呼び出しにまとめると速いが、1 件失敗すると全体が
/// 中断して理由が 1 つしか返らない。まず 50 件ずつまとめて試し、失敗した
/// チャンクだけ 1 件ずつ実行して理由を特定する。
const TRASH_BATCH: usize = 50;

/// パス検証を通った削除候補。
struct Candidate {
    snapshot: FileSnapshot,
    path: PathBuf,
}

impl Candidate {
    fn success(&self, permanent: bool, trashed_paths: &mut Vec<PathBuf>) -> FileSnapshot {
        if !permanent {
            trashed_paths.push(db::join_root(
                &self.snapshot.root_real_path,
                &self.snapshot.rel_path,
            ));
        }
        self.snapshot.clone()
    }
}

/// 選択された `files.id` を削除する。
///
/// 実ファイルの削除に成功したものだけ `files` から消し、空になった `works` も消す。
/// 失敗した id は DB に残すので、UI は再読み込みすればそのまま見える。
pub fn delete(
    conn: &mut Connection,
    ids: &[i64],
    options: &DeleteOptions<'_>,
    progress: &mut dyn FnMut(DeleteProgress),
) -> Result<DeleteOutcome> {
    let ids = db::unique_ids(ids);
    let total = ids.len() as i64;
    let snapshots = db::file_snapshots(conn, &ids)?;
    let by_id: HashMap<i64, FileSnapshot> = snapshots
        .into_iter()
        .map(|snapshot| (snapshot.id, snapshot))
        .collect();

    let mut canonical_roots: HashMap<i64, std::result::Result<PathBuf, String>> = HashMap::new();
    let mut deleted_snapshots: Vec<FileSnapshot> = Vec::new();
    let mut failures: Vec<DeleteFailure> = Vec::new();
    let mut trashed_paths: Vec<PathBuf> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut deleted_bytes = 0i64;
    let mut cancelled = false;
    let mut done = 0i64;

    // 1. 索引とパスを検証する（実ファイルにはまだ触らない）。
    for id in &ids {
        if options.cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }

        let Some(snapshot) = by_id.get(id) else {
            failures.push(DeleteFailure {
                id: *id,
                reason: "ファイルが見つかりません（索引にありません）".to_string(),
            });
            done += 1;
            progress(DeleteProgress {
                done,
                total,
                id: *id,
                name: String::new(),
            });
            continue;
        };

        let canonical_root = canonical_roots.entry(snapshot.root_id).or_insert_with(|| {
            fs::canonicalize(&snapshot.root_real_path)
                .map_err(|error| format!("登録ルートを参照できません: {error}"))
        });

        let validated = match canonical_root {
            Ok(root) => validate_target(root, &snapshot.root_real_path, &snapshot.rel_path),
            Err(reason) => Err(reason.clone()),
        };

        match validated {
            Ok(path) => candidates.push(Candidate {
                snapshot: snapshot.clone(),
                path,
            }),
            Err(reason) => {
                failures.push(DeleteFailure { id: *id, reason });
                done += 1;
                progress(DeleteProgress {
                    done,
                    total,
                    id: *id,
                    name: snapshot.name.clone(),
                });
            }
        }
    }

    // 2. 実ファイルを削除する。
    if options.permanent {
        for candidate in &candidates {
            if options.cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            match fs::remove_file(&candidate.path) {
                Ok(()) => {
                    deleted_bytes += candidate.snapshot.bytes;
                    deleted_snapshots.push(candidate.success(true, &mut trashed_paths));
                }
                Err(error) => failures.push(DeleteFailure {
                    id: candidate.snapshot.id,
                    reason: io_reason(&error),
                }),
            }
            done += 1;
            progress(DeleteProgress {
                done,
                total,
                id: candidate.snapshot.id,
                name: candidate.snapshot.name.clone(),
            });
        }
    } else {
        let mut start = 0;
        while start < candidates.len() {
            if options.cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            let end = (start + TRASH_BATCH).min(candidates.len());
            let chunk = &candidates[start..end];
            let paths: Vec<&Path> = chunk
                .iter()
                .map(|candidate| candidate.path.as_path())
                .collect();

            // まとめて成功したら 1 回の IFileOperation で終わる（大量削除用）。
            if trash::delete_all(&paths).is_ok() {
                for candidate in chunk {
                    deleted_bytes += candidate.snapshot.bytes;
                    deleted_snapshots.push(candidate.success(false, &mut trashed_paths));
                    done += 1;
                    progress(DeleteProgress {
                        done,
                        total,
                        id: candidate.snapshot.id,
                        name: candidate.snapshot.name.clone(),
                    });
                }
            } else {
                // 失敗したチャンクは 1 件ずつ実行して、どのファイルがなぜ失敗したかを返す。
                for candidate in chunk {
                    if options.cancel.load(Ordering::SeqCst) {
                        cancelled = true;
                        break;
                    }
                    // `delete_all` が途中まで進んで中断した場合、既にゴミ箱へ入った
                    // ファイルは存在しない。二重に失敗扱いしない。
                    let already_gone = !candidate.path.exists();
                    let outcome = if already_gone {
                        Ok(())
                    } else {
                        remove_one(&candidate.path, false)
                    };
                    match outcome {
                        Ok(()) => {
                            deleted_bytes += candidate.snapshot.bytes;
                            deleted_snapshots.push(candidate.success(false, &mut trashed_paths));
                        }
                        Err(reason) => failures.push(DeleteFailure {
                            id: candidate.snapshot.id,
                            reason,
                        }),
                    }
                    done += 1;
                    progress(DeleteProgress {
                        done,
                        total,
                        id: candidate.snapshot.id,
                        name: candidate.snapshot.name.clone(),
                    });
                }
            }
            start = end;
        }
    }

    // 3. 実ファイルが消えた後の後始末。DB は成功分だけ消す。
    let deleted_ids: Vec<i64> = deleted_snapshots
        .iter()
        .map(|snapshot| snapshot.id)
        .collect();
    db::remove_file_rows(conn, &deleted_ids)?;
    remove_thumbnails(&deleted_snapshots, options.cache_dir);

    let mut root_ids: Vec<i64> = Vec::new();
    for snapshot in &deleted_snapshots {
        if !root_ids.contains(&snapshot.root_id) {
            root_ids.push(snapshot.root_id);
        }
    }

    Ok(DeleteOutcome {
        result: DeleteResult {
            deleted: deleted_snapshots.len() as i64,
            failed: failures,
            permanent: options.permanent,
            undo_id: None,
            deleted_bytes,
            cancelled,
        },
        snapshots: deleted_snapshots,
        trashed_paths,
        root_ids,
    })
}

// ---------------------------------------------------------------------------
// Undo（ゴミ箱から復元）
// ---------------------------------------------------------------------------

/// ゴミ箱の一覧から、いま削除したパスに対応する項目を拾う。
///
/// 同じパスを過去にも削除している場合があるので、削除開始秒以降のものだけを見る。
pub fn match_trash_items(
    paths: &[PathBuf],
    deleted_at_or_after: i64,
) -> std::result::Result<Vec<trash::TrashItem>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: HashSet<String> = paths.iter().map(|path| comparable(path)).collect();
    let items =
        trash::os_limited::list().map_err(|error| format!("ゴミ箱を読めません: {error}"))?;
    Ok(items
        .into_iter()
        .filter(|item| {
            wanted.contains(&comparable(&item.original_path()))
                && item.time_deleted >= deleted_at_or_after
        })
        .collect())
}

/// Undo トークンを作る。秒単位 + 連番で十分（アプリ内の単発操作）。
pub fn new_undo_id() -> String {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("undo-{}-{}", db::now_ms(), count)
}

/// ゴミ箱から戻し、スナップショットから DB の行を作り直す。
pub fn undo(
    conn: &mut Connection,
    items: Vec<trash::TrashItem>,
    snapshots: Vec<FileSnapshot>,
    root_ids: Vec<i64>,
) -> std::result::Result<UndoResult, String> {
    let mut failed: Vec<String> = Vec::new();

    match trash::os_limited::restore_all(items) {
        Ok(()) => {}
        Err(trash::Error::RestoreCollision { path, .. }) => {
            failed.push(format!(
                "{} は同じ名前のファイルがあるため戻せません。エクスプローラのゴミ箱から復元してください",
                path.display()
            ));
        }
        Err(trash::Error::RestoreTwins { path, .. }) => {
            failed.push(format!(
                "{} がゴミ箱に複数あるため戻せません。エクスプローラのゴミ箱から復元してください",
                path.display()
            ));
        }
        Err(error) => failed.push(format!(
            "ゴミ箱から戻せません: {error}。エクスプローラのゴミ箱から復元してください"
        )),
    }

    // 実際に元の場所へ戻ったものだけ索引し直す（衝突で戻らなかった分は除く）。
    let present: Vec<FileSnapshot> = snapshots
        .into_iter()
        .filter(|snapshot| db::join_root(&snapshot.root_real_path, &snapshot.rel_path).is_file())
        .collect();
    let restored = present.len() as i64;
    let reindexed =
        db::restore_file_snapshots(conn, &present).map_err(|error| error.to_string())?;

    Ok(UndoResult {
        restored,
        reindexed: reindexed as i64,
        failed,
        root_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    struct Fixture {
        conn: Connection,
        root: TempDir,
        outside: TempDir,
        cache: TempDir,
        root_id: i64,
    }

    impl Fixture {
        fn new() -> Self {
            let conn = db::open_in_memory().unwrap();
            let root = TempDir::new().unwrap();
            let outside = TempDir::new().unwrap();
            let cache = TempDir::new().unwrap();
            let real = db::display_path(root.path());
            conn.execute(
                "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
                 VALUES (?1, ?1, 'root', 1, 1, 0)",
                params![real],
            )
            .unwrap();
            Self {
                conn,
                root,
                outside,
                cache,
                root_id: 1,
            }
        }

        fn work(&self, rel_path: &str) -> i64 {
            self.conn
                .execute(
                    "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
                     VALUES (?1, ?2, ?2, 'image', 0, 0, 0, 0, 0)",
                    params![self.root_id, rel_path],
                )
                .unwrap();
            self.conn.last_insert_rowid()
        }

        /// ルート配下に実ファイルを作り、索引にも 1 行足す。
        fn file(&self, work_id: i64, rel_path: &str, bytes: u64) -> i64 {
            let path = db::join_root(&db::display_path(self.root.path()), rel_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, vec![b'x'; bytes as usize]).unwrap();
            self.index_file(work_id, rel_path, bytes)
        }

        fn index_file(&self, work_id: i64, rel_path: &str, bytes: u64) -> i64 {
            let name = Path::new(rel_path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            self.conn
                .execute(
                    "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime)
                     VALUES (?1, ?2, ?3, 'image', ?4, 1)",
                    params![work_id, rel_path, name, bytes as i64],
                )
                .unwrap();
            let id = self.conn.last_insert_rowid();
            self.conn
                .execute(
                    "UPDATE works SET file_count = file_count + 1,
                       total_bytes = total_bytes + ?2, mtime = 1 WHERE id = ?1",
                    params![work_id, bytes as i64],
                )
                .unwrap();
            id
        }
    }

    fn run_on(
        conn: &mut Connection,
        cache_dir: &Path,
        ids: &[i64],
        permanent: bool,
    ) -> DeleteOutcome {
        run_on_with_cancel(
            conn,
            cache_dir,
            ids,
            permanent,
            &AtomicBool::new(false),
            |_| {},
        )
    }

    fn run_on_with_cancel(
        conn: &mut Connection,
        cache_dir: &Path,
        ids: &[i64],
        permanent: bool,
        cancel: &AtomicBool,
        mut progress: impl FnMut(DeleteProgress),
    ) -> DeleteOutcome {
        delete(
            conn,
            ids,
            &DeleteOptions {
                permanent,
                cache_dir,
                cancel,
            },
            &mut progress,
        )
        .unwrap()
    }

    fn stats(conn: &Connection) -> (i64, i64) {
        let stats = db::library_stats(conn).unwrap();
        (stats.works, stats.files)
    }

    #[test]
    fn rejects_path_outside_root() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        // ルートの外を指す相対パスを索引に混ぜる（壊れた DB を想定）。
        let outside_file = fixture.outside.path().join("outside.png");
        fs::write(&outside_file, b"secret").unwrap();
        let id = fixture.index_file(work, r"..\outside.png", 6);

        let outcome = run_on(&mut fixture.conn, fixture.cache.path(), &[id], true);
        assert_eq!(outcome.result.deleted, 0);
        assert_eq!(outcome.result.failed.len(), 1);
        assert!(
            outcome.result.failed[0].reason.contains("登録ルートの外"),
            "reason: {}",
            outcome.result.failed[0].reason
        );
        assert!(
            outside_file.exists(),
            "ルート外のファイルを消してはいけない"
        );
        assert_eq!(stats(&fixture.conn).1, 1, "失敗した行は DB に残す");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_symlink_target() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let outside_file = fixture.outside.path().join("target.png");
        fs::write(&outside_file, b"secret").unwrap();

        let link = fixture.root.path().join("link.png");
        if std::os::windows::fs::symlink_file(&outside_file, &link).is_err() {
            eprintln!("シンボリックリンクを作れない環境のためスキップします");
            return;
        }
        let id = fixture.index_file(work, "link.png", 6);

        let outcome = run_on(&mut fixture.conn, fixture.cache.path(), &[id], true);
        assert_eq!(outcome.result.deleted, 0);
        assert!(
            outcome.result.failed[0]
                .reason
                .contains("シンボリックリンク"),
            "reason: {}",
            outcome.result.failed[0].reason
        );
        assert!(outside_file.exists());
        assert!(link.exists());
    }

    #[test]
    fn deletes_and_keeps_db_consistent() {
        let mut fixture = Fixture::new();
        let first = fixture.work("work-a");
        let second = fixture.work("work-b");
        let a1 = fixture.file(first, r"work-a\1.png", 10);
        let a2 = fixture.file(first, r"work-a\2.png", 20);
        let b1 = fixture.file(second, r"work-b\1.png", 30);

        let outcome = run_on(&mut fixture.conn, fixture.cache.path(), &[a1, a2], true);
        assert_eq!(outcome.result.deleted, 2);
        assert_eq!(outcome.result.deleted_bytes, 30);
        assert!(outcome.result.failed.is_empty());
        assert!(outcome.result.undo_id.is_none());

        // 作品 A は空になったので消え、作品 B だけ残る。
        assert_eq!(stats(&fixture.conn), (1, 1));
        let remaining: String = fixture
            .conn
            .query_row("SELECT rel_path FROM files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(remaining, r"work-b\1.png");
        assert!(
            fixture
                .conn
                .query_row(
                    "SELECT COUNT(*) FROM works WHERE id = ?1",
                    params![first],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap()
                == 0
        );

        // 残った作品の集計は 30 バイト・1 ファイル。
        let (count, bytes): (i64, i64) = fixture
            .conn
            .query_row(
                "SELECT file_count, total_bytes FROM works WHERE id = ?1",
                params![second],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, bytes), (1, 30));

        let outcome = run_on(&mut fixture.conn, fixture.cache.path(), &[b1], true);
        assert_eq!(outcome.result.deleted, 1);
        assert_eq!(stats(&fixture.conn), (0, 0));
    }

    #[test]
    #[allow(clippy::permissions_set_readonly_false)]
    fn reports_readonly_and_missing_reasons() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let readonly = fixture.file(work, r"w\readonly.png", 4);
        let path = fixture.root.path().join("w").join("readonly.png");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let missing = fixture.index_file(work, r"w\missing.png", 1);

        let outcome = run_on(
            &mut fixture.conn,
            fixture.cache.path(),
            &[readonly, missing],
            true,
        );
        assert_eq!(outcome.result.deleted, 0);
        assert_eq!(outcome.result.failed.len(), 2);
        assert!(outcome
            .result
            .failed
            .iter()
            .any(|failure| failure.id == readonly && failure.reason.contains("読み取り専用")));
        assert!(outcome
            .result
            .failed
            .iter()
            .any(|failure| failure.id == missing && failure.reason.contains("見つかりません")));
        assert_eq!(stats(&fixture.conn).1, 2, "失敗分は索引に残す");

        // 後始末（readonly を外さないと TempDir が消せない）
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
    }

    #[test]
    fn undo_snapshot_restores_db_rows() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let first = fixture.file(work, r"w\1.png", 10);
        let second = fixture.file(work, r"w\2.png", 20);

        let outcome = run_on(
            &mut fixture.conn,
            fixture.cache.path(),
            &[first, second],
            true,
        );
        assert_eq!(stats(&fixture.conn), (0, 0));

        // Undo 相当: 実ファイルが戻った状態でスナップショットから索引を作り直す。
        fs::write(fixture.root.path().join("w").join("1.png"), vec![b'x'; 10]).unwrap();
        fs::write(fixture.root.path().join("w").join("2.png"), vec![b'x'; 20]).unwrap();
        let restored = db::restore_file_snapshots(&mut fixture.conn, &outcome.snapshots).unwrap();
        assert_eq!(restored, 2);
        assert_eq!(stats(&fixture.conn), (1, 2));

        let (count, bytes): (i64, i64) = fixture
            .conn
            .query_row(
                "SELECT file_count, total_bytes FROM works WHERE id = ?1",
                params![work],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((count, bytes), (2, 30));
    }

    #[test]
    fn removes_thumbnail_cache() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let id = fixture.file(work, r"w\thumb.png", 4);
        let root_real = db::display_path(fixture.root.path());
        let thumb = thumbs::cache_path(fixture.cache.path(), &root_real, r"w\thumb.png");
        fs::write(&thumb, b"webp").unwrap();
        fixture
            .conn
            .execute(
                "UPDATE files SET thumb_path = ?1 WHERE id = ?2",
                params![db::display_path(&thumb), id],
            )
            .unwrap();

        run_on(&mut fixture.conn, fixture.cache.path(), &[id], true);
        assert!(!thumb.exists(), "サムネイルキャッシュが残っている");
    }

    #[test]
    fn cancel_stops_after_current_item() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let ids: Vec<i64> = (0..3)
            .map(|index| fixture.file(work, &format!(r"w\{index}.png"), 1))
            .collect();
        let cancel = AtomicBool::new(false);

        let outcome = run_on_with_cancel(
            &mut fixture.conn,
            fixture.cache.path(),
            &ids,
            true,
            &cancel,
            |_| cancel.store(true, Ordering::SeqCst),
        );

        assert!(outcome.result.cancelled);
        assert_eq!(outcome.result.deleted, 1);
        assert_eq!(stats(&fixture.conn).1, 2);
    }

    #[test]
    fn progress_reports_every_item() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let ids: Vec<i64> = (0..3)
            .map(|index| fixture.file(work, &format!(r"w\{index}.png"), 1))
            .collect();
        let mut seen = Vec::new();

        run_on_with_cancel(
            &mut fixture.conn,
            fixture.cache.path(),
            &ids,
            true,
            &AtomicBool::new(false),
            |progress| seen.push((progress.done, progress.total)),
        );

        assert_eq!(seen, vec![(1, 3), (2, 3), (3, 3)]);
    }

    #[test]
    fn work_file_ids_returns_every_file() {
        let fixture = Fixture::new();
        let first = fixture.work("a");
        let second = fixture.work("b");
        fixture.file(first, r"a\1.png", 1);
        fixture.file(first, r"a\2.png", 1);
        fixture.file(second, r"b\1.png", 1);

        let ids = db::work_file_ids(&fixture.conn, &[first, second]).unwrap();
        assert_eq!(ids.len(), 3);
    }

    /// 10 ファイルを一時ディレクトリからゴミ箱へ移し、DB 件数とゴミ箱の中身を確かめる。
    #[cfg(windows)]
    #[test]
    fn ten_files_go_to_trash_and_can_be_restored() {
        let mut fixture = Fixture::new();
        let work = fixture.work("w");
        let ids: Vec<i64> = (0..10)
            .map(|index| fixture.file(work, &format!(r"w\{index}.png"), 8))
            .collect();
        let originals: Vec<PathBuf> = (0..10)
            .map(|index| fixture.root.path().join("w").join(format!("{index}.png")))
            .collect();

        let deleted_at = now_secs();
        let outcome = run_on(&mut fixture.conn, fixture.cache.path(), &ids, false);

        if outcome.result.deleted == 0 {
            // CI（セッション 0）などで IFileOperation が使えない環境向け。
            eprintln!(
                "ゴミ箱を利用できないためスキップします: {:?}",
                outcome.result.failed.first().map(|failure| &failure.reason)
            );
            return;
        }

        assert_eq!(outcome.result.deleted, 10);
        assert_eq!(stats(&fixture.conn), (0, 0));
        for path in &originals {
            assert!(!path.exists(), "{} が残っています", path.display());
        }

        let items = match_trash_items(&originals, deleted_at).unwrap_or_default();
        if items.is_empty() {
            // GitHub Actions のサービスセッションでは IFileOperation が成功しても
            // ごみ箱を列挙できないことがある。実ファイルと DB の一致だけ確認して終える
            // （ゴミ箱の中身と復元はローカルのデスクトップセッションで検証済み）。
            eprintln!("ゴミ箱を列挙できない環境のため、復元の確認はスキップします");
            return;
        }
        assert_eq!(items.len(), 10, "ゴミ箱に 10 件入っていません");

        // 実際に復元できることまで確認し、一時ファイルを消して後片付けする。
        match trash::os_limited::restore_all(items) {
            Ok(()) => {
                for path in &originals {
                    assert!(path.exists(), "{} が復元されていません", path.display());
                    let _ = fs::remove_file(path);
                }
            }
            Err(error) => eprintln!("復元を確認できませんでした（後片付けはスキップ）: {error}"),
        }
    }

    fn now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default()
    }
}
