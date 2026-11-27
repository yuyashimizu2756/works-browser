//! サムネイル生成（#3）のテスト。
//!
//! - 画像 → 長辺 512px の WebP
//! - mtime / size が変わったら再生成、変わらなければ 0 生成
//! - EXIF の向き
//! - 壊れたファイルはプレースホルダ（アプリは落ちない）
//! - 動画は ffmpeg がある環境だけ（CI には無いのでスキップ）
//! - 作品カバーは「最初の動画 → 最初の画像」

use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use image::{Rgba, RgbaImage};
use rusqlite::Connection;
use tempfile::TempDir;

use super::{
    cache_key, cache_path, cache_usage, clear_cache, generate, pending_count, prune_cache,
    queue_stats, GenerateOptions, ThumbConfig, ThumbSummary,
};
use crate::index::db;
use crate::index::scan::{self, ScanConfig};

struct Fixture {
    dir: TempDir,
    cache: TempDir,
    conn: Mutex<Connection>,
    root_id: i64,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().expect("root tempdir");
        let cache = TempDir::new().expect("cache tempdir");
        let mut conn = db::open_in_memory().expect("db");

        let root = db::add_root(&conn, dir.path().to_str().unwrap(), 1).expect("add root");
        scan_root(&mut conn, root.id);

        Self {
            dir,
            cache,
            conn: Mutex::new(conn),
            root_id: root.id,
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.dir.path().join(relative)
    }

    fn write_image(&self, relative: &str, width: u32, height: u32) {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let image = RgbaImage::from_fn(width, height, |x, y| {
            Rgba([(x % 256) as u8, (y % 256) as u8, 120, 255])
        });
        image.save(&path).expect("save image");
    }

    fn write_bytes(&self, relative: &str, bytes: &[u8]) {
        let path = self.path(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, bytes).unwrap();
    }

    fn scan(&self) {
        let mut conn = self.conn.lock().unwrap();
        scan_root(&mut conn, self.root_id);
    }

    fn config(&self) -> ThumbConfig {
        let (ffmpeg, ffmpeg_source) = super::video::resolve(None);
        ThumbConfig {
            max_edge: 512,
            quality: 75.0,
            parallelism: 2,
            cache_dir: self.cache.path().to_path_buf(),
            ffmpeg,
            ffmpeg_source,
        }
    }

    fn run(&self, limit: usize, force: bool) -> ThumbSummary {
        self.run_visible(true, limit, force)
    }

    fn run_visible(&self, visible: bool, limit: usize, force: bool) -> ThumbSummary {
        let config = self.config();
        generate(
            &self.conn,
            &config,
            visible,
            &AtomicBool::new(false),
            &GenerateOptions { limit, force },
            &mut |_progress| {},
        )
        .expect("generate")
    }

    fn thumb_path_of(&self, name: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT thumb_path FROM files WHERE name = ?1",
            [name],
            |row| row.get(0),
        )
        .expect("thumb_path")
    }

    fn pending(&self) -> u64 {
        pending_count(&self.conn.lock().unwrap()).expect("pending")
    }
}

fn scan_root(conn: &mut Connection, root_id: i64) {
    let root = db::get_root(conn, root_id).unwrap();
    let config = ScanConfig {
        chunk_size: 16,
        progress_interval: std::time::Duration::from_millis(10),
        ..ScanConfig::default()
    };
    scan::scan_root(conn, &root, &AtomicBool::new(false), &config, &mut |_| {}).expect("scan");
}

fn decode(bytes: &[u8]) -> image::RgbaImage {
    image::load_from_memory(bytes)
        .expect("decode webp")
        .to_rgba8()
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

#[test]
fn image_thumbnail_is_512px_webp_and_cached() {
    let fixture = Fixture::new();
    fixture.write_image("作品/big.png", 1024, 768);
    fixture.scan();

    assert_eq!(fixture.pending(), 1);

    let summary = fixture.run(10, false);
    assert_eq!(summary.total, 1);
    assert_eq!(summary.generated, 1);
    assert_eq!(summary.failed, 0);

    let thumb_path = fixture.thumb_path_of("big.png").expect("thumb_path");
    let bytes = fs::read(&thumb_path).expect("thumb file");
    assert!(is_webp(&bytes), "not a webp: {thumb_path}");

    let image = decode(&bytes);
    assert_eq!((image.width(), image.height()), (512, 384));

    // 再起動相当（DB はそのまま、キャッシュもそのまま）→ 0 生成
    assert_eq!(fixture.pending(), 0);
    let second = fixture.run(10, false);
    assert_eq!(second.total, 0);
    assert_eq!(second.generated, 0);
}

#[test]
fn changed_source_is_regenerated() {
    let fixture = Fixture::new();
    fixture.write_image("作品/a.png", 1024, 768);
    fixture.scan();
    fixture.run(10, false);

    let first_path = fixture.thumb_path_of("a.png").unwrap();
    let first = fs::read(&first_path).unwrap();

    // サイズと mtime が変わる
    fixture.write_image("作品/a.png", 300, 600);
    fixture.scan();
    assert_eq!(fixture.pending(), 1, "source change must enqueue");

    let summary = fixture.run(10, false);
    assert_eq!(summary.generated, 1);
    let second = fs::read(&first_path).unwrap();
    assert_ne!(first, second);
    assert_eq!(decode(&second).height(), 512);
}

#[test]
fn missing_cache_file_is_regenerated_after_reset() {
    let fixture = Fixture::new();
    fixture.write_image("作品/a.png", 800, 800);
    fixture.scan();
    fixture.run(10, false);

    let thumb_path = fixture.thumb_path_of("a.png").unwrap();
    fs::remove_file(&thumb_path).unwrap();

    // キャッシュを消しただけでは DB 上は生成済み。reset_thumbs で戻す。
    let reset = super::reset(&fixture.conn.lock().unwrap(), fixture.cache.path(), true).unwrap();
    assert_eq!(reset, 1);
    assert_eq!(fixture.pending(), 1);

    let summary = fixture.run(10, false);
    assert_eq!(summary.total, 1);
    assert_eq!(summary.generated, 1);
    assert!(Path::new(&thumb_path).is_file());
}

#[test]
fn broken_image_falls_back_to_placeholder() {
    let fixture = Fixture::new();
    fixture.write_bytes("作品/broken.png", b"this is not a png");
    fixture.scan();

    let summary = fixture.run(10, false);
    assert_eq!(summary.total, 1);
    assert_eq!(summary.failed, 1);
    assert_eq!(summary.generated, 0);

    let thumb_path = fixture
        .thumb_path_of("broken.png")
        .expect("placeholder path");
    let bytes = fs::read(thumb_path).unwrap();
    assert!(is_webp(&bytes));
    let image = decode(&bytes);
    assert_eq!(image.width(), image.height());
}

#[test]
fn exif_orientation_is_applied() {
    let fixture = Fixture::new();
    // 横長（800x400）だが EXIF の Orientation=6（右に 90 度回す）→ 縦長として扱う
    fixture.write_bytes("作品/rotated.jpg", &jpeg_with_orientation(800, 400, 6));
    fixture.scan();

    let summary = fixture.run(10, false);
    assert_eq!(summary.generated, 1);

    let thumb_path = fixture.thumb_path_of("rotated.jpg").unwrap();
    let image = decode(&fs::read(thumb_path).unwrap());
    assert_eq!(
        (image.width(), image.height()),
        (256, 512),
        "orientation 6 should rotate 800x400 into a portrait thumbnail"
    );
}

#[test]
fn video_frame_via_ffmpeg() {
    let (ffmpeg, _) = super::video::resolve(None);
    let Some(ffmpeg) = ffmpeg else {
        eprintln!("ffmpeg が見つからないため動画テストをスキップします");
        return;
    };

    let fixture = Fixture::new();
    let video_path = fixture.path("作品/clip.avi");
    fs::create_dir_all(video_path.parent().unwrap()).unwrap();

    let status = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x240:rate=10",
            "-t",
            "2",
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "mpeg4",
        ])
        .arg(&video_path)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "could not create the test video");

    fixture.scan();
    let summary = fixture.run(10, false);
    assert_eq!(summary.generated, 1, "video thumbnail should be generated");

    let thumb_path = fixture.thumb_path_of("clip.avi").unwrap();
    let image = decode(&fs::read(thumb_path).unwrap());
    assert!(image.width().max(image.height()) <= 512);

    // 10% 地点を抜けた証拠として、尺が DB に記録されている
    let duration: Option<i64> = fixture
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT duration_ms FROM files WHERE name = 'clip.avi'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        duration.unwrap_or_default() >= 1_500,
        "duration = {duration:?}"
    );
}

#[test]
fn cover_prefers_video_then_image() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
     VALUES ('r', 'r', 'r', 1, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO works(root_id, rel_path, title, kind, mtime, created_at, updated_at)
     VALUES (1, 'w', 'w', 'mixed', 0, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime)
     VALUES (1, 'w/a.png', 'a.png', 'image', 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime)
     VALUES (1, 'w/b.mp4', 'b.mp4', 'video', 1, 0)",
        [],
    )
    .unwrap();

    db::refresh_covers(&conn).unwrap();

    let (_cover_id, cover_name): (i64, String) = conn
        .query_row(
            "SELECT w.cover_file_id, f.name FROM works w
       JOIN files f ON f.id = w.cover_file_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(cover_name, "b.mp4", "video should win over image");

    // 動画を消すと画像にフォールバックする
    conn.execute("DELETE FROM files WHERE name = 'b.mp4'", [])
        .unwrap();
    db::refresh_covers(&conn).unwrap();
    let (cover_id, cover_name): (i64, String) = conn
        .query_row(
            "SELECT w.cover_file_id, f.name FROM works w
       JOIN files f ON f.id = w.cover_file_id",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_ne!(cover_id, 0);
    assert_eq!(cover_name, "a.png");
}

#[test]
fn queue_stats_reports_pending_and_ready() {
    let fixture = Fixture::new();
    fixture.write_image("作品/a.png", 64, 64);
    fixture.write_image("作品/b.png", 64, 64);
    fixture.scan();

    let stats = queue_stats(&fixture.conn.lock().unwrap()).unwrap();
    assert_eq!(stats.total, 2);
    assert_eq!(stats.pending, 2);
    assert_eq!(stats.ready, 0);

    fixture.run(1, false);

    let stats = queue_stats(&fixture.conn.lock().unwrap()).unwrap();
    assert_eq!(stats.ready, 1);
    assert_eq!(stats.pending, 1);
}

#[test]
fn hidden_mode_writes_no_cache_files() {
    // #21 のサムネ非表示: 呼ばれても 1 枚も書かない（キャッシュのファイル数が増えない）
    let fixture = Fixture::new();
    fixture.write_image("作品/a.png", 256, 256);
    fixture.write_image("作品/b.png", 256, 256);
    fixture.scan();

    let before = cache_file_count(fixture.cache.path());
    assert_eq!(before, 0);

    let summary = fixture.run_visible(false, 10, false);
    assert_eq!(summary.total, 0);
    assert_eq!(summary.generated, 0);
    assert_eq!(
        cache_file_count(fixture.cache.path()),
        before,
        "非表示中にサムネイルキャッシュが増えてはいけない"
    );
    assert_eq!(fixture.pending(), 2, "非表示中はキューを消費しない");

    // 表示に戻せば生成できる
    let summary = fixture.run_visible(true, 10, false);
    assert_eq!(summary.generated, 2);
    assert!(cache_file_count(fixture.cache.path()) > before);
}

fn cache_file_count(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| entries.flatten().count())
        .unwrap_or(0)
}

#[test]
fn cache_key_is_per_root_and_path() {
    let a = cache_key(r"D:\root1", r"work\a.png");
    assert_eq!(a, cache_key(r"D:\root1", r"work\a.png"));
    assert_eq!(a.len(), 40);
    assert_ne!(a, cache_key(r"D:\root2", r"work\a.png"));
    assert_ne!(a, cache_key(r"D:\root1", r"work\b.png"));

    let path = cache_path(Path::new(r"D:\cache"), r"D:\root1", r"work\a.png");
    assert_eq!(path.extension().unwrap(), "webp");
    assert_eq!(path.file_stem().unwrap().to_str().unwrap(), a);
}

#[test]
fn cache_usage_and_clear_remove_all_files() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_in_memory().unwrap();
    for (name, bytes) in [("a.webp", 100_u64), ("b.webp", 200), ("c.webp", 300)] {
        fs::write(dir.path().join(name), vec![0_u8; bytes as usize]).unwrap();
    }

    let usage = cache_usage(dir.path(), 1024);
    assert_eq!(usage.files, 3);
    assert_eq!(usage.bytes, 600);
    assert_eq!(usage.limit_bytes, 1024);

    let (removed, freed) = clear_cache(&conn, dir.path()).unwrap();
    assert_eq!((removed, freed), (3, 600));
    assert_eq!(cache_file_count(dir.path()), 0);
    assert_eq!(cache_usage(dir.path(), 1024).bytes, 0);
}

#[test]
fn prune_cache_deletes_oldest_until_under_limit() {
    let dir = TempDir::new().unwrap();
    let conn = db::open_in_memory().unwrap();
    for name in ["oldest.webp", "middle.webp", "newest.webp"] {
        fs::write(dir.path().join(name), vec![0_u8; 100]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // 250 バイトを超えているので 1 件消える（古い順）
    let (removed, freed) = prune_cache(&conn, dir.path(), 250).unwrap();
    assert_eq!(removed, 1);
    assert_eq!(freed, 100);
    assert!(!dir.path().join("oldest.webp").exists());
    assert_eq!(cache_usage(dir.path(), 250).bytes, 200);

    // 上限 0 は無制限。何も消さない。
    assert_eq!(prune_cache(&conn, dir.path(), 0).unwrap(), (0, 0));
    assert_eq!(cache_file_count(dir.path()), 2);
}

#[test]
fn placeholder_is_written_for_unreadable_source_entries() {
    // 索引後にファイルが消えた場合でも、生成側は落ちない（thumb_path は触らない）
    let fixture = Fixture::new();
    fixture.write_image("作品/gone.png", 128, 128);
    fixture.scan();
    fs::remove_file(fixture.path("作品/gone.png")).unwrap();

    let summary = fixture.run(10, false);
    assert_eq!(summary.failed, 1);
    assert_eq!(summary.generated, 0);
    assert_eq!(fixture.pending(), 1, "missing source stays queued");
}

// ---------------------------------------------------------------------------
// EXIF 付き JPEG の組み立て（テスト用）
// ---------------------------------------------------------------------------

fn jpeg_with_orientation(width: u32, height: u32, orientation: u16) -> Vec<u8> {
    let image = RgbaImage::from_fn(width, height, |x, _| Rgba([(x % 256) as u8, 40, 90, 255]));
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut jpeg), 90)
        .encode_image(&image)
        .expect("encode jpeg");

    // APP1 (Exif) を作る。TIFF はリトルエンディアン、IFD は 1 エントリ（Orientation）。
    let mut payload = Vec::new();
    payload.extend(b"Exif\0\0");
    payload.extend(b"II\x2a\x00"); // II + 42
    payload.extend(8u32.to_le_bytes()); // 最初の IFD までのオフセット
    payload.extend(1u16.to_le_bytes()); // エントリ数
    payload.extend(0x0112u16.to_le_bytes()); // Orientation
    payload.extend(3u16.to_le_bytes()); // SHORT
    payload.extend(1u32.to_le_bytes()); // 個数
    payload.extend(orientation.to_le_bytes()); // 値（先頭 2 バイト）
    payload.extend([0u8, 0u8]);
    payload.extend(0u32.to_le_bytes()); // 次の IFD なし

    let mut segment = Vec::new();
    segment.extend([0xFF, 0xE1]);
    segment.extend(((payload.len() + 2) as u16).to_be_bytes());
    segment.extend(&payload);

    let mut out = Vec::new();
    out.extend(&jpeg[..2]); // SOI の直後に挿す
    out.extend(&segment);
    out.extend(&jpeg[2..]);
    out
}
