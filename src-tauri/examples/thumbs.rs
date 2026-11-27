//! 実データでサムネイル生成を測るための小さな CLI。
//!
//! ```powershell
//! # 実データ（動画込み）を走査 → サムネイル生成 → 2 回目でキャッシュヒットを確認
//! $env:WORKS_BROWSER_DB="D:\Temp\Blender\thumbs-bench\index.db"
//! $env:WORKS_BROWSER_THUMBS_DIR="D:\Temp\Blender\thumbs-bench\thumbs"
//! cd src-tauri
//! cargo run --release --example thumbs -- D:\ComfyUI\output 1 2000
//!
//! # 1,000 枚相当の画像を合成して測る
//! cargo run --release --example thumbs -- --synth 1000
//! ```
//!
//! DB は `WORKS_BROWSER_DB`（未設定ならアプリと同じ場所）、キャッシュは
//! `WORKS_BROWSER_THUMBS_DIR`（未設定なら `%LOCALAPPDATA%\works-browser\thumbs`）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use std::time::Instant;

use image::RgbImage;
use works_browser_lib::index::{
    db,
    scan::{self, ScanConfig},
};
use works_browser_lib::thumbs::{self, GenerateOptions, ThumbConfig};

fn main() {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("--synth") {
        args.remove(0);
        synth(args);
        return;
    }

    let Some(path) = args.first().cloned() else {
        eprintln!("usage: thumbs <path> [depth] [limit]");
        eprintln!("       thumbs --synth <count> [dir]");
        std::process::exit(2);
    };
    let depth = args.get(1).map(|value| parse(value, "depth")).unwrap_or(1);
    let limit = args
        .get(2)
        .map(|value| parse(value, "limit"))
        .unwrap_or(2000);

    bench(Path::new(&path), depth, limit);
}

fn parse(value: &str, name: &str) -> i64 {
    value
        .parse()
        .unwrap_or_else(|_| panic!("{name} は整数で指定してください: {value}"))
}

/// 1,000 枚の合成画像を作って `bench` を回す。
fn synth(args: Vec<String>) {
    let count = args
        .first()
        .map(|value| parse(value, "count") as u32)
        .unwrap_or(1_000);
    let dir = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"D:\Temp\Blender\works-browser-synth"));

    fs::create_dir_all(&dir).expect("合成画像のディレクトリを作れませんでした");
    println!("synth   : {} 枚 → {}", count, dir.display());

    for index in 0..count {
        let path = dir.join(format!("img_{index:05}.jpg"));
        if path.is_file() {
            continue;
        }
        // 実データに近い 1024x1024 の JPEG
        let image = RgbImage::from_fn(1024, 1024, |x, y| {
            image::Rgb([
                ((x * 7 + index) % 256) as u8,
                ((y * 5 + index * 3) % 256) as u8,
                ((x + y) % 256) as u8,
            ])
        });
        image.save(&path).expect("合成画像を保存できませんでした");
    }

    bench(&dir, 0, count as i64);
}

fn bench(path: &Path, depth: i64, limit: i64) {
    let db_path = db::default_db_path();
    let mut conn = db::open(&db_path).expect("索引 DB を開けませんでした");
    let root =
        db::add_root(&conn, &path.to_string_lossy(), depth).expect("ルートを登録できませんでした");

    println!("db      : {}", db_path.display());
    println!(
        "root    : {} (id={}, depth={})",
        root.path, root.id, root.depth
    );

    let scanned = Instant::now();
    let summary = scan::scan_root(
        &mut conn,
        &root,
        &AtomicBool::new(false),
        &ScanConfig::default(),
        &mut |_| {},
    )
    .expect("走査に失敗しました");
    println!(
        "scan    : {} files / {} works in {} ms",
        summary.files,
        summary.works,
        scanned.elapsed().as_millis()
    );

    let config = ThumbConfig::load(&conn).expect("設定を読めませんでした");
    let cache_dir = config.cache_dir.clone();
    println!(
        "config  : max_edge={} quality={} parallel={} ffmpeg={} ({})",
        config.max_edge,
        config.quality,
        config.parallelism,
        config
            .ffmpeg
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "none".to_string()),
        config.ffmpeg_source
    );
    println!("cache   : {}", cache_dir.display());

    let (images, videos) = counts(&conn).expect("件数を数えられませんでした");
    println!("queue   : images={images} videos={videos}");

    let shared = Mutex::new(conn);
    let run = |options: &GenerateOptions| {
        let mut last = 0_u64;
        let started = Instant::now();
        let result = thumbs::generate(
            &shared,
            &config,
            true,
            &AtomicBool::new(false),
            options,
            &mut |progress| {
                if progress.total >= 200
                    && (progress.done == progress.total
                        || progress.done - last >= progress.total / 10)
                {
                    last = progress.done;
                    eprintln!("  {}/{}", progress.done, progress.total);
                }
            },
        )
        .expect("生成に失敗しました");
        (result, started.elapsed().as_millis())
    };

    let (first, elapsed) = run(&GenerateOptions {
        limit: limit.max(1) as usize,
        force: false,
    });
    println!(
        "run 1   : total={} generated={} failed={} cancelled={} in {} ms",
        first.total, first.generated, first.failed, first.cancelled, elapsed
    );
    if first.generated > 0 {
        println!(
            "rate    : {:.1} 枚/秒 / {:.2} ms/枚 / 1,000 枚換算 {:.1} 秒",
            first.generated as f64 * 1000.0 / elapsed as f64,
            elapsed as f64 / first.generated as f64,
            elapsed as f64 / first.generated as f64
        );
    }

    let (second, elapsed) = run(&GenerateOptions {
        limit: limit.max(1) as usize,
        force: false,
    });
    println!(
        "run 2   : total={} generated={} failed={} in {} ms（再起動相当・キャッシュヒット）",
        second.total, second.generated, second.failed, elapsed
    );

    let stats = {
        let conn = shared.lock().expect("db lock");
        thumbs::queue_stats(&conn).expect("stats")
    };
    println!(
        "final   : pending={} ready={}/{}",
        stats.pending, stats.ready, stats.total
    );
}

fn counts(conn: &rusqlite::Connection) -> Result<(i64, i64), rusqlite::Error> {
    conn.query_row(
        "SELECT
       (SELECT COUNT(*) FROM files WHERE kind = 'image'),
       (SELECT COUNT(*) FROM files WHERE kind = 'video')",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}
