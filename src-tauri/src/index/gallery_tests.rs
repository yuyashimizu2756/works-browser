//! 作品詳細（#5）のテスト。
//!
//! - 作品単位のファイル一覧（`get_work_files` / `find_files` の `work_id`）
//! - 再生位置の保存・復元・削除（`file_positions`、スキーマ v4）
//! - 実パスの組み立て（メディア配信・エクスプローラ用）

use rusqlite::{params, Connection};

use super::db::{self, FileFilter};
use super::perf;

fn seeded() -> Connection {
    let conn = db::open_in_memory().unwrap();
    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
         VALUES ('C:\\root', 'C:\\root', 'root', 1, 1, 0)",
        [],
    )
    .unwrap();
    for (id, rel, title, kind) in [
        (1, "作品A", "作品A", "mixed"),
        (2, "作品B", "作品B", "image"),
    ] {
        conn.execute(
            "INSERT INTO works(id, root_id, rel_path, title, kind, file_count, total_bytes,
                mtime, created_at, updated_at)
             VALUES (?1, 1, ?2, ?3, ?4, 0, 0, 0, 0, 0)",
            params![id, rel, title, kind],
        )
        .unwrap();
    }
    for (work_id, rel, name, kind, bytes, duration) in [
        (1, "作品A/b.png", "b.png", "image", 200_i64, None),
        (1, "作品A/a.mp4", "a.mp4", "video", 1000, Some(5000_i64)),
        (1, "作品A/c.mp4", "c.mp4", "video", 3000, Some(60_000_i64)),
        (2, "作品B/d.png", "d.png", "image", 50, None),
    ] {
        conn.execute(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![work_id, rel, name, kind, bytes, duration],
        )
        .unwrap();
    }
    conn
}

#[test]
fn files_are_scoped_to_one_work() {
    let conn = seeded();

    let page = db::find_files(
        &conn,
        &FileFilter {
            work_id: Some(1),
            sort: "name".to_string(),
            limit: 600,
            ..FileFilter::default()
        },
    )
    .unwrap();

    assert_eq!(page.total, 3);
    assert_eq!(
        page.files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>(),
        vec!["a.mp4", "b.png", "c.mp4"]
    );

    // 種類で絞ると作品内の動画だけになる
    let videos = db::find_files(
        &conn,
        &FileFilter {
            work_id: Some(1),
            kind: Some("video".to_string()),
            sort: "name".to_string(),
            ..FileFilter::default()
        },
    )
    .unwrap();
    assert_eq!(videos.total, 2);
    assert!(videos
        .files
        .iter()
        .all(|file| file.work_id == 1 && file.kind == "video"));

    // ページング（作品内で 1 件ずつ）
    let paged = db::find_files(
        &conn,
        &FileFilter {
            work_id: Some(1),
            sort: "name".to_string(),
            limit: 1,
            offset: 2,
            ..FileFilter::default()
        },
    )
    .unwrap();
    assert_eq!(paged.total, 3);
    assert_eq!(paged.files.len(), 1);
    assert_eq!(paged.files[0].name, "c.mp4");
}

#[test]
fn work_info_is_light_and_work_path_is_resolved() {
    let conn = seeded();
    let info = db::get_work_info(&conn, 1).unwrap().unwrap();
    assert_eq!(info.work.title, "作品A");
    assert_eq!(info.root_label, "root");
    assert_eq!(info.root_real_path, "C:\\root");

    let work_path = db::work_absolute_path(&conn, 1).unwrap().unwrap();
    assert_eq!(work_path, std::path::Path::new("C:\\root").join("作品A"));

    let file_path = db::file_absolute_path(&conn, 2).unwrap().unwrap();
    assert_eq!(
        file_path,
        std::path::Path::new("C:\\root").join("作品A").join("a.mp4")
    );
    assert!(db::file_absolute_path(&conn, 999).unwrap().is_none());
}

#[test]
fn play_position_is_saved_restored_and_cleared() {
    let conn = seeded();

    assert!(db::get_file_position(&conn, 2).unwrap().is_none());

    db::save_file_position(&conn, 2, 42_500, Some(60_000)).unwrap();
    let saved = db::get_file_position(&conn, 2).unwrap().unwrap();
    assert_eq!(saved.file_id, 2);
    assert_eq!(saved.position_ms, 42_500);
    assert_eq!(saved.duration_ms, Some(60_000));
    assert!(saved.updated_at > 0);

    // 上書き（同じ行のまま）
    db::save_file_position(&conn, 2, 10_000, Some(60_000)).unwrap();
    assert_eq!(
        db::get_file_position(&conn, 2)
            .unwrap()
            .unwrap()
            .position_ms,
        10_000
    );
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM file_positions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 1);

    // 0 以下は「最初から」= 行を消す
    db::save_file_position(&conn, 2, 0, Some(60_000)).unwrap();
    assert!(db::get_file_position(&conn, 2).unwrap().is_none());
}

#[test]
fn play_position_is_exposed_in_work_detail_and_file_pages() {
    let conn = seeded();
    db::save_file_position(&conn, 2, 7_000, Some(5_000)).unwrap();

    let detail = db::get_work(&conn, 1).unwrap().unwrap();
    let a = detail
        .files
        .iter()
        .find(|file| file.name == "a.mp4")
        .unwrap();
    assert_eq!(a.position_ms, Some(7_000));
    let b = detail
        .files
        .iter()
        .find(|file| file.name == "b.png")
        .unwrap();
    assert_eq!(b.position_ms, None);

    let page = db::find_files(
        &conn,
        &FileFilter {
            work_id: Some(1),
            sort: "name".to_string(),
            ..FileFilter::default()
        },
    )
    .unwrap();
    assert_eq!(
        page.files
            .iter()
            .find(|file| file.id == 2)
            .unwrap()
            .position_ms,
        Some(7_000)
    );
}

#[test]
fn positions_are_deleted_with_their_file() {
    let conn = seeded();
    db::save_file_position(&conn, 2, 7_000, Some(5_000)).unwrap();
    conn.execute("DELETE FROM files WHERE id = 2", []).unwrap();
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM file_positions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 0, "file_positions は files に追随して消える");
}

#[test]
fn play_position_survives_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("index.db");
    {
        let conn = db::open(&db_path).unwrap();
        conn.execute(
            "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
             VALUES ('r', 'r', 'r', 1, 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO works(id, root_id, rel_path, title, kind, file_count, total_bytes,
                mtime, created_at, updated_at)
             VALUES (1, 1, 'w', 'w', 'video', 1, 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO files(id, work_id, rel_path, name, kind, bytes, duration_ms, mtime)
             VALUES (1, 1, 'w/a.mp4', 'a.mp4', 'video', 1, 120000, 0)",
            [],
        )
        .unwrap();
        db::save_file_position(&conn, 1, 83_000, Some(120_000)).unwrap();
    }

    // アプリを閉じて開き直しても位置が残る
    let conn = db::open(&db_path).unwrap();
    let position = db::get_file_position(&conn, 1).unwrap().unwrap();
    assert_eq!(position.position_ms, 83_000);
    assert_eq!(position.duration_ms, Some(120_000));

    let page = db::find_files(
        &conn,
        &FileFilter {
            work_id: Some(1),
            ..FileFilter::default()
        },
    )
    .unwrap();
    assert_eq!(page.files[0].position_ms, Some(83_000));
}

#[test]
fn one_thousand_file_work_first_page_is_under_300ms() {
    let conn = seeded();
    let tx = conn.unchecked_transaction().unwrap();
    for index in 0..1_000 {
        let kind = if index % 5 == 0 { "video" } else { "image" };
        tx.execute(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, duration_ms, mtime)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                format!("作品A/{index:04}.png"),
                format!("{index:04}.png"),
                kind,
                (index + 1) * 1024,
                if kind == "video" {
                    Some((index + 1) * 1_000)
                } else {
                    None
                },
                index
            ],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    // #43: こちらもウォームアップ + 3 回の中央値で測る（CI は予算 2 倍）。
    let elapsed = perf::median_of_three(|| {
        let page = db::find_files(
            &conn,
            &FileFilter {
                work_id: Some(1),
                sort: "name".to_string(),
                limit: 300,
                ..FileFilter::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1_003);
        assert_eq!(page.files.len(), 300);
    });

    let budget = perf::budget(std::time::Duration::from_millis(300));
    assert!(
        elapsed < budget,
        "作品内 300 件の初回ページに {elapsed:?} かかりました（予算 {budget:?}）"
    );
}
