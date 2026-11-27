//! サムネイル生成とキャッシュ（Issue #3）。
//!
//! - 画像: [`photo`] … `image` で長辺 `max_edge`（既定 512px）に縮小し、`webp` で品質 75
//! - 動画: [`video`] … ffmpeg で 10% 地点のフレームを 1 枚抜き出し、画像と同じ経路で WebP 化
//! - キャッシュ: `%LOCALAPPDATA%\works-browser\thumbs\<sha1>.webp`
//!
//! 生成は rayon の専用プール（既定: CPU コア数 - 2 並列）で行い、進捗は `thumbs://progress`
//! （done / total）で流す。設計メモは `docs/thumb-design.md` を参照。

pub mod photo;
pub mod serve;
pub mod video;

#[cfg(test)]
mod tests;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::index::db;
use crate::index::IndexError;

/// 長辺の既定値（px）。
pub const DEFAULT_MAX_EDGE: u32 = 512;
/// WebP の既定品質。
pub const DEFAULT_QUALITY: f32 = 75.0;
/// 既定の並列数（CPU コア数 - 2、最低 1）。
///
/// #50: 8 固定 → CPU コア数 - 2。ffmpeg に `-threads 1` を付けたので、
/// 1 プロセス 1 コアで動かし、プロセス数を増やす方が動画サムネイルが速い。
pub fn default_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .saturating_sub(2)
        .clamp(1, MAX_PARALLELISM)
}

/// 並列数の上限（ffmpeg をこれ以上同時に走らせても速くならない）。
pub const MAX_PARALLELISM: usize = 32;
/// 設定で許す長辺の範囲。
pub const MAX_EDGE_RANGE: std::ops::RangeInclusive<u32> = 64..=1024;

/// ffmpeg の既定候補（PLAN.md / Issue #3）。
pub const FFMPEG_FALLBACK: &str = r"D:\Projects\08_media_tools\media-tools\bin\ffmpeg.exe";

/// 動画フレームを抜く位置（duration に対する割合）。
const VIDEO_OFFSET_RATIO: f64 = 0.10;
/// 10% 地点で失敗したときの再試行位置（秒）。
const VIDEO_FALLBACK_SECS: f64 = 1.0;

// 設定は `meta` テーブルに保存する（#8 の設定画面は config.json を正とし、
// ここへも同じ値を同期する）。
pub const META_FFMPEG: &str = "thumbs.ffmpeg_path";
const META_MAX_EDGE: &str = "thumbs.max_edge";
const META_QUALITY: &str = "thumbs.quality";
const META_PARALLELISM: &str = "thumbs.parallelism";

/// サムネイル生成まわりのエラー。
#[derive(Debug, thiserror::Error)]
pub enum ThumbError {
    #[error("{path} を読み取れません: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("画像を変換できません: {0}")]
    Image(#[from] image::ImageError),

    #[error("I/O エラー: {0}")]
    IoRaw(#[from] std::io::Error),

    #[error("データベースエラー: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("ffmpeg が見つかりません（設定 → 同梱 sidecar → PATH → {FFMPEG_FALLBACK} の順で探しました）")]
    FfmpegNotFound,

    #[error("ffmpeg の実行に失敗しました: {0}")]
    Ffmpeg(String),

    #[error("動画からフレームを取得できません: {0}")]
    VideoFrame(String),

    #[error("索引のエラー: {0}")]
    Index(#[from] IndexError),

    #[error("スレッドプールを作れません: {0}")]
    Pool(String),

    #[error("サムネイル状態のロックに失敗しました")]
    Lock,
}

impl ThumbError {
    pub fn io(path: &Path, source: std::io::Error) -> Self {
        Self::Io {
            path: db::display_path(path),
            source,
        }
    }
}

/// 生成に使う実効設定。
#[derive(Debug, Clone)]
pub struct ThumbConfig {
    /// 長辺の上限（px）。
    pub max_edge: u32,
    /// WebP の品質（0–100）。
    pub quality: f32,
    /// 同時に走らせるスレッド数。
    pub parallelism: usize,
    /// キャッシュ先ディレクトリ。
    pub cache_dir: PathBuf,
    /// 解決済みの ffmpeg。
    pub ffmpeg: Option<PathBuf>,
    /// ffmpeg をどこから拾ったか（`setting` / `sidecar` / `path` / `fallback` / `none`）。
    pub ffmpeg_source: &'static str,
}

impl ThumbConfig {
    /// DB の設定（`meta`）と環境変数から実効設定を作る。
    ///
    /// 環境変数はテスト・ベンチマーク用の上書き：
    /// - `WORKS_BROWSER_THUMBS_DIR` … キャッシュ先
    /// - `WORKS_BROWSER_FFMPEG` … ffmpeg のパス
    pub fn load(conn: &Connection) -> Result<Self, ThumbError> {
        let max_edge = meta_u32(conn, META_MAX_EDGE)?
            .unwrap_or(DEFAULT_MAX_EDGE)
            .clamp(*MAX_EDGE_RANGE.start(), *MAX_EDGE_RANGE.end());
        let quality = meta_f32(conn, META_QUALITY)?
            .unwrap_or(DEFAULT_QUALITY)
            .clamp(1.0, 100.0);
        let parallelism = meta_u32(conn, META_PARALLELISM)?
            .map(|value| value as usize)
            .unwrap_or_else(default_parallelism)
            .clamp(1, MAX_PARALLELISM);

        let configured = match env_string("WORKS_BROWSER_FFMPEG") {
            Some(path) => Some(path),
            None => db::get_meta(conn, META_FFMPEG)?,
        };
        let (ffmpeg, ffmpeg_source) = video::resolve(configured.as_deref());

        Ok(Self {
            max_edge,
            quality,
            parallelism,
            cache_dir: default_cache_dir(),
            ffmpeg,
            ffmpeg_source,
        })
    }

    /// UI に返す用の設定スナップショット。
    pub fn settings(&self) -> ThumbSettings {
        ThumbSettings {
            max_edge: self.max_edge,
            quality: self.quality,
            parallelism: self.parallelism,
            cache_dir: db::display_path(&self.cache_dir),
            ffmpeg: self.ffmpeg.as_deref().map(db::display_path),
            ffmpeg_source: self.ffmpeg_source.to_string(),
        }
    }
}

/// `thumb_settings` コマンドの戻り値。
#[derive(Debug, Clone, Serialize)]
pub struct ThumbSettings {
    pub max_edge: u32,
    pub quality: f32,
    pub parallelism: usize,
    pub cache_dir: String,
    pub ffmpeg: Option<String>,
    pub ffmpeg_source: String,
}

/// キャッシュ先。`%LOCALAPPDATA%\works-browser\thumbs`。
pub fn default_cache_dir() -> PathBuf {
    if let Some(custom) = env_string("WORKS_BROWSER_THUMBS_DIR") {
        return PathBuf::from(custom);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("works-browser").join("thumbs")
}

fn env_string(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn meta_u32(conn: &Connection, key: &str) -> Result<Option<u32>, ThumbError> {
    Ok(db::get_meta(conn, key)?.and_then(|value| value.trim().parse::<u32>().ok()))
}

fn meta_f32(conn: &Connection, key: &str) -> Result<Option<f32>, ThumbError> {
    Ok(db::get_meta(conn, key)?.and_then(|value| value.trim().parse::<f32>().ok()))
}

/// サムネイルのキャッシュキー。
///
/// 仕様は `<sha1(rel_path)>` だが、別ルートに同じ `rel_path` があると衝突して
/// 別の作品の絵が出るため、ルートの実体パスも混ぜる（ルートを移すと作り直しになる）。
pub fn cache_key(root_real_path: &str, rel_path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(root_real_path.as_bytes());
    hasher.update(b"\0");
    hasher.update(rel_path.as_bytes());
    let digest = hasher.finalize();

    use std::fmt::Write as _;
    let mut out = String::with_capacity(40);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// キャッシュのフルパス。
pub fn cache_path(cache_dir: &Path, root_real_path: &str, rel_path: &str) -> PathBuf {
    cache_dir.join(format!("{}.webp", cache_key(root_real_path, rel_path)))
}

/// 一時ファイルに書いてから rename する（生成中に落ちても壊れた WebP を残さない）。
pub fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), ThumbError> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| ThumbError::io(parent, error))?;
    }

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "thumb.webp".to_string());
    let temp = target.with_file_name(format!(".{file_name}.{}.{counter}.tmp", std::process::id()));

    if let Err(error) = fs::write(&temp, bytes) {
        let _ = fs::remove_file(&temp);
        return Err(ThumbError::io(&temp, error));
    }

    // Windows の `rename` は既存ファイルを置き換えられない
    if target.exists() {
        let _ = fs::remove_file(target);
    }
    if let Err(error) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(ThumbError::io(target, error));
    }
    Ok(())
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 未生成（または元ファイルが変わった）サムネイルの条件。
const PENDING_FILTER: &str = "f.thumb_path IS NULL
   OR f.thumb_mtime IS NULL OR f.thumb_mtime <> f.mtime
   OR f.thumb_bytes IS NULL OR f.thumb_bytes <> f.bytes";

/// 生成対象 1 件。
#[derive(Debug, Clone)]
pub struct PendingThumb {
    pub file_id: i64,
    pub kind: String,
    /// ルートからの相対パス（`files.rel_path`）。
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub bytes: i64,
    pub mtime: i64,
    pub duration_ms: Option<i64>,
    pub root_real_path: String,
}

const JOB_COLUMNS: &str = "f.id, f.kind, f.rel_path, f.bytes, f.mtime, f.duration_ms, r.real_path";

fn pending_limit(limit: usize) -> i64 {
    limit.max(1).min(i64::MAX as usize) as i64
}

fn query_jobs(
    conn: &Connection,
    limit: usize,
    force: bool,
) -> Result<Vec<PendingThumb>, ThumbError> {
    let filter = if force { "1 = 1" } else { PENDING_FILTER };
    let sql = format!(
        "SELECT {JOB_COLUMNS}
     FROM files f
     JOIN works w ON w.id = f.work_id
     JOIN roots r ON r.id = w.root_id
     WHERE r.enabled = 1 AND ({filter})
     ORDER BY w.mtime DESC, f.id
     LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([pending_limit(limit)], |row| {
        let (id, kind, rel_path, bytes, mtime, duration_ms, root_real_path) = (
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, String>(6)?,
        );
        let abs_path = PathBuf::from(&root_real_path).join(&rel_path);
        Ok(PendingThumb {
            file_id: id,
            kind,
            rel_path,
            abs_path,
            bytes,
            mtime,
            duration_ms,
            root_real_path,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 生成待ちの件数。
pub fn pending_count(conn: &Connection) -> Result<u64, ThumbError> {
    let sql = format!(
        "SELECT COUNT(*)
     FROM files f
     JOIN works w ON w.id = f.work_id
     JOIN roots r ON r.id = w.root_id
     WHERE r.enabled = 1 AND ({PENDING_FILTER})"
    );
    let count: i64 = conn.query_row(&sql, [], |row| row.get(0))?;
    Ok(count.max(0) as u64)
}

/// キュー全体の状態（UI の「残り N 枚」用）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct ThumbQueueStats {
    /// まだ生成していない（または元ファイルが変わった）件数。
    pub pending: u64,
    /// サムネイルが用意できている件数。
    pub ready: u64,
    /// 索引済みの画像・動画の合計。
    pub total: u64,
}

/// キューの状態を数える。
pub fn queue_stats(conn: &Connection) -> Result<ThumbQueueStats, ThumbError> {
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM files f
     JOIN works w ON w.id = f.work_id
     JOIN roots r ON r.id = w.root_id
     WHERE r.enabled = 1",
        [],
        |row| row.get(0),
    )?;
    let ready: i64 = conn.query_row(
        "SELECT COUNT(*) FROM files f
     JOIN works w ON w.id = f.work_id
     JOIN roots r ON r.id = w.root_id
     WHERE r.enabled = 1 AND f.thumb_path IS NOT NULL",
        [],
        |row| row.get(0),
    )?;
    Ok(ThumbQueueStats {
        pending: pending_count(conn)?,
        ready: ready.max(0) as u64,
        total: total.max(0) as u64,
    })
}

/// `generate_thumbs` のオプション。
#[derive(Debug, Clone)]
pub struct GenerateOptions {
    /// この回で処理する最大件数。
    pub limit: usize,
    /// キャッシュがあっても作り直す。
    pub force: bool,
}

/// 1 回の生成結果。
#[derive(Debug, Clone, Default, Serialize)]
pub struct ThumbSummary {
    /// 対象件数（limit 適用後）。キャッシュ済みはそもそも対象にならないので 0。
    pub total: u64,
    /// 実際に書き出した枚数。
    pub generated: u64,
    /// 生成に失敗してプレースホルダを書いた枚数。
    pub failed: u64,
    /// キャンセルされたか。
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

/// 進捗イベント `thumbs://progress` のペイロード。
#[derive(Debug, Clone, Serialize)]
pub struct ThumbProgress {
    pub done: u64,
    pub total: u64,
}

/// 未生成のサムネイルを並列に生成する。
///
/// `conn` は DB 更新用に共有する（生成そのものはロックの外で行う）。
/// `progress` はチャンク（並列数 × 2 件）ごとに呼ばれる。
///
/// `visible` が false（#21 のサムネ非表示）のときは **1 枚も生成せず**、
/// キャッシュにも書き込まない。設定の読み直しを待たずに呼ばれても、
/// `%LOCALAPPDATA%\works-browser\thumbs` が増えないことをここで保証する。
pub fn generate(
    conn: &Mutex<Connection>,
    config: &ThumbConfig,
    visible: bool,
    cancel: &AtomicBool,
    options: &GenerateOptions,
    progress: &mut (dyn FnMut(ThumbProgress) + Send),
) -> Result<ThumbSummary, ThumbError> {
    let started = Instant::now();
    if !visible {
        return Ok(ThumbSummary::default());
    }
    let jobs = {
        let guard = conn.lock().map_err(|_| ThumbError::Lock)?;
        query_jobs(&guard, options.limit, options.force)?
    };

    let total = jobs.len() as u64;
    if jobs.is_empty() {
        return Ok(ThumbSummary {
            elapsed_ms: started.elapsed().as_millis() as u64,
            ..ThumbSummary::default()
        });
    }

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(config.parallelism.max(1))
        .thread_name(|index| format!("thumb-{index}"))
        .build()
        .map_err(|error| ThumbError::Pool(error.to_string()))?;

    let placeholder = photo::placeholder(config.max_edge, config.quality)?;
    let mut summary = ThumbSummary {
        total,
        ..ThumbSummary::default()
    };
    let mut done = 0_u64;
    let chunk_size = (config.parallelism.max(1) * 2).max(1);

    for chunk in jobs.chunks(chunk_size) {
        if cancel.load(Ordering::SeqCst) {
            summary.cancelled = true;
            break;
        }

        let results: Vec<Processed> = pool.install(|| {
            chunk
                .par_iter()
                .map(|job| process_job(job, config, &placeholder))
                .collect()
        });

        for (job, processed) in chunk.iter().zip(results) {
            match processed.outcome {
                Outcome::Generated => summary.generated += 1,
                Outcome::Failed => summary.failed += 1,
            }
            if let Some(thumb_path) = processed.thumb_path {
                let guard = conn.lock().map_err(|_| ThumbError::Lock)?;
                record(&guard, job, &thumb_path, processed.duration_ms)?;
            }
        }

        done += chunk.len() as u64;
        progress(ThumbProgress { done, total });
    }

    summary.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(summary)
}

/// 1 件の生成結果。
struct Processed {
    outcome: Outcome,
    thumb_path: Option<PathBuf>,
    duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Generated,
    Failed,
}

fn process_job(job: &PendingThumb, config: &ThumbConfig, placeholder: &[u8]) -> Processed {
    let target = cache_path(&config.cache_dir, &job.root_real_path, &job.rel_path);

    if !job.abs_path.is_file() {
        return Processed {
            outcome: Outcome::Failed,
            thumb_path: None,
            duration_ms: None,
        };
    }

    let mut duration_ms = None;
    let rendered = match job.kind.as_str() {
        "image" => photo::thumbnail(&job.abs_path, config.max_edge, config.quality),
        "video" => match config.ffmpeg.as_deref() {
            Some(ffmpeg) => {
                let (result, probed) = video::thumbnail(
                    ffmpeg,
                    &job.abs_path,
                    job.duration_ms,
                    config.max_edge,
                    config.quality,
                    &config.cache_dir,
                );
                duration_ms = probed;
                result
            }
            None => Err(ThumbError::FfmpegNotFound),
        },
        other => Err(ThumbError::VideoFrame(format!("未対応の種別です: {other}"))),
    };

    let (bytes, outcome) = match rendered {
        Ok(bytes) => (bytes, Outcome::Generated),
        Err(error) => {
            eprintln!(
                "サムネイル生成に失敗したためプレースホルダを使います ({}): {error}",
                db::display_path(&job.abs_path)
            );
            (placeholder.to_vec(), Outcome::Failed)
        }
    };

    match write_atomic(&target, &bytes) {
        Ok(()) => Processed {
            outcome,
            thumb_path: Some(target),
            duration_ms,
        },
        Err(error) => {
            eprintln!(
                "サムネイルを保存できませんでした ({}): {error}",
                db::display_path(&target)
            );
            Processed {
                outcome: Outcome::Failed,
                thumb_path: None,
                duration_ms,
            }
        }
    }
}

/// 生成結果を `files` に書き戻す。
fn record(
    conn: &Connection,
    job: &PendingThumb,
    thumb_path: &Path,
    duration_ms: Option<i64>,
) -> Result<(), ThumbError> {
    let thumb_path = db::display_path(thumb_path);
    conn.execute(
        "UPDATE files SET thumb_path = ?2, thumb_mtime = ?3, thumb_bytes = ?4,
       duration_ms = COALESCE(?5, duration_ms)
     WHERE id = ?1",
        params![job.file_id, thumb_path, job.mtime, job.bytes, duration_ms],
    )?;
    Ok(())
}

/// サムネイルのキャッシュ状態を捨てる（`delete_files` ならディスク上のファイルも消す）。
///
/// キャッシュフォルダを手で消した場合や、品質を変えて作り直したいときに使う。
pub fn reset(conn: &Connection, cache_dir: &Path, delete_files: bool) -> Result<u64, ThumbError> {
    if delete_files {
        let mut stmt = conn.prepare("SELECT thumb_path FROM files WHERE thumb_path IS NOT NULL")?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for path in paths {
            let path = PathBuf::from(path);
            // キャッシュ先の外は消さない（DB が壊れていても他のファイルを巻き込まない）
            if path.starts_with(cache_dir) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    conn.execute(
        "UPDATE files SET thumb_path = NULL, thumb_mtime = NULL, thumb_bytes = NULL
     WHERE thumb_path IS NOT NULL",
        [],
    )?;
    Ok(conn.changes())
}

/// キャッシュの使用量（#8 の設定画面）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct CacheUsage {
    /// キャッシュ先ディレクトリ。
    pub path: String,
    /// 合計バイト数。
    pub bytes: u64,
    /// ファイル数。
    pub files: u64,
    /// 設定上の上限（0 は無制限）。
    pub limit_bytes: u64,
}

/// キャッシュ先のファイルを列挙する（サブディレクトリは見ない）。
fn cache_entries(cache_dir: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            Some((path, meta.len(), modified))
        })
        .collect()
}

/// キャッシュの使用量を数える。
pub fn cache_usage(cache_dir: &Path, limit_bytes: u64) -> CacheUsage {
    let entries = cache_entries(cache_dir);
    CacheUsage {
        path: db::display_path(cache_dir),
        bytes: entries.iter().map(|(_, bytes, _)| *bytes).sum(),
        files: entries.len() as u64,
        limit_bytes,
    }
}

/// キャッシュを空にし、DB のサムネイル参照も消す（#8 の「キャッシュ削除」）。
///
/// 次回の `generate_thumbs` で全件作り直しになる。返り値は (削除ファイル数, 解放バイト数)。
pub fn clear_cache(conn: &Connection, cache_dir: &Path) -> Result<(u64, u64), ThumbError> {
    let entries = cache_entries(cache_dir);
    let mut removed = 0_u64;
    let mut freed = 0_u64;
    for (path, bytes, _) in entries {
        if fs::remove_file(&path).is_ok() {
            removed += 1;
            freed += bytes;
        }
    }
    conn.execute(
        "UPDATE files SET thumb_path = NULL, thumb_mtime = NULL, thumb_bytes = NULL
     WHERE thumb_path IS NOT NULL",
        [],
    )?;
    Ok((removed, freed))
}

/// 上限を超えたキャッシュを古い順に削除する（#8 のキャッシュ上限）。
///
/// `limit_bytes = 0` は無制限。削除したファイルの DB 参照も外す。
/// 返り値は (削除ファイル数, 解放バイト数)。
pub fn prune_cache(
    conn: &Connection,
    cache_dir: &Path,
    limit_bytes: u64,
) -> Result<(u64, u64), ThumbError> {
    if limit_bytes == 0 {
        return Ok((0, 0));
    }
    let mut entries = cache_entries(cache_dir);
    let mut total: u64 = entries.iter().map(|(_, bytes, _)| *bytes).sum();
    if total <= limit_bytes {
        return Ok((0, 0));
    }

    // 古い順（同時刻ならパス順）に消す。今見ているサムネイルが消えることはあるが、
    // 次に必要になったときに再生成される。
    entries.sort_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)));
    let mut removed = 0_u64;
    let mut freed = 0_u64;
    let mut clear = conn.prepare(
        "UPDATE files SET thumb_path = NULL, thumb_mtime = NULL, thumb_bytes = NULL
     WHERE thumb_path = ?1",
    )?;
    for (path, bytes, _) in entries {
        if total <= limit_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(bytes);
            removed += 1;
            freed += bytes;
            clear.execute([db::display_path(&path)])?;
        }
    }
    Ok((removed, freed))
}

/// `thumb_settings` の更新内容（すべて任意）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ThumbSettingsUpdate {
    pub max_edge: Option<u32>,
    pub quality: Option<f32>,
    pub parallelism: Option<usize>,
    /// 空文字なら既定探索（PATH → fallback）に戻す。
    pub ffmpeg_path: Option<String>,
}

/// 設定を `meta` に保存する。範囲外の値は丸める。
pub fn update_settings(
    conn: &Connection,
    update: &ThumbSettingsUpdate,
) -> Result<ThumbSettings, ThumbError> {
    if let Some(max_edge) = update.max_edge {
        let value = max_edge.clamp(*MAX_EDGE_RANGE.start(), *MAX_EDGE_RANGE.end());
        db::set_meta(conn, META_MAX_EDGE, &value.to_string())?;
    }
    if let Some(quality) = update.quality {
        if quality.is_finite() {
            let value = quality.clamp(1.0, 100.0);
            db::set_meta(conn, META_QUALITY, &format!("{value:.0}"))?;
        }
    }
    if let Some(parallelism) = update.parallelism {
        let value = parallelism.clamp(1, MAX_PARALLELISM);
        db::set_meta(conn, META_PARALLELISM, &value.to_string())?;
    }
    if let Some(path) = &update.ffmpeg_path {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            db::remove_meta(conn, META_FFMPEG)?;
        } else {
            db::set_meta(conn, META_FFMPEG, trimmed)?;
        }
    }

    Ok(ThumbConfig::load(conn)?.settings())
}
