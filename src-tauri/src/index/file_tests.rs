//! #21 ファイルモードのテスト。
//!
//! - `files` + `works` の JOIN（作品名が行に出る）
//! - 並び順（更新日 / 名前 / サイズ / 長さ）と絞り込み（動画 / 画像 / ルート / 検索）
//! - 65,000 件でも初回ページが予算内（ローカル 300ms / CI 600ms、#43）
//! - クエリプランに `SCAN` が出ない（索引を使っている）
//! - 作品一覧の `preview_thumbs` が先頭 4 枚になる

use std::time::Duration;

use rusqlite::{params, Connection};

use super::db::{self, FileFilter};
use super::perf;

fn seeded() -> Connection {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('r1', 'r1', 'root1', 1, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('r2', 'r2', 'root2', 1, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
         VALUES (1, '作品A', '作品A', 'mixed', 2, 1200, 300, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
         VALUES (2, '作品B', '作品B', 'image', 1, 50, 100, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
         VALUES (1, '作品A/b.png', 'b.png', 'image', 200, NULL, 300)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
         VALUES (1, '作品A/a.mp4', 'a.mp4', 'video', 1000, 5000, 200)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
         VALUES (2, '作品B/c.png', 'c.png', 'image', 50, NULL, 100)",
        [],
    )
    .unwrap();
    conn
}

fn filter(sort: &str) -> FileFilter {
    FileFilter {
        sort: sort.to_string(),
        limit: 600,
        ..FileFilter::default()
    }
}

fn names(conn: &Connection, filter: &FileFilter) -> Vec<String> {
    db::find_files(conn, filter)
        .unwrap()
        .files
        .into_iter()
        .map(|file| file.name)
        .collect()
}

#[test]
fn find_files_joins_work_and_pages() {
    let conn = seeded();

    let page = db::find_files(&conn, &filter("mtime")).unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(
        page.files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>(),
        vec!["b.png", "a.mp4", "c.png"],
        "更新日の新しい順"
    );
    let b = &page.files[0];
    assert_eq!(b.work_title, "作品A");
    assert_eq!(b.work_rel_path, "作品A");
    assert_eq!(b.root_id, 1);
    assert_eq!(b.kind, "image");

    assert_eq!(
        names(&conn, &filter("name")),
        vec!["a.mp4", "b.png", "c.png"]
    );
    assert_eq!(
        names(&conn, &filter("size")),
        vec!["a.mp4", "b.png", "c.png"]
    );
    assert_eq!(
        names(&conn, &filter("duration")),
        vec!["a.mp4", "c.png", "b.png"],
        "長さは動画が先、尺の無い画像は末尾（同値は id の新しい順）"
    );

    // ページング
    let mut paged = filter("mtime");
    paged.limit = 1;
    paged.offset = 1;
    let page = db::find_files(&conn, &paged).unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(page.files.len(), 1);
    assert_eq!(page.files[0].name, "a.mp4");
}

#[test]
fn find_files_filters_by_kind_root_and_query() {
    let conn = seeded();

    let mut video = filter("mtime");
    video.kind = Some("video".to_string());
    assert_eq!(names(&conn, &video), vec!["a.mp4"]);

    let mut image = filter("mtime");
    image.kind = Some("image".to_string());
    assert_eq!(names(&conn, &image), vec!["b.png", "c.png"]);

    let mut root = filter("mtime");
    root.root_id = Some(2);
    assert_eq!(names(&conn, &root), vec!["c.png"]);

    let mut search = filter("mtime");
    search.search = Some("作品A".to_string());
    assert_eq!(names(&conn, &search), vec!["b.png", "a.mp4"]);

    let mut search = filter("mtime");
    search.search = Some("a.m".to_string());
    assert_eq!(names(&conn, &search), vec!["a.mp4"]);

    // `%` / `_` はワイルドカードにしない
    let mut search = filter("mtime");
    search.search = Some("%".to_string());
    assert!(names(&conn, &search).is_empty());
}

#[test]
fn find_files_rejects_unknown_sort_and_kind() {
    let conn = seeded();
    assert!(db::find_files(&conn, &filter("nope")).is_err());

    let mut bad = filter("mtime");
    bad.kind = Some("audio".to_string());
    assert!(db::find_files(&conn, &bad).is_err());
}

#[test]
fn preview_thumbs_are_the_first_four_generated_files() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('r', 'r', 'r', 1, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
         VALUES (1, 'w', 'w', 'image', 6, 0, 0, 0, 0)",
        [],
    )
    .unwrap();
    for index in 0..6 {
        conn.execute(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime, thumb_path)
             VALUES (1, ?1, ?2, 'image', 1, 0, ?3)",
            params![
                format!("w/{index}.png"),
                format!("{index}.png"),
                if index == 5 {
                    None
                } else {
                    Some(format!(r"C:\thumbs\{index}.webp"))
                }
            ],
        )
        .unwrap();
    }

    let page = db::find_works(&conn, &db::WorkFilter::default()).unwrap();
    assert_eq!(page.works.len(), 1);
    assert_eq!(
        page.works[0].preview_thumbs,
        vec![
            r"C:\thumbs\0.webp",
            r"C:\thumbs\1.webp",
            r"C:\thumbs\2.webp",
            r"C:\thumbs\3.webp",
        ],
        "サムネイル未生成のファイルは飛ばし、名前順で先頭 4 枚"
    );
}

#[test]
fn sixty_five_thousand_files_first_page_is_under_300ms() {
    let mut conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('big', 'big', 'big', 1, 1, 0)",
        [],
    )
    .unwrap();

    let works = 500_i64;
    let per_work = 130_i64;
    let tx = conn.transaction().unwrap();
    for work in 0..works {
        tx.execute(
            "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
             VALUES (1, ?1, ?1, 'mixed', ?2, ?3, ?4, 0, 0)",
            params![
                format!("work-{work:03}"),
                per_work,
                per_work * 1024,
                work * 1_000
            ],
        )
        .unwrap();
        let work_id = tx.last_insert_rowid();
        for index in 0..per_work {
            let kind = if index % 7 == 0 { "video" } else { "image" };
            tx.execute(
                "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime, thumb_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                params![
                    work_id,
                    format!("work-{work:03}/{index:04}.png"),
                    format!("{index:04}.png"),
                    kind,
                    (index + 1) * 1024,
                    if kind == "video" {
                        Some((index + 1) * 1_000)
                    } else {
                        None
                    },
                    work * 1_000 + index
                ],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();

    let total = works * per_work;
    assert_eq!(total, 65_000);

    // #43: コールドキャッシュの初回だけを測ると CI で flake する。
    // ウォームアップ 1 回 + 3 回の中央値で測り、予算は CI だけ 2 倍（600ms）にする。
    let elapsed = perf::median_of_three(|| {
        let page = db::find_files(
            &conn,
            &FileFilter {
                limit: 600,
                ..FileFilter::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, total);
        assert_eq!(page.files.len(), 600);
    });

    let budget = perf::budget(Duration::from_millis(300));
    assert!(
        elapsed < budget,
        "65,000 件の初回ページに {elapsed:?} かかりました（予算 {budget:?}）"
    );
}

/// #50: `after_id`（キーセット）でページを送っても `offset` と同じ順序になること。
///
/// 同値（mtime / bytes / duration が同じ）を含むデータで、最後の `id` による
/// タイブレークまで一致することを確かめる。
#[test]
fn find_files_keyset_paging_matches_offset_for_every_sort() {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('r', 'r', 'r', 1, 1, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
         VALUES (1, 'w', 'w', 'mixed', 12, 0, 0, 0, 0)",
        [],
    )
    .unwrap();

    // mtime・bytes・duration をわざと重複させる（同値のタイブレークを検証する）
    let rows = [
        ("a.png", "image", 300, None, 500),
        ("B.png", "image", 100, None, 500),
        ("c.png", "image", 200, None, 500),
        ("d.mp4", "video", 500, Some(8_000), 400),
        ("e.mp4", "video", 400, Some(8_000), 400),
        ("f.png", "image", 200, None, 300),
        ("G.png", "image", 100, None, 200),
        ("h.png", "image", 300, None, 200),
        ("i.mp4", "video", 500, Some(2_000), 100),
        ("j.png", "image", 400, None, 100),
        ("k.png", "image", 200, None, 0),
        ("l.png", "image", 100, None, 0),
    ];
    for (name, kind, bytes, duration, mtime) in rows {
        conn.execute(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![format!("w/{name}"), name, kind, bytes, duration, mtime],
        )
        .unwrap();
    }

    let collect = |sort: &str, use_keyset: bool| {
        let page_size = 5;
        let mut names = Vec::new();
        let mut after_id = None;
        loop {
            let page = db::find_files(
                &conn,
                &FileFilter {
                    sort: sort.to_string(),
                    limit: page_size,
                    offset: if use_keyset { 0 } else { names.len() as i64 },
                    after_id,
                    ..FileFilter::default()
                },
            )
            .unwrap();
            assert_eq!(
                page.total,
                rows.len() as i64,
                "総数はページングで変わらない"
            );
            if page.files.is_empty() {
                break;
            }
            after_id = page.files.last().map(|file| file.id);
            names.extend(page.files.into_iter().map(|file| file.name));
            if names.len() >= rows.len() {
                break;
            }
        }
        names
    };

    for sort in ["mtime", "name", "size", "duration"] {
        let by_offset = collect(sort, false);
        let by_keyset = collect(sort, true);
        assert_eq!(by_keyset, by_offset, "sort={sort}");
        assert_eq!(by_keyset.len(), rows.len(), "sort={sort} で全件を読める");
    }
}

/// #50: 消えた `after_id` を渡したら、総数だけ返して空ページにする。
#[test]
fn find_files_keyset_with_unknown_cursor_returns_empty_page() {
    let conn = seeded();
    let page = db::find_files(
        &conn,
        &FileFilter {
            after_id: Some(999_999),
            ..FileFilter::default()
        },
    )
    .unwrap();
    assert_eq!(page.total, 3);
    assert!(page.files.is_empty());
}

/// #50: キーセットのクエリプランが並び順の索引を使い、全件ソートしないこと。
#[test]
fn find_files_keyset_plan_uses_the_sort_index() {
    let conn = seeded();
    let cases = [
        ("mtime", "idx_files_mtime"),
        ("name", "idx_files_name"),
        ("size", "idx_files_bytes"),
        ("duration", "idx_files_duration"),
    ];
    for (sort, index) in cases {
        let cursor: i64 = conn
            .query_row("SELECT id FROM files ORDER BY id LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let plan = db::explain_find_files(
            &conn,
            &FileFilter {
                sort: sort.to_string(),
                after_id: Some(cursor),
                ..FileFilter::default()
            },
        )
        .unwrap()
        .join("\n");
        assert!(
            plan.contains(index),
            "sort={sort} で {index} が使われていません:\n{plan}"
        );
        assert!(
            !plan.contains("USE TEMP B-TREE FOR ORDER BY"),
            "sort={sort} で全件ソートしています:\n{plan}"
        );
    }
}

/// #50: 65,000 件の「50,000 件目付近」をキーセットで読んでも予算内（ローカル 50ms / CI 100ms）。
#[test]
fn sixty_five_thousand_files_deep_keyset_page_is_under_50ms() {
    let mut conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('big', 'big', 'big', 1, 1, 0)",
        [],
    )
    .unwrap();

    let works = 500_i64;
    let per_work = 130_i64;
    let tx = conn.transaction().unwrap();
    for work in 0..works {
        tx.execute(
            "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
             VALUES (1, ?1, ?1, 'mixed', ?2, ?3, ?4, 0, 0)",
            params![
                format!("work-{work:03}"),
                per_work,
                per_work * 1024,
                work * 1_000
            ],
        )
        .unwrap();
        let work_id = tx.last_insert_rowid();
        for index in 0..per_work {
            let kind = if index % 7 == 0 { "video" } else { "image" };
            tx.execute(
                "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    work_id,
                    format!("work-{work:03}/{index:04}.png"),
                    format!("{index:04}.png"),
                    kind,
                    (index + 1) * 1024,
                    if kind == "video" {
                        Some((index + 1) * 1_000)
                    } else {
                        None
                    },
                    // 同値を作るため 1,000 件ごとに mtime を折り返す
                    (work * 1_000 + index) % 1_000
                ],
            )
            .unwrap();
        }
    }
    tx.commit().unwrap();

    // 50,000 件目（mtime 降順）の id をカーソルにする
    let cursor: i64 = conn
        .query_row(
            "SELECT id FROM files ORDER BY mtime DESC, id DESC LIMIT 1 OFFSET 50000",
            [],
            |row| row.get(0),
        )
        .unwrap();

    let elapsed = perf::median_of_three(|| {
        let page = db::find_files(
            &conn,
            &FileFilter {
                sort: "mtime".to_string(),
                limit: 600,
                after_id: Some(cursor),
                ..FileFilter::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 65_000);
        assert_eq!(page.files.len(), 600);
    });

    let budget = perf::budget(Duration::from_millis(50));
    assert!(
        elapsed < budget,
        "65,000 件の深いキーセットページに {elapsed:?} かかりました（予算 {budget:?}）"
    );
}

/// #43: `roots.enabled = 1` の絞り込みが索引で引かれ、大きな表を `SCAN` しないこと。
///
/// 計測が速くても `SCAN` していれば件数が増えたときに破綻するので、プランでも担保する。
#[test]
fn find_files_query_plan_uses_indexes_and_never_scans_tables() {
    let conn = seeded();

    let mut cases = vec![
        filter("mtime"),
        filter("name"),
        filter("size"),
        filter("duration"),
    ];

    let mut video = filter("mtime");
    video.kind = Some("video".to_string());
    cases.push(video);

    let mut root = filter("mtime");
    root.root_id = Some(1);
    cases.push(root);

    let mut work = filter("mtime");
    work.work_id = Some(1);
    cases.push(work);

    let mut search = filter("mtime");
    search.search = Some("a".to_string());
    cases.push(search);

    for case in &cases {
        let plan = db::explain_find_files(&conn, case).unwrap();
        let joined = plan.join("\n");

        assert!(
            !joined.contains("SCAN"),
            "sort={:?} kind={:?} root={:?} work={:?} search={:?} のクエリプランに SCAN があります:\n{joined}",
            case.sort,
            case.kind,
            case.root_id,
            case.work_id,
            case.search
        );
        assert!(
            joined.contains("idx_files_work"),
            "files が索引で引かれていません:\n{joined}"
        );
    }
}

/// #43: `roots.enabled` の絞り込み自体が索引を使うこと（`SCAN roots` を出さない）。
#[test]
fn roots_enabled_filter_uses_the_index() {
    let conn = seeded();
    let plan = db::explain_find_files(&conn, &filter("mtime")).unwrap();
    let joined = plan.join("\n");

    assert!(
        joined.contains("idx_roots_enabled"),
        "roots.enabled の索引が使われていません:\n{joined}"
    );
    assert!(
        !joined.contains("SCAN roots"),
        "roots を SCAN しています:\n{joined}"
    );
}
