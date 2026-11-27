//! `docs/scan-design.md` 9 章のテスト。
//!
//! - 深さ 1 / 2 / 0 の作品分割
//! - 同一実体（ハードリンク）の重複判定
//! - 削除の反映
//! - 再走査が差分のみになること

use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use rusqlite::{params, Connection};
use tempfile::TempDir;

use super::db;
use super::scan::{self, ScanConfig, ScanSummary};

fn write_file(root: &Path, relative: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, b"dummy").unwrap();
}

fn scan(conn: &mut Connection, root: &db::Root) -> ScanSummary {
    scan_with_cancel(conn, root, &AtomicBool::new(false))
}

fn scan_with_cancel(conn: &mut Connection, root: &db::Root, cancel: &AtomicBool) -> ScanSummary {
    let config = ScanConfig {
        chunk_size: 7,
        progress_interval: Duration::from_millis(10),
        ..ScanConfig::default()
    };
    let mut progress_events = 0_u32;
    let summary = scan::scan_root(conn, root, cancel, &config, &mut |_progress| {
        progress_events += 1;
    })
    .expect("scan failed");
    // 少なくとも最初のチャンクで 1 回は進捗が流れる
    if summary.status == "done" {
        assert!(progress_events >= 1, "progress event was not emitted");
    }
    summary
}

fn work_titles(conn: &Connection, root_id: i64) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT title FROM works WHERE root_id = ?1 ORDER BY title")
        .unwrap();
    let titles = stmt
        .query_map([root_id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    titles
}

#[test]
fn depth_one_splits_by_first_level_directory() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/001.jpg");
    write_file(root_dir, "work_a/002.png");
    write_file(root_dir, "work_b/003.mp4");
    // ルート直下のバラ置きはルート自身の作品にまとめる（件数を落とさない）
    write_file(root_dir, "loose.mp4");
    // 索引対象外・除外ディレクトリは載らない
    write_file(root_dir, "work_a/notes.txt");
    write_file(root_dir, ".hidden/004.jpg");
    write_file(root_dir, "work_a/node_modules/005.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let summary = scan(&mut conn, &root);

    assert_eq!(summary.status, "done");
    assert_eq!(summary.files, 4);
    assert_eq!(summary.works, 3);
    assert_eq!(summary.added, 4);
    assert_eq!(summary.duplicates, 0);

    let titles = work_titles(&conn, root.id);
    assert!(titles.contains(&"work_a".to_string()));
    assert!(titles.contains(&"work_b".to_string()));
    assert!(
        titles.contains(&root.label),
        "root-level files get their own work"
    );
}

#[test]
fn depth_two_splits_by_second_level_directory() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/scene_1/001.jpg");
    write_file(root_dir, "work_a/scene_1/002.jpg");
    write_file(root_dir, "work_a/scene_2/003.png");
    write_file(root_dir, "work_b/scene_1/004.mp4");
    // 2 階層目より浅いファイルは、存在する階層（ここでは work_a）の作品に入る
    write_file(root_dir, "work_a/loose.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 2).unwrap();
    let summary = scan(&mut conn, &root);

    assert_eq!(summary.files, 5);
    assert_eq!(summary.works, 4);
    assert_eq!(
        work_titles(&conn, root.id),
        vec!["scene_1", "scene_1", "scene_2", "work_a"]
    );
}

#[test]
fn depth_zero_indexes_only_root_level_files() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "a.jpg");
    write_file(root_dir, "b.mp4");
    write_file(root_dir, "nested/c.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 0).unwrap();
    let summary = scan(&mut conn, &root);

    assert_eq!(summary.files, 2);
    assert_eq!(summary.works, 1);
    assert_eq!(work_titles(&conn, root.id).len(), 1);
}

#[test]
fn hard_linked_files_are_counted_as_duplicates() {
    let temp = TempDir::new().unwrap();
    let first = temp.path().join("first");
    let second = temp.path().join("second");
    for index in 0..3 {
        let relative = format!("work/00{index}.jpg");
        write_file(&first, &relative);
        let target = second.join(&relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        // コピーではなくハードリンク = 同一実体
        fs::hard_link(first.join(&relative), &target).unwrap();
    }

    let mut conn = db::open_in_memory().unwrap();
    let first_root = db::add_root(&conn, first.to_str().unwrap(), 1).unwrap();
    let first_summary = scan(&mut conn, &first_root);
    assert_eq!(first_summary.files, 3);

    let second_root = db::add_root(&conn, second.to_str().unwrap(), 1).unwrap();
    let second_summary = scan(&mut conn, &second_root);

    assert_eq!(second_summary.duplicates, 3);
    assert_eq!(second_summary.added, 0);
    assert_eq!(second_summary.files, 0);
    assert_eq!(second_summary.works, 0);

    let updated_root = db::get_root(&conn, second_root.id).unwrap();
    assert_eq!(updated_root.duplicate_of, Some(first_root.id));
    assert_eq!(second_summary.duplicate_of, Some(first_root.id));

    // 先に登録した側の索引は残る
    assert_eq!(db::library_stats(&conn).unwrap().files, 3);

    // 重複と分かっているルートの再走査は省略される
    let skipped = scan(&mut conn, &updated_root);
    assert_eq!(skipped.status, "duplicate");
    assert_eq!(skipped.files, 0);
    assert_eq!(skipped.duplicate_of, Some(first_root.id));
}

#[test]
fn rescan_is_incremental_and_reflects_deletions() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/001.jpg");
    write_file(root_dir, "work_a/002.jpg");
    write_file(root_dir, "work_b/003.mp4");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let first = scan(&mut conn, &root);
    assert_eq!((first.files, first.works), (3, 2));

    // 変更なしの再走査は書き込みが発生しない
    let second = scan(&mut conn, &root);
    assert_eq!(second.added, 0);
    assert_eq!(second.updated, 0);
    assert_eq!(second.removed, 0);
    assert_eq!(second.unchanged, 3);
    assert_eq!((second.files, second.works), (3, 2));

    // ファイル削除 + 作品フォルダごと削除
    fs::remove_file(root_dir.join("work_a/002.jpg")).unwrap();
    fs::remove_dir_all(root_dir.join("work_b")).unwrap();

    let third = scan(&mut conn, &root);
    assert_eq!(third.removed, 2);
    assert_eq!((third.files, third.works), (1, 1));
    assert_eq!(work_titles(&conn, root.id), vec!["work_a"]);

    let stats = db::library_stats(&conn).unwrap();
    assert_eq!(stats.works, 1);
    assert_eq!(stats.files, 1);
    assert!(stats.last_scan_at.is_some());

    // FTS5 の索引からも消えている（外部コンテンツのトリガ同期）
    assert!(db::search_files(&conn, "003", 10).unwrap().is_empty());
    assert_eq!(db::search_files(&conn, "001", 10).unwrap().len(), 1);
}

#[test]
fn updated_file_is_detected_by_mtime_and_size() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/001.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    scan(&mut conn, &root);

    fs::write(root_dir.join("work_a/001.jpg"), b"much longer contents").unwrap();
    let second = scan(&mut conn, &root);
    assert_eq!(second.updated, 1);
    assert_eq!(second.files, 1);
}

#[test]
fn cancelled_scan_keeps_committed_chunks() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/001.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();

    let cancel = AtomicBool::new(true);
    let summary = scan_with_cancel(&mut conn, &root, &cancel);
    assert_eq!(summary.status, "cancelled");
    assert_eq!(summary.files, 0);
    assert_eq!(summary.works, 0);
}

#[test]
fn works_expose_counts_bytes_and_cover() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/002.png");
    write_file(root_dir, "work_a/001.mp4");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    scan(&mut conn, &root);

    let works = db::list_works(&conn, 10, 0, "mtime").unwrap();
    assert_eq!(works.len(), 1);
    let work = &works[0];
    assert_eq!(work.title, "work_a");
    assert_eq!(work.file_count, 2);
    assert_eq!(work.total_bytes, 10);
    assert_eq!(work.kind, "mixed");
    assert!(work.cover_file_id.is_some(), "cover should be an image");

    let detail = db::get_work(&conn, work.id).unwrap().unwrap();
    assert_eq!(detail.files.len(), 2);
    assert_eq!(detail.files[0].name, "001.mp4");

    // FTS5 の索引も同期している
    let hits = db::search_files(&conn, "001", 10).unwrap();
    assert_eq!(hits.len(), 1);
}

/// #50: `after_id`（キーセット）でページを送っても `offset` と同じ順序になること。
#[test]
fn find_works_keyset_paging_matches_offset_for_every_sort() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('r', 'r', 'r', 1, 1, 0)",
        [],
    )
    .unwrap();

    // 同値（mtime / total_bytes / file_count）を混ぜて、id のタイブレークまで検証する
    let rows = [
        ("alpha", 10_i64, 300_i64, 9_i64),
        ("Beta", 20, 300, 9),
        ("gamma", 30, 100, 7),
        ("delta", 40, 100, 7),
        ("epsilon", 50, 500, 3),
        ("zeta", 60, 200, 5),
        ("eta", 70, 200, 5),
        ("theta", 80, 400, 1),
        ("iota", 90, 400, 1),
    ];
    for (title, mtime, bytes, files) in rows {
        conn.execute(
            "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime,
             created_at, updated_at)
             VALUES (1, ?1, ?2, 'image', ?3, ?4, ?5, 0, 0)",
            params![title, title, files, bytes, mtime],
        )
        .unwrap();
    }

    // last_opened / open_count 用。未設定（NULL）の作品も混ぜる。
    conn.execute(
        "INSERT INTO marks(work_id, favorite, last_opened_at, open_count)
         VALUES (1, 1, 1000, 5), (2, 0, 1000, 5), (3, 1, 2000, 2), (5, 0, NULL, 0)",
        [],
    )
    .unwrap();

    let collect = |sort: &str, use_keyset: bool| {
        let page_size = 4;
        let mut titles = Vec::new();
        let mut after_id = None;
        loop {
            let page = db::find_works(
                &conn,
                &db::WorkFilter {
                    sort: sort.to_string(),
                    limit: page_size,
                    offset: if use_keyset { 0 } else { titles.len() as i64 },
                    after_id,
                    ..db::WorkFilter::default()
                },
            )
            .unwrap();
            assert_eq!(
                page.total,
                rows.len() as i64,
                "総数はページングで変わらない"
            );
            if page.works.is_empty() {
                break;
            }
            after_id = page.works.last().map(|work| work.id);
            titles.extend(page.works.into_iter().map(|work| work.title));
            if titles.len() >= rows.len() {
                break;
            }
        }
        titles
    };

    for sort in [
        "mtime",
        "title",
        "size",
        "files",
        "last_opened",
        "open_count",
    ] {
        let by_offset = collect(sort, false);
        let by_keyset = collect(sort, true);
        assert_eq!(by_keyset, by_offset, "sort={sort}");
        assert_eq!(by_keyset.len(), rows.len(), "sort={sort} で全件を読める");
    }

    // 消えたカーソルは空ページ（総数だけ返す）
    let page = db::find_works(
        &conn,
        &db::WorkFilter {
            after_id: Some(999_999),
            ..db::WorkFilter::default()
        },
    )
    .unwrap();
    assert_eq!(page.total, rows.len() as i64);
    assert!(page.works.is_empty());
}

#[test]
fn find_works_filters_searches_sorts_and_pages() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    for name in ["alpha", "beta", "gamma"] {
        write_file(root_dir, &format!("{name}/001.jpg"));
        write_file(root_dir, &format!("{name}/002.png"));
    }
    write_file(root_dir, "movie/001.mp4");
    write_file(root_dir, "movie/002.mp4");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    scan(&mut conn, &root);

    // #3 が書くサムネイルパス（絶対パス）が一覧に載ること
    conn.execute(
        "UPDATE files SET thumb_path = 'C:\\thumbs\\alpha.webp'
         WHERE id = (SELECT cover_file_id FROM works WHERE title = 'alpha')",
        [],
    )
    .unwrap();

    // タイトルと作品パスが別物のケース（深さ 2 相当）も検索できること
    conn.execute(
        "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime,
         created_at, updated_at)
         VALUES (?1, 'series/1495', 'zeta', 'image', 1, 100, 0, 0, 0)",
        [root.id],
    )
    .unwrap();

    let mut filter = db::WorkFilter {
        sort: "title".to_string(),
        limit: 2,
        ..Default::default()
    };
    let first = db::find_works(&conn, &filter).unwrap();
    assert_eq!(first.total, 5);
    assert_eq!(
        first
            .works
            .iter()
            .map(|w| w.title.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "beta"]
    );
    assert_eq!(
        first.works[0].cover_thumb.as_deref(),
        Some("C:\\thumbs\\alpha.webp")
    );
    assert!(first.works[1].cover_thumb.is_none());

    filter.offset = 2;
    let second = db::find_works(&conn, &filter).unwrap();
    assert_eq!(second.total, 5);
    assert_eq!(
        second
            .works
            .iter()
            .map(|w| w.title.as_str())
            .collect::<Vec<_>>(),
        vec!["gamma", "movie"]
    );

    // 種類フィルタ: 動画あり / 画像のみ
    let video = db::find_works(
        &conn,
        &db::WorkFilter {
            kind: Some("video".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(video.total, 1);
    assert_eq!(video.works[0].title, "movie");

    let image = db::find_works(
        &conn,
        &db::WorkFilter {
            kind: Some("image".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(image.total, 4);

    // タイトル検索（大文字小文字は ASCII のみ無視）とパス検索
    let by_title = db::find_works(
        &conn,
        &db::WorkFilter {
            search: Some("AMM".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(by_title.total, 1);
    assert_eq!(by_title.works[0].title, "gamma");

    let by_path = db::find_works(
        &conn,
        &db::WorkFilter {
            search: Some("series/14".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(by_path.total, 1);
    assert_eq!(by_path.works[0].title, "zeta");

    // LIKE のワイルドカードはそのまま解釈させない
    let escaped = db::find_works(
        &conn,
        &db::WorkFilter {
            search: Some("%".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(escaped.total, 0);

    // ルート絞り込み
    let same_root = db::find_works(
        &conn,
        &db::WorkFilter {
            root_id: Some(root.id),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(same_root.total, 5);
    let other_root = db::find_works(
        &conn,
        &db::WorkFilter {
            root_id: Some(9999),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(other_root.total, 0);

    // 未知の種別はエラー（UI の不具合を握りつぶさない）
    assert!(matches!(
        db::find_works(
            &conn,
            &db::WorkFilter {
                kind: Some("weird".to_string()),
                ..Default::default()
            }
        ),
        Err(super::IndexError::InvalidKind(_))
    ));
}

#[test]
fn roots_pointing_to_the_same_directory_are_marked_duplicate() {
    let temp = TempDir::new().unwrap();
    let conn = db::open_in_memory().unwrap();
    let real_path = db::display_path(&std::fs::canonicalize(temp.path()).unwrap());

    // 既に同じ実体を指すルート（junction 相当）があるケースを再現する
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('D:\\alias', ?1, 'alias', 1, 1, 0)",
        [&real_path],
    )
    .unwrap();

    let root = db::add_root(&conn, temp.path().to_str().unwrap(), 1).unwrap();
    assert_eq!(root.duplicate_of, Some(1));
    assert_eq!(db::list_roots(&conn).unwrap().len(), 2);
}

#[test]
fn add_root_is_idempotent_and_validates_input() {
    let temp = TempDir::new().unwrap();
    let conn = db::open_in_memory().unwrap();

    let first = db::add_root(&conn, temp.path().to_str().unwrap(), 1).unwrap();
    let second = db::add_root(&conn, temp.path().to_str().unwrap(), 2).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(second.depth, 2);
    assert_eq!(db::list_roots(&conn).unwrap().len(), 1);

    assert!(matches!(
        db::add_root(&conn, temp.path().to_str().unwrap(), 99),
        Err(super::IndexError::InvalidDepth { .. })
    ));
    assert!(matches!(
        db::add_root(&conn, temp.path().join("missing").to_str().unwrap(), 1),
        Err(super::IndexError::Io { .. })
    ));
    assert_eq!(db::schema_version(&conn).unwrap(), db::SCHEMA_VERSION);
}

#[test]
fn custom_exclude_patterns_skip_dirs_and_files() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "keep/001.jpg");
    write_file(root_dir, "models/002.jpg");
    write_file(root_dir, "keep/cache.tmp.png");
    write_file(root_dir, "keep/003.mp4");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let config = ScanConfig {
        exclude_patterns: vec![
            "models".to_string(),
            "*.tmp.png".to_string(),
            "*.mp4".to_string(),
        ],
        ..ScanConfig::default()
    };
    let summary = scan::scan_root(
        &mut conn,
        &root,
        &AtomicBool::new(false),
        &config,
        &mut |_| {},
    )
    .expect("scan failed");

    // 既定の除外（. 始まり / node_modules）に加えて、models と 2 つのファイルが消える
    assert_eq!(summary.files, 1);
    assert_eq!(work_titles(&conn, root.id), vec!["keep"]);
}

#[test]
fn empty_exclude_patterns_index_everything() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "keep/001.jpg");
    write_file(root_dir, "node_modules/002.jpg");
    write_file(root_dir, ".hidden/003.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let config = ScanConfig {
        exclude_patterns: Vec::new(),
        ..ScanConfig::default()
    };
    let summary = scan::scan_root(
        &mut conn,
        &root,
        &AtomicBool::new(false),
        &config,
        &mut |_| {},
    )
    .expect("scan failed");

    assert_eq!(summary.files, 3, "除外を空にしたら全部載る");
}

#[test]
fn disabled_root_disappears_from_library() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work/001.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let _ = scan(&mut conn, &root);
    assert_eq!(
        db::find_works(&conn, &db::WorkFilter::default())
            .unwrap()
            .total,
        1
    );

    let updated = db::update_root(&conn, root.id, None, Some(false), None).unwrap();
    assert!(!updated.enabled);
    assert_eq!(
        db::find_works(&conn, &db::WorkFilter::default())
            .unwrap()
            .total,
        0
    );
    assert_eq!(db::library_stats(&conn).unwrap().works, 0);

    // 有効に戻すとまた見える（走査は不要）
    db::update_root(&conn, root.id, None, Some(true), None).unwrap();
    assert_eq!(
        db::find_works(&conn, &db::WorkFilter::default())
            .unwrap()
            .total,
        1
    );
}

#[test]
fn deleting_root_removes_works_and_files() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work/001.jpg");
    write_file(root_dir, "work/002.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let _ = scan(&mut conn, &root);

    db::delete_root(&conn, root.id).unwrap();
    assert!(db::list_roots(&conn).unwrap().is_empty());
    let works: i64 = conn
        .query_row("SELECT COUNT(*) FROM works", [], |row| row.get(0))
        .unwrap();
    let files: i64 = conn
        .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
        .unwrap();
    assert_eq!((works, files), (0, 0));
}

// ---------------------------------------------------------------------------
// #39: `.ts`（TypeScript）を動画として索引しない
// ---------------------------------------------------------------------------

/// `index_mpeg_ts` を指定して走査する。
fn scan_with_mpeg_ts(conn: &mut Connection, root: &db::Root, index_mpeg_ts: bool) -> ScanSummary {
    let config = ScanConfig {
        chunk_size: 7,
        progress_interval: Duration::from_millis(10),
        index_mpeg_ts,
        ..ScanConfig::default()
    };
    scan::scan_root(conn, root, &AtomicBool::new(false), &config, &mut |_| {}).expect("scan failed")
}

fn file_names(conn: &Connection, root_id: i64) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT f.name FROM files f JOIN works w ON w.id = f.work_id
             WHERE w.root_id = ?1 ORDER BY f.name",
        )
        .unwrap();
    stmt.query_map([root_id], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn typescript_ts_is_not_indexed_by_default() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "code/app.ts");
    write_file(root_dir, "code/main.tsx");
    write_file(root_dir, "work/clip.mp4");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let summary = scan_with_mpeg_ts(&mut conn, &root, false);

    assert_eq!(summary.files, 1, "`.ts` は索引しない");
    assert_eq!(summary.works, 1, "`.ts` だけの作品は作られない");
    assert_eq!(file_names(&conn, root.id), vec!["clip.mp4"]);
    assert_eq!(work_titles(&conn, root.id), vec!["work"]);
}

#[test]
fn mpeg_ts_is_indexed_when_enabled_in_settings() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "stream/record.ts");
    write_file(root_dir, "stream/cover.jpg");
    write_file(root_dir, "code/app.ts");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let summary = scan_with_mpeg_ts(&mut conn, &root, true);

    assert_eq!(summary.files, 3, "有効時は `.ts` も動画として索引する");
    assert_eq!(
        file_names(&conn, root.id),
        vec!["app.ts", "cover.jpg", "record.ts"]
    );
}

#[test]
fn rescan_drops_existing_ts_records() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "stream/record.ts");
    write_file(root_dir, "stream/cover.jpg");
    write_file(root_dir, "ts_only/001.ts");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    // 以前の設定（`.ts` を索引していた）を再現する
    let first = scan_with_mpeg_ts(&mut conn, &root, true);
    assert_eq!((first.files, first.works), (3, 2));

    // 既定設定での再走査: `.ts` のレコードと、空になった作品が消える
    let second = scan_with_mpeg_ts(&mut conn, &root, false);
    assert_eq!(second.removed, 2);
    assert_eq!((second.files, second.works), (1, 1));
    assert_eq!(file_names(&conn, root.id), vec!["cover.jpg"]);
    assert_eq!(work_titles(&conn, root.id), vec!["stream"]);
}
