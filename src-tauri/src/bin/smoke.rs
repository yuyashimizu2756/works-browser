//! 起動スモークテスト（#32）。
//!
//! `cargo run --bin smoke -- --json` で、**ウィンドウを出さずに**
//! 一時 DB の初期化 → サンプルフォルダの走査 → 作品 / ファイル件数の集計までを通す。
//! `tauri::Builder` は起動しないので、CI（Windows headless）でも安全に実行できる。
//!
//! 終了コード:
//! - 0 … 初期化・走査・集計がすべて成功し、件数が期待どおり
//! - 1 … 失敗（原因は stderr）

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use works_browser_lib::index::{db, scan};

/// スモークで作る作品数 / ファイル数（サンプルは固定）。
const EXPECTED_WORKS: i64 = 2;
const EXPECTED_FILES: i64 = 3;

#[derive(Serialize)]
struct SmokeOutput {
    ok: bool,
    db: String,
    root: String,
    summary: scan::ScanSummary,
    stats: db::LibraryStats,
}

fn main() {
    let json = std::env::args().any(|arg| arg == "--json");
    match run(json) {
        Ok(()) => {}
        Err(error) => {
            eprintln!("smoke failed: {error}");
            std::process::exit(1);
        }
    }
}

fn run(json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let workspace = unique_temp_dir()?;
    fs::create_dir_all(&workspace)?;
    // 後片付けは成功・失敗どちらでも行う（DB を閉じてから消す）
    let result = smoke_in(&workspace, json);
    let _ = fs::remove_dir_all(&workspace);
    result
}

fn smoke_in(workspace: &Path, json: bool) -> Result<(), Box<dyn std::error::Error>> {
    let db_path = workspace.join("index.db");
    let root_dir = workspace.join("library");

    // 2 作品 / 3 ファイル（うち 1 つは動画）。中身は走査では読まない。
    write_fixture(&root_dir.join("work-a").join("cover.png"), b"smoke png")?;
    write_fixture(&root_dir.join("work-a").join("extra.jpg"), b"smoke jpg")?;
    write_fixture(&root_dir.join("work-b").join("clip.mp4"), b"smoke mp4")?;
    // 索引対象外の拡張子は無視されることも確認する
    write_fixture(&root_dir.join("work-b").join("notes.txt"), b"ignored")?;
    // `.ts` は既定で索引しない（TypeScript。MPEG-TS は設定で有効化。#39）
    write_fixture(&root_dir.join("work-b").join("index.ts"), b"ignored")?;

    let mut conn = db::open(&db_path)?;
    let root = db::add_root(&conn, root_dir.to_string_lossy().as_ref(), 1)?;

    let cancel = AtomicBool::new(false);
    let summary = scan::scan_root(
        &mut conn,
        &root,
        &cancel,
        &scan::ScanConfig::default(),
        &mut |_| {},
    )?;
    let stats = db::library_stats(&conn)?;

    if summary.files != EXPECTED_FILES as u64 || stats.works != EXPECTED_WORKS {
        return Err(format!(
            "unexpected index: summary.files={} stats.works={} (expected files={} works={})",
            summary.files, stats.works, EXPECTED_FILES, EXPECTED_WORKS
        )
        .into());
    }

    if json {
        let output = SmokeOutput {
            ok: true,
            db: db_path.to_string_lossy().into_owned(),
            root: root.real_path.clone(),
            summary,
            stats,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
    } else {
        println!("smoke: ok");
        println!("db:      {}", db_path.display());
        println!("root:    {}", root.real_path);
        println!(
            "scan:    status={} files={} works={} added={} bytes={}",
            summary.status, summary.files, summary.works, summary.added, summary.total_bytes
        );
        println!(
            "stats:   roots={} works={} files={} bytes={}",
            stats.roots, stats.works, stats.files, stats.total_bytes
        );
    }

    Ok(())
}

fn write_fixture(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)
}

/// プロセス ID と時刻から衝突しない一時ディレクトリ名を作る。
fn unique_temp_dir() -> std::io::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(std::env::temp_dir().join(format!(
        "works-browser-smoke-{}-{nanos}",
        std::process::id()
    )))
}
