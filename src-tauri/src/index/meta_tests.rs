//! 生成メタデータの検索・キャッシュ（#60）のテスト。
//!
//! - FTS5 への登録と検索（プロンプト・モデル）
//! - FTS に載せていない項目（シード）の LIKE フォールバック
//! - 壊れた JSON を入れても落ちないこと
//! - 付与率レポートの集計
//! - `find_files` / `find_works` の `meta_query` 絞り込み

use rusqlite::Connection;

use super::db;
use crate::meta::GenerationMeta;

fn meta(prompt: &str, model: &str, seed: &str) -> GenerationMeta {
    GenerationMeta {
        prompt: Some(prompt.to_string()),
        negative_prompt: Some("worst quality".to_string()),
        model: Some(model.to_string()),
        loras: vec!["detail.safetensors: 0.7".to_string()],
        seed: Some(seed.to_string()),
        raw: Some(format!("{{\"prompt\":\"{prompt}\"}}")),
        source: "png".to_string(),
        ..Default::default()
    }
}

/// ルート 1 件・作品 2 件・ファイル 3 件の索引。
///
/// - file 1 … work 1（後でメタデータを入れる）
/// - file 2 … work 2（壊れた JSON を入れる）
/// - file 3 … work 2（未抽出のまま）
fn seeded() -> Connection {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO roots(id, path, real_path, label, depth, enabled, created_at)
         VALUES (1, 'r', 'r', 'ルート', 1, 1, 0);
         INSERT INTO works(id, root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
         VALUES (1, 1, 'alpha', 'Alpha', 'image', 1, 10, 100, 0, 0),
                (2, 1, 'beta', 'Beta', 'image', 2, 20, 200, 0, 0);
         INSERT INTO files(id, work_id, rel_path, name, kind, bytes, mtime)
         VALUES (1, 1, 'alpha/001.png', '001.png', 'image', 10, 1000),
                (2, 2, 'beta/001.png', '001.png', 'image', 10, 2000),
                (3, 2, 'beta/002.png', '002.png', 'image', 10, 3000);",
    )
    .unwrap();
    conn
}

#[test]
fn fts_registers_and_searches_prompt_and_model() {
    let conn = seeded();
    let entry = meta("masterpiece, a cat", "fooMix", "12345");
    db::save_file_meta(&conn, 1, 1000, Some(&entry)).unwrap();

    let by_prompt = db::search_meta(&conn, "cat", 10).unwrap();
    assert_eq!(by_prompt.len(), 1);
    assert_eq!(by_prompt[0].file_id, 1);
    assert_eq!(by_prompt[0].work_title, "Alpha");
    assert!(by_prompt[0].snippet.contains("cat"));

    let by_model = db::search_meta(&conn, "foomix", 10).unwrap();
    assert_eq!(by_model.len(), 1);

    // シードは FTS の列に無いので LIKE フォールバックで拾う
    let by_seed = db::search_meta(&conn, "12345", 10).unwrap();
    assert_eq!(by_seed.len(), 1);
    assert_eq!(by_seed[0].file_id, 1);

    assert!(db::search_meta(&conn, "no-such-word", 10)
        .unwrap()
        .is_empty());
}

#[test]
fn broken_json_is_searchable_and_does_not_panic() {
    let conn = seeded();
    conn.execute(
        "UPDATE files SET meta_json = '{broken json', meta_mtime = mtime WHERE id = 2",
        [],
    )
    .unwrap();

    let hits = db::search_meta(&conn, "broken", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].file_id, 2);
    // 他の語でも落ちない
    assert!(db::search_meta(&conn, "cat", 10).unwrap().is_empty());
}

#[test]
fn meta_report_counts_files_with_and_without_metadata() {
    let conn = seeded();
    db::save_file_meta(&conn, 1, 1000, Some(&meta("cat", "modelA", "1"))).unwrap();
    // 抽出したが生成情報が無かったファイル
    db::save_file_meta(&conn, 2, 2000, None).unwrap();
    // file 3 は未抽出

    let report = db::meta_report(&conn).unwrap();
    assert_eq!(report.total, 3);
    assert_eq!(report.with_meta, 1);
    assert_eq!(report.without_meta, 2);
    assert_eq!(report.by_root.len(), 1);
    assert_eq!(report.by_root[0].root_id, 1);
    assert_eq!(report.by_root[0].total, 3);
    assert_eq!(report.by_root[0].with_meta, 1);

    // 再抽出が必要なのは「未抽出」と「mtime が変わった」だけ
    assert_eq!(db::pending_meta_count(&conn).unwrap(), 1);
    conn.execute("UPDATE files SET mtime = 4000 WHERE id = 1", [])
        .unwrap();
    assert_eq!(db::pending_meta_count(&conn).unwrap(), 2);
}

#[test]
fn meta_query_filters_files_and_works() {
    let conn = seeded();
    db::save_file_meta(&conn, 1, 1000, Some(&meta("a cat", "fooMix", "42"))).unwrap();
    db::save_file_meta(&conn, 3, 3000, Some(&meta("a dog", "barMix", "7"))).unwrap();

    let files = db::find_files(
        &conn,
        &db::FileFilter {
            meta_query: Some("dog".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(files.total, 1);
    assert_eq!(files.files[0].id, 3);
    assert!(files.files[0].has_meta);

    let works = db::find_works(
        &conn,
        &db::WorkFilter {
            meta_query: Some("cat".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(works.total, 1);
    assert_eq!(works.works[0].id, 1);

    // シード値でも作品を絞り込める（LIKE フォールバック）
    let works = db::find_works(
        &conn,
        &db::WorkFilter {
            meta_query: Some("42".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(works.total, 1);
    assert_eq!(works.works[0].id, 1);

    // 一致なし
    let none = db::find_files(
        &conn,
        &db::FileFilter {
            meta_query: Some("no such".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(none.total, 0);

    // ファイル名検索と生成情報は OR（「生成情報も検索」で絞りすぎない）
    let both = db::find_files(
        &conn,
        &db::FileFilter {
            search: Some("002.png".to_string()),
            meta_query: Some("cat".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(both.total, 2);

    let both = db::find_works(
        &conn,
        &db::WorkFilter {
            search: Some("Beta".to_string()),
            meta_query: Some("cat".to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(both.total, 2);
}

#[test]
fn schema_has_meta_columns_and_fts() {
    let conn = db::open_in_memory().unwrap();
    assert_eq!(db::schema_version(&conn).unwrap(), db::SCHEMA_VERSION);

    let columns: Vec<String> = conn
        .prepare("PRAGMA table_info(files)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(columns.iter().any(|column| column == "meta_json"));
    assert!(columns.iter().any(|column| column == "meta_mtime"));

    let fts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'files_meta_fts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(fts, 1);
}
