//! 実データで走査を試すための小さな CLI。
//!
//! ```powershell
//! cd src-tauri
//! cargo run --release --example scan -- D:\ComfyUI\output 1
//! ```
//!
//! DB はアプリと同じ場所（開発時は `<repo>/.cache/index.db`）。
//! `WORKS_BROWSER_DB` で差し替えられる。

use std::sync::atomic::AtomicBool;

use works_browser_lib::index::{
    db,
    scan::{self, ScanConfig},
};

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: scan <path> [depth]");
        std::process::exit(2);
    };
    let depth = args
        .next()
        .map(|value| {
            value
                .parse::<i64>()
                .expect("depth は整数で指定してください")
        })
        .unwrap_or(1);

    let db_path = db::default_db_path();
    let mut conn = db::open(&db_path).expect("索引 DB を開けませんでした");
    let root = db::add_root(&conn, &path, depth).expect("ルートを登録できませんでした");

    println!("db      : {}", db_path.display());
    println!(
        "root    : {} (id={}, depth={})",
        root.path, root.id, root.depth
    );

    let cancel = AtomicBool::new(false);
    let mut last_phase = String::new();
    let summary = scan::scan_root(
        &mut conn,
        &root,
        &cancel,
        &ScanConfig::default(),
        &mut |progress| {
            if progress.phase != last_phase || progress.files % 5_000 == 0 {
                last_phase = progress.phase.clone();
                eprintln!(
                    "  {}: {} files / {} works",
                    progress.phase, progress.files, progress.works
                );
            }
        },
    )
    .expect("走査に失敗しました");

    println!("status  : {}", summary.status);
    println!(
        "files   : {} / works: {} / bytes: {}",
        summary.files, summary.works, summary.total_bytes
    );
    println!(
        "added   : {} / updated: {} / removed: {} / unchanged: {} / duplicates: {}",
        summary.added, summary.updated, summary.removed, summary.unchanged, summary.duplicates
    );
    println!("duration: {} ms", summary.duration_ms);
    if let Some(duplicate_of) = summary.duplicate_of {
        println!("duplicate of root #{duplicate_of}");
    }
}
