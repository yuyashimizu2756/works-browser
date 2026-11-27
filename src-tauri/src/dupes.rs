//! 重複・類似画像の検出（#67）。
//!
//! 類似アプリ（Eagle の重複スキャン / Hydrus の similar files / XnView の類似検索）に倣い、
//! **バイト単位で同一のファイル**と、**見た目が近い画像**をまとめる。
//!
//! - `files.content_hash` … 内容の SHA-1。完全一致の判定に使う。
//! - `files.dhash` … 9x8 グレースケール差分ハッシュ（64bit）。類似の判定に使う。
//! - `files.hash_mtime` / `hash_bytes` … 計算時点の元ファイル情報。変わったら再計算する。
//!
//! 解析は重いので明示実行（バックグラウンド + 進捗 `dupes://progress` + キャンセル）。
//! 結果は DB に残るため、2 回目以降の表示は即時。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use image::imageops::FilterType;
use image::DynamicImage;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::index::db;
use crate::thumbs::photo;

/// dHash のビット数。
pub const DHASH_BITS: u32 = 64;

/// 未解析（または元ファイルが変わった）ファイルの条件。
const PENDING_FILTER: &str = "f.hash_mtime IS NULL
   OR f.hash_bytes IS NULL
   OR f.hash_mtime <> f.mtime
   OR f.hash_bytes <> f.bytes";

/// `dupes_analyze` 1 回の既定件数。
const ANALYZE_BATCH: usize = 1200;

/// 解析結果。
#[derive(Debug, Clone, Default, Serialize)]
pub struct AnalyzeSummary {
    pub total: u64,
    pub hashed: u64,
    pub images: u64,
    pub failed: u64,
    pub remaining: u64,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// 重複判定の状態（ダイアログを開いたときに表示する）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct DupesStats {
    /// 索引済みの（有効ルートの）ファイル数。
    pub total: i64,
    /// 内容ハッシュを計算済みの件数。
    pub hashed: i64,
    /// 未解析の件数。
    pub pending: i64,
    /// dHash を計算済みの画像数。
    pub analyzed_images: i64,
    /// 完全一致グループ数。
    pub exact_groups: i64,
    /// 完全一致で「余っている」バイト数（重複分の合計）。
    pub exact_wasted_bytes: i64,
}

/// グループ内の 1 ファイル。
#[derive(Debug, Clone, Serialize)]
pub struct DupFile {
    pub id: i64,
    pub work_id: i64,
    pub name: String,
    pub rel_path: String,
    pub kind: String,
    pub bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub mtime: i64,
    /// 残す 1 枚（画素数 → バイト数 → 新しい順 → id 昇順で選ぶ）。
    pub keeper: bool,
}

/// 重複 1 グループ。
#[derive(Debug, Clone, Serialize)]
pub struct DupGroup {
    /// `exact:<hash>` / `similar:<rep hash>`。
    pub key: String,
    pub files: Vec<DupFile>,
    pub total_bytes: i64,
    /// 1 枚だけ残したときに空くバイト数。
    pub wasted_bytes: i64,
}

/// 解析対象 1 件。
struct Job {
    file_id: i64,
    kind: String,
    abs_path: PathBuf,
    mtime: i64,
    bytes: i64,
}

/// `dupes_analyze` のキャンセル・二重実行を防ぐ状態。
pub struct DupesState {
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    pub running: AtomicBool,
}

impl Default for DupesState {
    fn default() -> Self {
        Self {
            cancel: Mutex::new(None),
            running: AtomicBool::new(false),
        }
    }
}

// ---------------------------------------------------------------------------
// ハッシュ
// ---------------------------------------------------------------------------

/// ファイル内容の SHA-1（16 進）。完全一致の判定に使う。
pub fn content_hash(path: &Path) -> std::io::Result<String> {
    let mut reader = BufReader::with_capacity(1 << 20, File::open(path)?);
    let mut hasher = Sha1::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// 9x8 に縮小したグレースケールの隣接差分（64bit）。
///
/// 横 9 列 × 縦 8 行に縮小し、各行で「左より右が明るい」を 1bit にする。
/// 平均色や解像度に依存しないので、再エンコード・軽いトリミングに耐える。
pub fn dhash(image: &DynamicImage) -> u64 {
    let luma = image.to_luma8();
    let small = image::imageops::resize(&luma, 9, 8, FilterType::Triangle);
    let mut bits = 0_u64;
    for y in 0..8_u32 {
        for x in 0..8_u32 {
            let left = small.get_pixel(x, y)[0];
            let right = small.get_pixel(x + 1, y)[0];
            bits = (bits << 1) | u64::from(left > right);
        }
    }
    bits
}

/// 2 つの dHash のハミング距離（0〜64）。
pub fn distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// 解析対象の 1 行（クラスタリング用の最小情報）。
#[derive(Debug, Clone, Copy)]
pub struct HashRow {
    pub index: usize,
    pub hash: u64,
    pub bytes: i64,
    pub pixels: i64,
    pub mtime: i64,
}

/// BK-tree（ハミング距離の近傍探索）。
struct BkNode {
    hash: u64,
    children: Vec<(u32, BkNode)>,
}

impl BkNode {
    fn new(hash: u64) -> Self {
        Self {
            hash,
            children: Vec::new(),
        }
    }

    fn insert(&mut self, hash: u64) {
        let d = distance(self.hash, hash);
        if let Some((_, child)) = self.children.iter_mut().find(|(edge, _)| *edge == d) {
            child.insert(hash);
        } else {
            self.children.push((d, BkNode::new(hash)));
        }
    }

    fn nearest(&self, hash: u64, max: u32, best: &mut Option<(u32, u64)>) {
        let d = distance(self.hash, hash);
        if d <= max {
            let better = match best {
                Some((best_d, _)) => d < *best_d,
                None => true,
            };
            if better {
                *best = Some((d, self.hash));
            }
        }
        let from = d.saturating_sub(max);
        let to = d.saturating_add(max);
        for (edge, child) in &self.children {
            if *edge >= from && *edge <= to {
                child.nearest(hash, max, best);
            }
        }
    }
}

/// 類似画像を「代表 1 枚 + しきい値以内」でまとめる。
///
/// 連鎖で全然違う画像が混ざらないよう、比較対象は**グループの代表**だけにする。
/// 戻り値は `rows` の添字グループ（2 件以上のものだけ）。並びは入力順を保つ。
pub fn cluster(rows: &[HashRow], threshold: u32) -> Vec<Vec<usize>> {
    if rows.is_empty() {
        return Vec::new();
    }
    let threshold = threshold.min(DHASH_BITS);

    // 大きい画像を代表にしたいので、画素数 → バイト数 → 新しい順
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|a, b| {
        let (a, b) = (&rows[*a], &rows[*b]);
        b.pixels
            .cmp(&a.pixels)
            .then(b.bytes.cmp(&a.bytes))
            .then(b.mtime.cmp(&a.mtime))
            .then(a.index.cmp(&b.index))
    });

    let mut tree: Option<BkNode> = None;
    let mut groups: Vec<Vec<usize>> = Vec::new();
    // 代表ハッシュ → グループ番号
    let mut reps: HashMap<u64, usize> = HashMap::new();

    for row_index in order {
        let hash = rows[row_index].hash;
        let mut best = None;
        if let Some(node) = tree.as_ref() {
            node.nearest(hash, threshold, &mut best);
        }
        match best.and_then(|(_, rep)| reps.get(&rep).copied()) {
            Some(group) => groups[group].push(row_index),
            None => {
                reps.insert(hash, groups.len());
                groups.push(vec![row_index]);
                match tree.as_mut() {
                    Some(node) => node.insert(hash),
                    None => tree = Some(BkNode::new(hash)),
                }
            }
        }
    }

    let mut grouped: Vec<Vec<usize>> = groups
        .into_iter()
        .filter(|group| group.len() > 1)
        .map(|group| {
            let mut group = group;
            group.sort_unstable();
            group
        })
        .collect();
    grouped.sort_by_key(|group| group[0]);
    grouped
}

/// 「残す 1 枚」を選ぶ（画素数 → バイト数 → 新しい順 → id 昇順）。
pub fn pick_keeper(files: &[DupFile]) -> usize {
    let mut best = 0;
    for (index, file) in files.iter().enumerate() {
        let best_file = &files[best];
        let pixels = |f: &DupFile| f.width.unwrap_or(0) * f.height.unwrap_or(0);
        let better = pixels(file)
            .cmp(&pixels(best_file))
            .then(file.bytes.cmp(&best_file.bytes))
            .then(file.mtime.cmp(&best_file.mtime))
            .then(best_file.id.cmp(&file.id));
        if better.is_gt() {
            best = index;
        }
    }
    best
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

fn pending_count(conn: &Connection) -> rusqlite::Result<i64> {
    let sql = format!(
        "SELECT COUNT(*) FROM files f
         JOIN works w ON w.id = f.work_id
         JOIN roots r ON r.id = w.root_id
         WHERE r.enabled = 1 AND ({PENDING_FILTER})"
    );
    conn.query_row(&sql, [], |row| row.get(0))
}

fn query_jobs(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<Job>> {
    let sql = format!(
        "SELECT f.id, f.kind, f.rel_path, f.mtime, f.bytes, r.real_path
         FROM files f
         JOIN works w ON w.id = f.work_id
         JOIN roots r ON r.id = w.root_id
         WHERE r.enabled = 1 AND ({PENDING_FILTER})
         ORDER BY w.mtime DESC, f.id
         LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([limit.max(1) as i64], |row| {
        let rel_path: String = row.get(2)?;
        let root: String = row.get(5)?;
        Ok(Job {
            file_id: row.get(0)?,
            kind: row.get(1)?,
            abs_path: PathBuf::from(root).join(rel_path),
            mtime: row.get(3)?,
            bytes: row.get(4)?,
        })
    })?;
    rows.collect()
}

struct Hashed {
    job: Job,
    content: Option<String>,
    dhash: Option<u64>,
}

fn hash_job(job: Job) -> Hashed {
    let content = content_hash(&job.abs_path).ok();
    let dhash = if job.kind == "image" {
        photo::load(&job.abs_path)
            .ok()
            .map(|image| self::dhash(&image))
    } else {
        None
    };
    Hashed {
        job,
        content,
        dhash,
    }
}

/// 未解析のファイルを `limit` 件まで解析して DB に保存する。
pub fn analyze(
    conn: &Mutex<Connection>,
    limit: usize,
    cancel: &AtomicBool,
    progress: &mut (dyn FnMut(u64, u64) + Send),
) -> rusqlite::Result<AnalyzeSummary> {
    let started = Instant::now();
    let jobs = {
        let guard = conn.lock().expect("db lock poisoned");
        query_jobs(&guard, limit)?
    };
    let total = jobs.len() as u64;
    let mut summary = AnalyzeSummary {
        total,
        ..AnalyzeSummary::default()
    };
    if jobs.is_empty() {
        summary.remaining = pending_count(&conn.lock().expect("db lock poisoned"))? as u64;
        summary.elapsed_ms = started.elapsed().as_millis() as u64;
        return Ok(summary);
    }

    let parallelism = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 8);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(parallelism)
        .thread_name(|index| format!("dupes-{index}"))
        .build()
        .expect("dupes thread pool");
    let chunk_size = (parallelism * 4).max(4);
    let mut done = 0_u64;

    for chunk in jobs.chunks(chunk_size) {
        if cancel.load(Ordering::SeqCst) {
            summary.cancelled = true;
            break;
        }
        let results: Vec<Hashed> = pool.install(|| {
            use rayon::prelude::*;
            chunk
                .par_iter()
                .map(|job| {
                    hash_job(Job {
                        file_id: job.file_id,
                        kind: job.kind.clone(),
                        abs_path: job.abs_path.clone(),
                        mtime: job.mtime,
                        bytes: job.bytes,
                    })
                })
                .collect()
        });

        {
            let mut guard = conn.lock().expect("db lock poisoned");
            let transaction = guard.transaction()?;
            {
                let mut update = transaction.prepare(
                    "UPDATE files
                        SET content_hash = ?2, dhash = ?3, hash_mtime = ?4, hash_bytes = ?5
                      WHERE id = ?1",
                )?;
                for item in &results {
                    update.execute(params![
                        item.job.file_id,
                        item.content,
                        item.dhash.map(|hash| hash as i64),
                        item.job.mtime,
                        item.job.bytes,
                    ])?;
                }
            }
            transaction.commit()?;
        }

        summary.hashed += results.iter().filter(|r| r.content.is_some()).count() as u64;
        summary.images += results.iter().filter(|r| r.dhash.is_some()).count() as u64;
        summary.failed += results.iter().filter(|r| r.content.is_none()).count() as u64;
        done += results.len() as u64;
        progress(done, total);
    }

    summary.remaining = pending_count(&conn.lock().expect("db lock poisoned"))? as u64;
    summary.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(summary)
}

/// 重複判定の状態を返す。
pub fn stats(conn: &Connection) -> rusqlite::Result<DupesStats> {
    let base = "FROM files f
        JOIN works w ON w.id = f.work_id
        JOIN roots r ON r.id = w.root_id
        WHERE r.enabled = 1";

    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) {base}"), [], |row| row.get(0))?;
    let hashed: i64 = conn.query_row(
        &format!("SELECT COUNT(*) {base} AND f.content_hash IS NOT NULL"),
        [],
        |row| row.get(0),
    )?;
    let pending = pending_count(conn)?;
    let analyzed_images: i64 = conn.query_row(
        &format!("SELECT COUNT(*) {base} AND f.dhash IS NOT NULL"),
        [],
        |row| row.get(0),
    )?;
    let (exact_groups, exact_wasted): (i64, i64) = conn.query_row(
        &format!(
            "SELECT COUNT(*), COALESCE(SUM(total_bytes - keep_bytes), 0) FROM (
               SELECT SUM(f.bytes) AS total_bytes, MAX(f.bytes) AS keep_bytes
               {base} AND f.content_hash IS NOT NULL
               GROUP BY f.content_hash
               HAVING COUNT(*) > 1
             )"
        ),
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    Ok(DupesStats {
        total,
        hashed,
        pending,
        analyzed_images,
        exact_groups,
        exact_wasted_bytes: exact_wasted,
    })
}

fn file_rows(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<DupFile>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |row| {
        Ok(DupFile {
            id: row.get(0)?,
            work_id: row.get(1)?,
            name: row.get(2)?,
            rel_path: row.get(3)?,
            kind: row.get(4)?,
            bytes: row.get(5)?,
            width: row.get(6)?,
            height: row.get(7)?,
            mtime: row.get(8)?,
            keeper: false,
        })
    })?;
    rows.collect()
}

const FILE_SQL: &str = "SELECT f.id, f.work_id, f.name, f.rel_path, f.kind, f.bytes,
        f.width, f.height, f.mtime
   FROM files f
   JOIN works w ON w.id = f.work_id
   JOIN roots r ON r.id = w.root_id
   WHERE r.enabled = 1";

const FILE_SQL_WITH_HASH: &str = "SELECT f.id, f.work_id, f.name, f.rel_path, f.kind, f.bytes,
        f.width, f.height, f.mtime, f.dhash
   FROM files f
   JOIN works w ON w.id = f.work_id
   JOIN roots r ON r.id = w.root_id
   WHERE r.enabled = 1 AND f.dhash IS NOT NULL";

fn finish_group(mut files: Vec<DupFile>) -> Option<DupGroup> {
    if files.len() < 2 {
        return None;
    }
    files.sort_by(|a, b| b.bytes.cmp(&a.bytes).then(a.id.cmp(&b.id)));
    let keeper = pick_keeper(&files);
    files[keeper].keeper = true;
    let total_bytes = files.iter().map(|file| file.bytes).sum();
    let wasted_bytes = total_bytes - files[keeper].bytes;
    Some(DupGroup {
        key: String::new(),
        files,
        total_bytes,
        wasted_bytes,
    })
}

/// 完全一致（内容ハッシュが同じ）グループを返す。
pub fn exact_groups(conn: &Connection, limit: usize) -> rusqlite::Result<Vec<DupGroup>> {
    let sql = "SELECT f.content_hash, SUM(f.bytes) AS total
         FROM files f
         JOIN works w ON w.id = f.work_id
         JOIN roots r ON r.id = w.root_id
         WHERE r.enabled = 1 AND f.content_hash IS NOT NULL
         GROUP BY f.content_hash
         HAVING COUNT(*) > 1
         ORDER BY total DESC
         LIMIT ?1";
    let mut stmt = conn.prepare(sql)?;
    let hashes: Vec<String> = stmt
        .query_map([limit.max(1) as i64], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut groups = Vec::new();
    for hash in hashes {
        let files = file_rows(
            conn,
            &format!(
                "{FILE_SQL} AND f.content_hash = '{}'",
                hash.replace('\'', "")
            ),
        )?;
        if let Some(mut group) = finish_group(files) {
            group.key = format!("exact:{hash}");
            groups.push(group);
        }
    }
    groups.sort_by_key(|a| std::cmp::Reverse(a.wasted_bytes));
    Ok(groups)
}

/// 類似（dHash の距離がしきい値以内）グループを返す。
pub fn similar_groups(
    conn: &Connection,
    threshold: u32,
    limit: usize,
) -> rusqlite::Result<Vec<DupGroup>> {
    let mut stmt = conn.prepare(FILE_SQL_WITH_HASH)?;
    let items: Vec<(DupFile, u64)> = stmt
        .query_map([], |row| {
            Ok((
                DupFile {
                    id: row.get(0)?,
                    work_id: row.get(1)?,
                    name: row.get(2)?,
                    rel_path: row.get(3)?,
                    kind: row.get(4)?,
                    bytes: row.get(5)?,
                    width: row.get(6)?,
                    height: row.get(7)?,
                    mtime: row.get(8)?,
                    keeper: false,
                },
                row.get::<_, i64>(9)? as u64,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    if items.len() < 2 {
        return Ok(Vec::new());
    }

    let rows: Vec<HashRow> = items
        .iter()
        .enumerate()
        .map(|(index, (file, hash))| HashRow {
            index,
            hash: *hash,
            bytes: file.bytes,
            pixels: file.width.unwrap_or(0) * file.height.unwrap_or(0),
            mtime: file.mtime,
        })
        .collect();

    let clusters = cluster(&rows, threshold);
    let mut groups = Vec::new();
    for cluster_indices in clusters.iter().take(limit.max(1)) {
        let files: Vec<DupFile> = cluster_indices
            .iter()
            .map(|row_index| items[rows[*row_index].index].0.clone())
            .collect();
        if let Some(mut group) = finish_group(files) {
            group.key = format!("similar:{:016x}", rows[cluster_indices[0]].hash);
            groups.push(group);
        }
    }
    groups.sort_by_key(|a| std::cmp::Reverse(a.wasted_bytes));
    groups.truncate(limit.max(1));
    Ok(groups)
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

fn open_state(state: &State<'_, crate::commands::AppState>) -> Result<Connection, String> {
    db::open(&state.db_path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dupes_stats(state: State<'_, crate::commands::AppState>) -> Result<DupesStats, String> {
    let conn = open_state(&state)?;
    stats(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn dupes_groups(
    state: State<'_, crate::commands::AppState>,
    mode: Option<String>,
    threshold: Option<u32>,
    limit: Option<usize>,
) -> Result<Vec<DupGroup>, String> {
    let conn = open_state(&state)?;
    let limit = limit.unwrap_or(60).clamp(1, 500);
    match mode.as_deref().unwrap_or("exact") {
        "similar" => similar_groups(&conn, threshold.unwrap_or(8), limit),
        _ => exact_groups(&conn, limit),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_dupes(dupes: State<'_, DupesState>) -> Result<bool, String> {
    let slot = dupes
        .cancel
        .lock()
        .map_err(|_| "状態のロックに失敗しました")?;
    Ok(match slot.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

#[tauri::command]
pub async fn dupes_analyze(
    app: AppHandle,
    state: State<'_, crate::commands::AppState>,
    limit: Option<usize>,
) -> Result<AnalyzeSummary, String> {
    let dupes = app.state::<DupesState>();
    if dupes.running.swap(true, Ordering::SeqCst) {
        return Err("重複の解析は既に実行中です".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = dupes
            .cancel
            .lock()
            .map_err(|_| "状態のロックに失敗しました")?;
        *slot = Some(Arc::clone(&cancel));
    }

    let db_path = state.db_path.clone();
    let limit = limit.unwrap_or(ANALYZE_BATCH).clamp(1, 20_000);
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open(&db_path).map_err(|error| error.to_string())?;
        let conn = Mutex::new(conn);
        analyze(&conn, limit, &cancel, &mut |done, total| {
            let _ = handle.emit(
                "dupes://progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        })
        .map_err(|error| error.to_string())
    })
    .await;

    dupes.running.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = dupes.cancel.lock() {
        *slot = None;
    }

    match result {
        Ok(inner) => inner,
        Err(error) => Err(format!("解析タスクが異常終了しました: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn gradient(left: u8, right: u8) -> DynamicImage {
        let mut image = RgbaImage::new(9, 8);
        for (x, _y, pixel) in image.enumerate_pixels_mut() {
            let value = if x < 4 { left } else { right };
            *pixel = Rgba([value, value, value, 255]);
        }
        DynamicImage::ImageRgba8(image)
    }

    #[test]
    fn dhash_is_stable_for_the_same_image() {
        let a = gradient(20, 200);
        let b = gradient(20, 200);
        assert_eq!(dhash(&a), dhash(&b));
        assert_eq!(distance(dhash(&a), dhash(&b)), 0);
    }

    #[test]
    fn dhash_separates_different_layouts() {
        let ramp = |increasing: bool| {
            let mut image = RgbaImage::new(9, 8);
            for (x, _y, pixel) in image.enumerate_pixels_mut() {
                let value = if increasing { x * 28 } else { 255 - x * 28 };
                *pixel = Rgba([value as u8, value as u8, value as u8, 255]);
            }
            DynamicImage::ImageRgba8(image)
        };
        assert_eq!(distance(dhash(&ramp(true)), dhash(&ramp(false))), 64);
    }

    #[test]
    fn cluster_groups_only_within_threshold() {
        let rows = vec![
            HashRow {
                index: 0,
                hash: 0x0000_0000_0000_0000,
                bytes: 100,
                pixels: 100,
                mtime: 1,
            },
            HashRow {
                index: 1,
                hash: 0x0000_0000_0000_0003,
                bytes: 90,
                pixels: 90,
                mtime: 2,
            },
            HashRow {
                index: 2,
                hash: 0xffff_ffff_ffff_ffff,
                bytes: 80,
                pixels: 80,
                mtime: 3,
            },
        ];
        let groups = cluster(&rows, 2);
        assert_eq!(groups, vec![vec![0, 1]]);
    }

    #[test]
    fn cluster_keeps_the_largest_as_representative() {
        let rows = vec![
            HashRow {
                index: 0,
                hash: 0,
                bytes: 10,
                pixels: 10,
                mtime: 1,
            },
            HashRow {
                index: 1,
                hash: 1,
                bytes: 900,
                pixels: 900,
                mtime: 1,
            },
            HashRow {
                index: 2,
                hash: 2,
                bytes: 800,
                pixels: 800,
                mtime: 1,
            },
        ];
        // 距離: 0-1 = 1, 0-2 = 1, 1-2 = 2 → しきい値 1 なら 0 は 1 のグループへ
        let groups = cluster(&rows, 1);
        assert_eq!(groups.len(), 1);
        assert!(groups[0].contains(&1));
        assert!(groups[0].contains(&0));
    }

    fn file(id: i64, width: Option<i64>, height: Option<i64>, bytes: i64, mtime: i64) -> DupFile {
        DupFile {
            id,
            work_id: 1,
            name: format!("{id}.png"),
            rel_path: format!("{id}.png"),
            kind: "image".to_string(),
            bytes,
            width,
            height,
            mtime,
            keeper: false,
        }
    }

    #[test]
    fn keeper_prefers_resolution_then_bytes() {
        let files = vec![
            file(1, Some(1024), Some(1024), 900, 5),
            file(2, Some(2048), Some(2048), 800, 1),
            file(3, Some(1024), Some(1024), 950, 9),
        ];
        assert_eq!(pick_keeper(&files), 1);

        let files = vec![
            file(1, Some(1024), Some(1024), 900, 5),
            file(2, Some(1024), Some(1024), 950, 1),
        ];
        assert_eq!(pick_keeper(&files), 1);
    }

    /// 実ファイルを索引に載せ、解析 → 完全一致 / 類似のグループ化まで通す。
    #[test]
    fn analyze_and_group_end_to_end() {
        use std::fs;
        use tempfile::TempDir;

        let temp = TempDir::new().unwrap();
        let root_dir = temp.path().join("root");
        let work_dir = root_dir.join("w");
        fs::create_dir_all(&work_dir).unwrap();

        let ramp = |increasing: bool| {
            let mut image = RgbaImage::new(64, 64);
            for (x, _y, pixel) in image.enumerate_pixels_mut() {
                let value = if increasing { x * 4 } else { 255 - x * 4 };
                *pixel = Rgba([value as u8, value as u8, value as u8, 255]);
            }
            DynamicImage::ImageRgba8(image)
        };
        let write = |name: &str, image: &DynamicImage| {
            let path = work_dir.join(name);
            image.save(&path).unwrap();
            path
        };
        // 完全一致（同じ内容を 2 回保存）と、方向違い（類似しない）
        let a = write("a.png", &ramp(true));
        let b = work_dir.join("b.png");
        fs::copy(&a, &b).unwrap();
        write("c.png", &ramp(false));

        let conn = db::open_in_memory().unwrap();
        let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
        conn.execute(
            "INSERT INTO works(root_id, rel_path, title, kind, mtime, created_at, updated_at)
             VALUES (?1, 'w', 'w', 'image', 0, 0, 0)",
            [root.id],
        )
        .unwrap();
        let work_id = conn.last_insert_rowid();
        for name in ["a.png", "b.png", "c.png"] {
            let bytes = fs::metadata(work_dir.join(name)).unwrap().len() as i64;
            conn.execute(
                "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime, width, height)
                 VALUES (?1, ?2, ?3, 'image', ?4, 1, 64, 64)",
                params![work_id, format!("w/{name}"), name, bytes],
            )
            .unwrap();
        }

        let conn = Mutex::new(conn);
        let summary = analyze(&conn, 100, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
        assert_eq!(summary.total, 3);
        assert_eq!(summary.hashed, 3);
        assert_eq!(summary.images, 3);
        assert_eq!(summary.remaining, 0);

        let conn = conn.into_inner().unwrap();
        let exact = exact_groups(&conn, 10).unwrap();
        assert_eq!(exact.len(), 1, "a.png と b.png だけが完全一致");
        assert_eq!(exact[0].files.len(), 2);
        assert!(exact[0].files.iter().any(|file| file.keeper));

        // 方向が違う c.png は類似グループに入らない（ハミング距離 64）
        let similar = similar_groups(&conn, 8, 10).unwrap();
        let c_id = c_id(&conn);
        let similar_ids: Vec<i64> = similar
            .iter()
            .flat_map(|group| group.files.iter().map(|file| file.id))
            .collect();
        assert!(!similar_ids.is_empty(), "同一内容の 2 枚が類似として出る");
        assert!(
            !similar_ids.contains(&c_id),
            "c.png は類似グループに入らない"
        );
        assert!(similar.iter().all(|group| group.files.len() >= 2));

        let stats = stats(&conn).unwrap();
        assert_eq!(stats.exact_groups, 1);
        assert_eq!(stats.hashed, 3);
        assert_eq!(stats.pending, 0);
    }

    /// テスト用: `c.png` の id。
    fn c_id(conn: &Connection) -> i64 {
        conn.query_row("SELECT id FROM files WHERE name = 'c.png'", [], |row| {
            row.get(0)
        })
        .unwrap()
    }
}
