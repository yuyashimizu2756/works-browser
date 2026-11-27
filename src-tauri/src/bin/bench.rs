//! 性能計測用 CLI（Issue #10）。
//!
//! GUI を起動せずに、PLAN.md の非機能目標のうちヘッドレスで測れるものだけを実測する。
//!
//! ```text
//! bench scan   <path>    [--depth N] [--repeat N] [--db PATH] [--json] [--quiet]
//! bench thumbs <root_id> [--limit N] [--force] [--cache DIR] [--db PATH]
//!                        [--parallelism N] [--json] [--quiet]
//! bench query            [--rows N] [--repeat N] [--db PATH] [--json] [--quiet]
//! ```
//!
//! - `--db` を必ず専用ファイルにする（既定は `%TEMP%\works-browser-bench`）。
//!   本体の `%APPDATA%\works-browser\index.db` は触らない。
//! - 実データは読み取りのみ。書き込むのは `--db` と `--cache` の下だけ。
//! - 進捗は stderr、結果（`--json` なら JSON）は stdout。40,000 ファイルの
//!   走査でもタイムアウトしないよう、1 秒間隔で進捗を出す。
//! - ピーク RSS は `GetProcessMemoryInfo`（psapi）で取る。追加クレートは無し。

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use works_browser_lib::index::db::{self, FileFilter, WorkFilter};
use works_browser_lib::index::scan::{self, ScanConfig};
use works_browser_lib::thumbs::{self, GenerateOptions, ThumbConfig};

type BenchResult<T> = Result<T, Box<dyn Error>>;

/// 走査 1 パスの結果。
struct ScanRun {
    pass: usize,
    elapsed_ms: u64,
    summary: scan::ScanSummary,
}

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match Options::parse(&raw) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}");
            eprintln!("\n{}", help_text());
            return ExitCode::FAILURE;
        }
    };

    if parsed.command.is_empty() || parsed.switch("help") {
        println!("{}", help_text());
        return ExitCode::SUCCESS;
    }

    let outcome = match parsed.command.as_str() {
        "scan" => run_scan(&parsed),
        "thumbs" => run_thumbs(&parsed),
        "query" => run_query(&parsed),
        other => Err(format!("未知のコマンドです: {other}").into()),
    };

    match outcome {
        Ok(payload) => {
            if parsed.switch("json") {
                match serde_json::to_string_pretty(&payload) {
                    Ok(text) => println!("{text}"),
                    Err(error) => {
                        eprintln!("JSON を作れませんでした: {error}");
                        return ExitCode::FAILURE;
                    }
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("[bench] 失敗: {error}");
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------
// CLI 引数
// ---------------------------------------------------------------------------

/// 値を 1 つ取るオプション。
const VALUE_OPTIONS: &[&str] = &[
    "depth",
    "repeat",
    "db",
    "limit",
    "cache",
    "parallelism",
    "rows",
];

/// 真偽値のオプション。
const SWITCH_OPTIONS: &[&str] = &["json", "quiet", "force", "help"];

struct Options {
    command: String,
    positional: Vec<String>,
    values: HashMap<String, String>,
    switches: HashSet<String>,
}

impl Options {
    fn parse(raw: &[String]) -> Result<Self, String> {
        let mut options = Self {
            command: String::new(),
            positional: Vec::new(),
            values: HashMap::new(),
            switches: HashSet::new(),
        };

        let mut index = 0;
        while index < raw.len() {
            let arg = &raw[index];
            index += 1;

            if let Some(body) = arg.strip_prefix("--") {
                let (name, inline) = match body.split_once('=') {
                    Some((name, value)) => (name, Some(value.to_string())),
                    None => (body, None),
                };
                if SWITCH_OPTIONS.contains(&name) {
                    options.switches.insert(name.to_string());
                    continue;
                }
                if !VALUE_OPTIONS.contains(&name) {
                    return Err(format!("未知のオプションです: --{name}"));
                }
                let value = match inline {
                    Some(value) => value,
                    None => {
                        let value = raw
                            .get(index)
                            .filter(|value| !value.starts_with("--"))
                            .ok_or_else(|| format!("--{name} には値が必要です"))?;
                        index += 1;
                        value.clone()
                    }
                };
                options.values.insert(name.to_string(), value);
                continue;
            }

            if options.command.is_empty() {
                options.command = arg.clone();
            } else {
                options.positional.push(arg.clone());
            }
        }

        Ok(options)
    }

    fn value(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    fn switch(&self, key: &str) -> bool {
        self.switches.contains(key)
    }

    fn number(&self, key: &str, default: i64) -> BenchResult<i64> {
        match self.value(key) {
            Some(raw) => raw
                .trim()
                .parse::<i64>()
                .map_err(|_| format!("--{key} は整数で指定してください（指定値: {raw}）").into()),
            None => Ok(default),
        }
    }

    fn number_usize(&self, key: &str, default: usize) -> BenchResult<usize> {
        let value = self.number(key, default as i64)?;
        usize::try_from(value).map_err(|_| format!("--{key} が大きすぎます: {value}").into())
    }

    /// 計測用 DB。既定は `%TEMP%\works-browser-bench\<name>`。
    fn db_path(&self, name: &str) -> PathBuf {
        match self.value("db") {
            Some(path) => PathBuf::from(path),
            None => bench_dir().join(name),
        }
    }

    fn quiet(&self) -> bool {
        self.switch("quiet")
    }
}

fn help_text() -> &'static str {
    "works-browser 性能計測 CLI（Issue #10）\n\
     \n\
     bench scan   <path>    [--depth N] [--repeat N] [--db PATH] [--json] [--quiet]\n\
     bench thumbs <root_id> [--limit N] [--force] [--cache DIR] [--db PATH]\n\
                            [--parallelism N] [--json] [--quiet]\n\
     bench query            [--rows N] [--repeat N] [--db PATH] [--json] [--quiet]\n\
     \n\
     GUI は起動しません。実データは読み取り専用で、書き込みは --db / --cache のみ。\n\
     既定の DB: %TEMP%\\works-browser-bench\\index.db"
}

fn bench_dir() -> PathBuf {
    std::env::temp_dir().join("works-browser-bench")
}

// ---------------------------------------------------------------------------
// メモリ（Windows: GetProcessMemoryInfo）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct Memory {
    working_set: u64,
    peak_working_set: u64,
}

impl Memory {
    fn sample(&mut self) {
        let now = memory_now();
        self.working_set = self.working_set.max(now.working_set);
        self.peak_working_set = self.peak_working_set.max(now.peak_working_set);
    }
}

#[cfg(windows)]
fn memory_now() -> Memory {
    use std::mem::{size_of, MaybeUninit};

    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters = MaybeUninit::<PROCESS_MEMORY_COUNTERS>::zeroed();
    // SAFETY: 現在のプロセスのハンドルと、サイズを渡した書き込み可能な領域。
    let ok = unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            counters.as_mut_ptr(),
            size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
    };
    if ok == 0 {
        return Memory::default();
    }
    // SAFETY: 呼び出しが成功したので初期化済み。
    let counters = unsafe { counters.assume_init() };
    Memory {
        working_set: counters.WorkingSetSize as u64,
        peak_working_set: counters.PeakWorkingSetSize as u64,
    }
}

#[cfg(not(windows))]
fn memory_now() -> Memory {
    Memory::default()
}

// ---------------------------------------------------------------------------
// 表示用ヘルパ
// ---------------------------------------------------------------------------

fn comma(value: i64) -> String {
    let negative = value < 0;
    let mut digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    while digits.len() > 3 {
        let split = digits.len() - 3;
        out = format!(",{}{out}", &digits[split..]);
        digits.truncate(split);
    }
    let text = format!("{digits}{out}");
    if negative {
        format!("-{text}")
    } else {
        text
    }
}

fn human_bytes(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn rate(count: u64, elapsed: Duration) -> f64 {
    if elapsed.is_zero() {
        0.0
    } else {
        count as f64 / elapsed.as_secs_f64()
    }
}

/// 人間向けの結果。`--json` のときは stdout を JSON 専用にするため stderr へ出す。
fn report(options: &Options, text: impl AsRef<str>) {
    if options.switch("json") {
        eprintln!("{}", text.as_ref());
    } else {
        println!("{}", text.as_ref());
    }
}

fn db_file_bytes(path: &Path) -> u64 {
    let base = path.display().to_string();
    ["", "-wal", "-shm"]
        .iter()
        .filter_map(|suffix| fs::metadata(format!("{base}{suffix}")).ok())
        .map(|meta| meta.len())
        .sum()
}

fn remove_db_files(path: &Path) {
    let base = path.display().to_string();
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(format!("{base}{suffix}"));
    }
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

fn run_scan(options: &Options) -> BenchResult<Value> {
    let path = options
        .positional
        .first()
        .ok_or("走査するパスを指定してください（bench scan <path>）")?
        .clone();
    let depth = options.number("depth", 1)?;
    let repeat = options.number("repeat", 1)?.max(1);
    let db_path = options.db_path("index.db");

    let mut conn = db::open(&db_path)?;
    let root = db::add_root(&conn, &path, depth)?;
    if !options.quiet() {
        eprintln!(
            "[bench] scan path={} depth={depth} root_id={} db={}",
            root.path,
            root.id,
            db_path.display()
        );
    }

    let cancel = AtomicBool::new(false);
    let config = ScanConfig::default();
    let mut runs: Vec<ScanRun> = Vec::new();
    let mut overall = Memory::default();
    overall.sample();

    for pass in 1..=repeat as usize {
        let started = Instant::now();
        let mut last_report = Instant::now();
        let mut progress_memory = Memory::default();
        let summary = scan::scan_root(&mut conn, &root, &cancel, &config, &mut |progress| {
            progress_memory.sample();
            if !options.quiet() && last_report.elapsed() >= Duration::from_secs(1) {
                last_report = Instant::now();
                eprintln!(
                    "[scan] {} pass {pass}: {} ファイル / {:.1}s",
                    root.label,
                    comma(progress.files as i64),
                    started.elapsed().as_secs_f64()
                );
            }
        })?;
        overall.sample();
        overall.working_set = overall.working_set.max(progress_memory.working_set);
        overall.peak_working_set = overall
            .peak_working_set
            .max(progress_memory.peak_working_set);
        runs.push(ScanRun {
            pass,
            elapsed_ms: started.elapsed().as_millis() as u64,
            summary,
        });
    }

    let (files, works, roots, scan_runs): (i64, i64, i64, i64) = conn.query_row(
        "SELECT (SELECT COUNT(*) FROM files), (SELECT COUNT(*) FROM works),
                (SELECT COUNT(*) FROM roots), (SELECT COUNT(*) FROM scan_runs)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let db_bytes = db_file_bytes(&db_path);

    if !options.quiet() {
        for run in &runs {
            let seconds = run.elapsed_ms as f64 / 1000.0;
            let label = if run.pass == 1 {
                "初回"
            } else {
                "再走査(差分)"
            };
            report(
                options,
                format!(
                    "  pass {} {label:<10} files={} works={} {} / {:.2}s = {} files/s",
                    run.pass,
                    comma(run.summary.files as i64),
                    comma(run.summary.works as i64),
                    human_bytes(run.summary.total_bytes),
                    seconds,
                    comma(rate(run.summary.files, Duration::from_millis(run.elapsed_ms)) as i64),
                ),
            );
            report(
                options,
                format!(
                    "         added={} updated={} removed={} unchanged={} duplicates={} ({})",
                    comma(run.summary.added as i64),
                    comma(run.summary.updated as i64),
                    comma(run.summary.removed as i64),
                    comma(run.summary.unchanged as i64),
                    comma(run.summary.duplicates as i64),
                    run.summary.status,
                ),
            );
        }
        report(
            options,
            format!(
                "  ピーク RSS {:.1} MB / DB files={} works={} roots={} runs={} {:.1} MB",
                mb(overall.peak_working_set),
                comma(files),
                comma(works),
                comma(roots),
                comma(scan_runs),
                mb(db_bytes),
            ),
        );
    }

    let runs_json: Vec<Value> = runs
        .iter()
        .map(|run| {
            json!({
                "pass": run.pass,
                "label": if run.pass == 1 { "first" } else { "rescan" },
                "status": run.summary.status,
                "elapsed_ms": run.elapsed_ms,
                "files": run.summary.files,
                "works": run.summary.works,
                "total_bytes": run.summary.total_bytes,
                "added": run.summary.added,
                "updated": run.summary.updated,
                "removed": run.summary.removed,
                "unchanged": run.summary.unchanged,
                "duplicates": run.summary.duplicates,
                "files_per_sec": rate(
                    run.summary.files,
                    Duration::from_millis(run.elapsed_ms)
                ),
            })
        })
        .collect();

    Ok(json!({
        "command": "scan",
        "path": path,
        "depth": depth,
        "root_id": root.id,
        "db": db_path.display().to_string(),
        "runs": runs_json,
        "peak_working_set_bytes": overall.peak_working_set,
        "db_rows": {
            "files": files,
            "works": works,
            "roots": roots,
            "scan_runs": scan_runs,
        },
        "db_bytes": db_bytes,
    }))
}

// ---------------------------------------------------------------------------
// thumbs
// ---------------------------------------------------------------------------

/// `thumbs::PENDING_FILTER` と同じ条件（非公開なので計測用に写している）。
const PENDING_FILTER: &str = "f.thumb_path IS NULL
   OR f.thumb_mtime IS NULL OR f.thumb_mtime <> f.mtime
   OR f.thumb_bytes IS NULL OR f.thumb_bytes <> f.bytes";

/// サムネイル未生成の件数を種別ごとに数える。
fn pending_by_kind(conn: &Connection, root_id: i64) -> BenchResult<(i64, i64, i64)> {
    let sql = format!(
        "SELECT f.kind, COUNT(*) FROM files f
         JOIN works w ON w.id = f.work_id
         WHERE w.root_id = ?1 AND ({PENDING_FILTER})
         GROUP BY f.kind"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([root_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut images = 0;
    let mut videos = 0;
    let mut other = 0;
    for row in rows {
        let (kind, count) = row?;
        match kind.as_str() {
            "image" => images += count,
            "video" => videos += count,
            _ => other += count,
        }
    }
    Ok((images, videos, other))
}

fn run_thumbs(options: &Options) -> BenchResult<Value> {
    let root_id = options
        .positional
        .first()
        .ok_or("root_id を指定してください（bench thumbs <root_id>）")?
        .parse::<i64>()
        .map_err(|_| "root_id は整数で指定してください")?;
    let limit = options.number_usize("limit", 1_000)?.max(1);
    let db_path = options.db_path("index.db");

    let conn = db::open(&db_path)?;
    let root = db::get_root(&conn, root_id)?;
    let mut config = ThumbConfig::load(&conn)?;
    if let Some(cache) = options.value("cache") {
        config.cache_dir = PathBuf::from(cache);
    }
    if let Some(parallelism) = options.value("parallelism") {
        let parsed = parallelism.parse::<usize>().map_err(|_| {
            format!("--parallelism は整数で指定してください（指定値: {parallelism}）")
        })?;
        config.parallelism = parsed.clamp(1, thumbs::MAX_PARALLELISM);
    }

    let pending_all = thumbs::pending_count(&conn)?;
    let (images, videos, other) = pending_by_kind(&conn, root_id)?;
    if !options.quiet() {
        eprintln!(
            "[bench] thumbs root={} ({}) 未生成 images={} videos={} other={} limit={} parallel={} cache={}",
            root.id,
            root.path,
            comma(images),
            comma(videos),
            comma(other),
            comma(limit as i64),
            config.parallelism,
            config.cache_dir.display(),
        );
    }

    let force = options.switch("force");
    let shared = Mutex::new(conn);
    let cancel = AtomicBool::new(false);
    let mut memory = Memory::default();
    memory.sample();
    let started = Instant::now();
    let mut last_report = Instant::now();

    let summary = thumbs::generate(
        &shared,
        &config,
        true,
        &cancel,
        &GenerateOptions { limit, force },
        &mut |progress| {
            memory.sample();
            if !options.quiet() && last_report.elapsed() >= Duration::from_secs(1) {
                last_report = Instant::now();
                let elapsed = started.elapsed();
                eprintln!(
                    "[thumbs] {}/{} {:.1}s = {:.1} 枚/s",
                    comma(progress.done as i64),
                    comma(progress.total as i64),
                    elapsed.as_secs_f64(),
                    rate(progress.done, elapsed),
                );
            }
        },
    )?;
    let elapsed = started.elapsed();
    memory.sample();

    let thumbs_per_sec = rate(summary.generated, elapsed);
    if !options.quiet() {
        report(
            options,
            format!(
                "  生成 {} / 対象 {} / 失敗 {} / {:.2}s = {:.1} 枚/s",
                comma(summary.generated as i64),
                comma(summary.total as i64),
                comma(summary.failed as i64),
                elapsed.as_secs_f64(),
                thumbs_per_sec,
            ),
        );
        report(
            options,
            format!(
                "  内訳 images={} videos={} other={}（未生成の件数）/ 全体の未生成 {}",
                comma(images),
                comma(videos),
                comma(other),
                comma(pending_all as i64),
            ),
        );
        report(
            options,
            format!(
                "  ピーク RSS {:.1} MB / cache={}",
                mb(memory.peak_working_set),
                config.cache_dir.display(),
            ),
        );
    }

    Ok(json!({
        "command": "thumbs",
        "root_id": root.id,
        "root_path": root.path,
        "db": db_path.display().to_string(),
        "limit": limit,
        "force": force,
        "pending_by_kind": {
            "image": images,
            "video": videos,
            "other": other,
            "all_roots": pending_all,
        },
        "total": summary.total,
        "generated": summary.generated,
        "failed": summary.failed,
        "cancelled": summary.cancelled,
        "elapsed_ms": summary.elapsed_ms,
        "thumbs_per_sec": thumbs_per_sec,
        "peak_working_set_bytes": memory.peak_working_set,
        "settings": {
            "max_edge": config.max_edge,
            "quality": config.quality,
            "parallelism": config.parallelism,
            "cache_dir": config.cache_dir.display().to_string(),
            "ffmpeg": config.ffmpeg.as_deref().map(|path| path.display().to_string()),
            "ffmpeg_source": config.ffmpeg_source,
        },
    }))
}

// ---------------------------------------------------------------------------
// query（10 万行の合成 DB）
// ---------------------------------------------------------------------------

fn run_query(options: &Options) -> BenchResult<Value> {
    let rows = options.number("rows", 100_000)?.max(1);
    let repeat = options.number_usize("repeat", 5)?.max(1);
    let db_path = options.db_path("synthetic.db");

    remove_db_files(&db_path);
    let mut conn = db::open(&db_path)?;

    let works = (rows / 20).max(1);
    let build_started = Instant::now();
    seed(&mut conn, rows, works)?;
    let build_ms = build_started.elapsed().as_millis() as u64;
    let db_bytes = db_file_bytes(&db_path);

    if !options.quiet() {
        eprintln!(
            "[bench] query rows={} works={} db={} 構築 {:.2}s / {:.1} MB",
            comma(rows),
            comma(works),
            db_path.display(),
            build_ms as f64 / 1000.0,
            mb(db_bytes),
        );
    }

    let mut memory = Memory::default();
    memory.sample();

    let work_page = |sort: &'static str, search: Option<&'static str>| {
        let conn = &conn;
        move || -> BenchResult<usize> {
            let page = db::find_works(
                conn,
                &WorkFilter {
                    search: search.map(str::to_string),
                    sort: sort.to_string(),
                    limit: 50,
                    ..WorkFilter::default()
                },
            )?;
            Ok(page.works.len())
        }
    };
    let file_page = |sort: &'static str, limit: i64, offset: i64, search: Option<&'static str>| {
        let conn = &conn;
        move || -> BenchResult<usize> {
            let page = db::find_files(
                conn,
                &FileFilter {
                    search: search.map(str::to_string),
                    sort: sort.to_string(),
                    limit,
                    offset,
                    ..FileFilter::default()
                },
            )?;
            Ok(page.files.len())
        }
    };
    let file_page_after = |sort: &'static str, limit: i64, after_id: i64| {
        let conn = &conn;
        move || -> BenchResult<usize> {
            let page = db::find_files(
                conn,
                &FileFilter {
                    sort: sort.to_string(),
                    limit,
                    after_id: Some(after_id),
                    ..FileFilter::default()
                },
            )?;
            Ok(page.files.len())
        }
    };
    let work_page_after = |sort: &'static str, limit: i64, after_id: i64| {
        let conn = &conn;
        move || -> BenchResult<usize> {
            let page = db::find_works(
                conn,
                &WorkFilter {
                    sort: sort.to_string(),
                    limit,
                    after_id: Some(after_id),
                    ..WorkFilter::default()
                },
            )?;
            Ok(page.works.len())
        }
    };

    // #50: キーセット・ページング用の「深い位置のカーソル」を先に求める。
    // OFFSET の計測と違い、ここで求めた id から先を読む時間だけを測る。
    let deep_rows = (rows * 5 / 8).clamp(0, rows - 1);
    let deep_file_id: Option<i64> = conn
        .query_row(
            "SELECT f.id FROM files f JOIN works w ON w.id = f.work_id
             WHERE w.root_id IN (SELECT id FROM roots WHERE enabled = 1)
             ORDER BY f.mtime DESC, f.id DESC LIMIT 1 OFFSET ?1",
            [deep_rows],
            |row| row.get(0),
        )
        .optional()?;
    let deep_work_rows = (works * 5 / 8).clamp(0, works - 1);
    let deep_work_id: Option<i64> = conn
        .query_row(
            "SELECT w.id FROM works w
             WHERE w.file_count > 0 AND w.root_id IN (SELECT id FROM roots WHERE enabled = 1)
             ORDER BY w.mtime DESC, w.id DESC LIMIT 1 OFFSET ?1",
            [deep_work_rows],
            |row| row.get(0),
        )
        .optional()?;

    let mut timings: Vec<Timing> = Vec::new();
    timings.push(measure("list_works(mtime, 50)", repeat, {
        let conn = &conn;
        move || Ok(db::list_works(conn, 50, 0, "mtime")?.len())
    })?);
    timings.push(measure("list_works(title, 50)", repeat, {
        let conn = &conn;
        move || Ok(db::list_works(conn, 50, 0, "title")?.len())
    })?);
    timings.push(measure("list_works(size, 50)", repeat, {
        let conn = &conn;
        move || Ok(db::list_works(conn, 50, 0, "size")?.len())
    })?);
    timings.push(measure(
        "list_files(mtime, 600)",
        repeat,
        file_page("mtime", 600, 0, None),
    )?);
    timings.push(measure(
        "list_files(name, 600)",
        repeat,
        file_page("name", 600, 0, None),
    )?);
    timings.push(measure(
        "list_files(mtime, 600, offset 62,400)",
        repeat,
        file_page("mtime", 600, 62_400, None),
    )?);
    if let Some(after_id) = deep_file_id {
        timings.push(measure(
            &format!("list_files(mtime, 600, after_id @{})", comma(deep_rows)),
            repeat,
            file_page_after("mtime", 600, after_id),
        )?);
    }
    if let Some(after_id) = deep_work_id {
        timings.push(measure(
            &format!("find_works(mtime, 50, after_id @{})", comma(deep_work_rows)),
            repeat,
            work_page_after("mtime", 50, after_id),
        )?);
    }
    timings.push(measure(
        "find_works(default, 50)",
        repeat,
        work_page("mtime", None),
    )?);
    timings.push(measure(
        "find_works(search \"series04\", 50)",
        repeat,
        work_page("mtime", Some("series04")),
    )?);
    timings.push(measure(
        "find_files(default, 600)",
        repeat,
        file_page("mtime", 600, 0, None),
    )?);
    timings.push(measure(
        "find_files(search \"000042\", 600)",
        repeat,
        file_page("mtime", 600, 0, Some("000042")),
    )?);
    timings.push(measure("library_stats", repeat, {
        let conn = &conn;
        move || Ok(db::library_stats(conn)?.files as usize)
    })?);

    memory.sample();

    if !options.quiet() {
        for timing in &timings {
            report(
                options,
                format!(
                    "  {:<38} cold {:>6.2} / 中央値 {:>6.2} ms (min {:.2} / max {:.2})",
                    timing.label,
                    timing.cold_ms,
                    timing.median(),
                    timing.min(),
                    timing.max(),
                ),
            );
        }
        report(
            options,
            format!(
                "  ピーク RSS {:.1} MB / DB {:.1} MB",
                mb(memory.peak_working_set),
                mb(db_bytes),
            ),
        );
    }

    Ok(json!({
        "command": "query",
        "rows": rows,
        "works": works,
        "db": db_path.display().to_string(),
        "build_ms": build_ms,
        "db_bytes": db_bytes,
        "peak_working_set_bytes": memory.peak_working_set,
        "timings": timings.iter().map(Timing::to_json).collect::<Vec<_>>(),
    }))
}

/// 合成 DB を作る。`scan` の集計と同じ形（file_count / total_bytes / cover）まで整える。
fn seed(conn: &mut Connection, rows: i64, works: i64) -> BenchResult<()> {
    let now = db::now_ms();
    let transaction = conn.transaction()?;

    transaction.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES (?1, ?1, 'bench', 1, 1, ?2)",
        params![r"D:\bench\synthetic", now],
    )?;
    let root_id = transaction.last_insert_rowid();

    {
        let mut insert_work = transaction.prepare(
            "INSERT INTO works(root_id, rel_path, title, kind, cover_file_id, file_count, total_bytes,
                               mtime, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'image', NULL, 0, 0, ?4, ?4, ?4)",
        )?;
        for index in 0..works {
            let rel = format!("series{index:05}");
            let mtime = now - index * 1_000;
            insert_work.execute(params![root_id, rel, rel, mtime])?;
        }
    }

    {
        let mut insert_file = transaction.prepare(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, width, height, duration_ms, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for index in 0..rows {
            // 空の DB に works を 1 から連番で入れているので id は index + 1
            let work = (index % works) + 1;
            let work_rel = format!("series{:05}", index % works);
            let is_video = index % 25 == 0;
            let (kind, ext) = if is_video {
                ("video", "mp4")
            } else {
                ("image", "jpg")
            };
            let name = format!("{work_rel}_{index:06}.{ext}");
            let rel = format!("{work_rel}\\{name}");
            let bytes = 120_000 + (index % 977) * 3_000;
            let mtime = now - (index % 10_000) * 60_000;
            let (width, height, duration) = if is_video {
                (1_920, 1_080, Some(8_000 + index % 30_000))
            } else {
                (1_024, 1_536, None)
            };
            insert_file.execute(params![
                work, rel, name, kind, bytes, width, height, duration, mtime
            ])?;
        }
    }

    transaction.commit()?;

    conn.execute_batch(
        "UPDATE works SET
           file_count = (SELECT COUNT(*) FROM files WHERE files.work_id = works.id),
           total_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM files WHERE files.work_id = works.id),
           mtime = (SELECT COALESCE(MAX(mtime), works.mtime) FROM files WHERE files.work_id = works.id),
           kind = CASE
             WHEN EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'image')
              AND EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'video') THEN 'mixed'
             WHEN EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'video') THEN 'video'
             ELSE 'image'
           END",
    )?;
    db::refresh_covers(conn)?;
    Ok(())
}

struct Timing {
    label: String,
    cold_ms: f64,
    samples: Vec<f64>,
}

impl Timing {
    fn median(&self) -> f64 {
        if self.samples.is_empty() {
            return 0.0;
        }
        let mut sorted = self.samples.clone();
        sorted.sort_by(f64::total_cmp);
        sorted[sorted.len() / 2]
    }

    fn min(&self) -> f64 {
        self.samples.iter().copied().fold(f64::MAX, f64::min)
    }

    fn max(&self) -> f64 {
        self.samples.iter().copied().fold(0.0, f64::max)
    }

    fn to_json(&self) -> Value {
        json!({
            "label": self.label,
            "cold_ms": self.cold_ms,
            "median_ms": self.median(),
            "min_ms": self.min(),
            "max_ms": self.max(),
            "samples": self.samples,
        })
    }
}

/// 1 回目（コールド）と `repeat` 回分（中央値用）を測る。
fn measure<F>(label: &str, repeat: usize, mut run: F) -> BenchResult<Timing>
where
    F: FnMut() -> BenchResult<usize>,
{
    let started = Instant::now();
    let cold = run()?;
    std::hint::black_box(cold);
    let cold_ms = started.elapsed().as_secs_f64() * 1000.0;

    let mut samples = Vec::with_capacity(repeat);
    for _ in 0..repeat {
        let started = Instant::now();
        let rows = run()?;
        std::hint::black_box(rows);
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    Ok(Timing {
        label: label.to_string(),
        cold_ms,
        samples,
    })
}
