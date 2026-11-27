//! タグ・評価・開封回数（#6）のテスト。
//!
//! - タグの CRUD と作品への付与（差し替え・重複の除去）
//! - `tag_id` / `favorite` / `min_rating` フィルタ
//! - `record_open` の加算と、評価を付けても回数が消えないこと
//! - 「最近見た」「よく見る」の並び順
//! - 再走査してもタグ・評価・開封回数が残ること
//! - 作品やタグを消したときに `ON DELETE CASCADE` で一緒に消えること

use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use rusqlite::Connection;
use tempfile::TempDir;

use super::db;
use super::scan::{self, ScanConfig};

fn write_file(root: &Path, relative: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, b"dummy").unwrap();
}

/// 一時ディレクトリを走査して作品を作る。戻り値は `(conn, root, 作品タイトル→id)`。
fn scanned_library() -> (Connection, db::Root, Vec<(String, i64)>) {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    for name in ["alpha", "beta", "gamma"] {
        write_file(root_dir, &format!("{name}/001.jpg"));
        write_file(root_dir, &format!("{name}/002.png"));
    }

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let config = ScanConfig {
        chunk_size: 7,
        progress_interval: Duration::from_millis(10),
        ..ScanConfig::default()
    };
    scan::scan_root(
        &mut conn,
        &root,
        &AtomicBool::new(false),
        &config,
        &mut |_progress| {},
    )
    .unwrap();

    let works = {
        let mut stmt = conn
            .prepare("SELECT title, id FROM works ORDER BY title")
            .unwrap();
        stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
    };
    // temp は drop されるが、走査済みの索引はメモリ上にある
    drop(temp);
    (conn, root, works)
}

fn work_id(works: &[(String, i64)], title: &str) -> i64 {
    works
        .iter()
        .find(|(name, _)| name == title)
        .map(|(_, id)| *id)
        .expect("作品が見つかりません")
}

#[test]
fn tags_are_created_listed_and_deleted() {
    let conn = db::open_in_memory().unwrap();

    let first = db::create_tag(&conn, "  お気に入り ", Some("#F59E0B")).unwrap();
    assert_eq!(first.name, "お気に入り");
    assert_eq!(first.color, "#f59e0b");
    assert_eq!(first.works, 0);

    // 同じ名前（大文字小文字・前後の空白を無視）は色だけ更新して同じ ID を返す
    let renamed = db::create_tag(&conn, "お気に入り", Some("#abc")).unwrap();
    assert_eq!(renamed.id, first.id);
    assert_eq!(renamed.color, "#aabbcc");

    let second = db::create_tag(&conn, "あとで見る", Some("not-a-color")).unwrap();
    assert_eq!(second.color, "#22d3ee", "不正な色は既定色に丸める");

    let tags = db::list_tags(&conn).unwrap();
    assert_eq!(tags.len(), 2);

    assert!(matches!(
        db::create_tag(&conn, "   ", None),
        Err(super::IndexError::InvalidTag(_))
    ));

    db::delete_tag(&conn, first.id).unwrap();
    assert_eq!(db::list_tags(&conn).unwrap().len(), 1);
    assert!(matches!(
        db::delete_tag(&conn, first.id),
        Err(super::IndexError::TagNotFound(_))
    ));
}

#[test]
fn work_tags_are_replaced_and_deduplicated() {
    let (conn, _, works) = scanned_library();
    let alpha = work_id(&works, "alpha");
    let red = db::create_tag(&conn, "赤", Some("#ff0000")).unwrap();
    let blue = db::create_tag(&conn, "青", Some("#0000ff")).unwrap();

    let applied = db::set_work_tags(&conn, alpha, &[red.id, blue.id, red.id]).unwrap();
    assert_eq!(
        applied
            .iter()
            .map(|tag| tag.name.as_str())
            .collect::<Vec<_>>(),
        vec!["赤", "青"]
    );
    assert_eq!(db::list_tags(&conn).unwrap()[0].works, 1);

    // 差し替え: 青だけにすると赤は外れる
    let replaced = db::set_work_tags(&conn, alpha, &[blue.id]).unwrap();
    assert_eq!(replaced.len(), 1);
    assert_eq!(replaced[0].id, blue.id);

    // 存在しないタグ ID は無視する
    let ignored = db::set_work_tags(&conn, alpha, &[blue.id, 9999]).unwrap();
    assert_eq!(ignored.len(), 1);

    // 空配列で全解除
    assert!(db::set_work_tags(&conn, alpha, &[]).unwrap().is_empty());

    assert!(matches!(
        db::set_work_tags(&conn, 9999, &[blue.id]),
        Err(super::IndexError::WorkNotFound(9999))
    ));
}

#[test]
fn works_filter_by_tag_favorite_and_rating() {
    let (conn, _, works) = scanned_library();
    let alpha = work_id(&works, "alpha");
    let beta = work_id(&works, "beta");
    let gamma = work_id(&works, "gamma");
    let tag = db::create_tag(&conn, "シリーズ", Some("#22d3ee")).unwrap();

    db::set_work_tags(&conn, alpha, &[tag.id]).unwrap();
    db::set_work_tags(&conn, beta, &[tag.id]).unwrap();
    db::set_work_mark(&conn, beta, true, Some(5), None).unwrap();
    db::set_work_mark(&conn, gamma, false, Some(3), Some("メモ".to_string())).unwrap();

    let by_tag = db::find_works(
        &conn,
        &db::WorkFilter {
            tag_id: Some(tag.id),
            sort: "title".to_string(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        by_tag
            .works
            .iter()
            .map(|work| work.title.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha", "beta"]
    );

    let favorites = db::find_works(
        &conn,
        &db::WorkFilter {
            favorite: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(favorites.total, 1);
    assert_eq!(favorites.works[0].id, beta);

    let unrated = db::find_works(
        &conn,
        &db::WorkFilter {
            favorite: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(unrated.total, 2);

    let rated = db::find_works(
        &conn,
        &db::WorkFilter {
            min_rating: Some(4),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rated.total, 1);
    assert_eq!(rated.works[0].id, beta);

    // 条件の組み合わせ（タグ + お気に入り）
    let combined = db::find_works(
        &conn,
        &db::WorkFilter {
            tag_id: Some(tag.id),
            favorite: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(combined.total, 1);
    assert_eq!(combined.works[0].id, beta);
}

#[test]
fn record_open_counts_and_keeps_mark_fields() {
    let (conn, _, works) = scanned_library();
    let alpha = work_id(&works, "alpha");

    let first = db::record_open(&conn, alpha).unwrap();
    assert_eq!(first.open_count, 1);
    assert!(first.last_opened_at.is_some());
    assert!(!first.favorite);

    let second = db::record_open(&conn, alpha).unwrap();
    assert_eq!(second.open_count, 2);
    assert!(second.last_opened_at >= first.last_opened_at);

    // 評価を付けても開封回数・最終閲覧は消えない
    let marked =
        db::set_work_mark(&conn, alpha, true, Some(4), Some(" 良い ".to_string())).unwrap();
    assert!(marked.favorite);
    assert_eq!(marked.rating, Some(4));
    assert_eq!(marked.note.as_deref(), Some("良い"));
    assert_eq!(marked.open_count, 2);
    assert_eq!(marked.last_opened_at, second.last_opened_at);

    // 評価を外す（null）と未評価に戻る
    let cleared = db::set_work_mark(&conn, alpha, false, None, None).unwrap();
    assert_eq!(cleared.rating, None);
    assert_eq!(cleared.note, None);
    assert_eq!(cleared.open_count, 2);

    assert!(matches!(
        db::set_work_mark(&conn, alpha, false, Some(9), None),
        Err(super::IndexError::InvalidRating(9))
    ));

    // 未設定の作品は既定値
    let untouched = db::get_work_mark(&conn, work_id(&works, "beta")).unwrap();
    assert_eq!(untouched.open_count, 0);
    assert!(!untouched.favorite);
    assert_eq!(untouched.rating, None);
}

#[test]
fn works_sort_by_last_opened_and_open_count() {
    let (conn, _, works) = scanned_library();
    let alpha = work_id(&works, "alpha");
    let beta = work_id(&works, "beta");
    let gamma = work_id(&works, "gamma");

    // alpha を 1 回、beta を 3 回開く。gamma は未開封のまま。
    db::record_open(&conn, alpha).unwrap();
    for _ in 0..3 {
        db::record_open(&conn, beta).unwrap();
    }

    let by_open = db::find_works(
        &conn,
        &db::WorkFilter {
            sort: "open_count".to_string(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        by_open
            .works
            .iter()
            .map(|work| work.title.as_str())
            .collect::<Vec<_>>(),
        vec!["beta", "alpha", "gamma"],
        "開封回数の多い順・未開封は末尾"
    );

    // 最近見た順は最終閲覧の新しい順（alpha が後）。
    // `last_opened_at` はミリ秒なので、同じ ms に揃って順序が曖昧にならないよう待つ。
    std::thread::sleep(Duration::from_millis(5));
    db::record_open(&conn, alpha).unwrap();
    let recent = db::find_works(
        &conn,
        &db::WorkFilter {
            sort: "last_opened".to_string(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(recent.works[0].id, alpha);
    assert_eq!(recent.works[1].id, beta);
    assert_eq!(recent.works[2].id, gamma);

    // 未知の並び順はエラー（UI の不具合を握りつぶさない）
    assert!(matches!(
        db::find_works(
            &conn,
            &db::WorkFilter {
                sort: "weird".to_string(),
                ..Default::default()
            }
        ),
        Err(super::IndexError::InvalidSort(_))
    ));
}

#[test]
fn rescan_keeps_tags_marks_and_open_counts() {
    let temp = TempDir::new().unwrap();
    let root_dir = temp.path();
    write_file(root_dir, "work_a/001.jpg");
    write_file(root_dir, "work_b/001.jpg");

    let mut conn = db::open_in_memory().unwrap();
    let root = db::add_root(&conn, root_dir.to_str().unwrap(), 1).unwrap();
    let config = ScanConfig {
        chunk_size: 7,
        progress_interval: Duration::from_millis(10),
        ..ScanConfig::default()
    };
    scan::scan_root(
        &mut conn,
        &root,
        &AtomicBool::new(false),
        &config,
        &mut |_progress| {},
    )
    .unwrap();

    let alpha = db::find_works(&conn, &db::WorkFilter::default())
        .unwrap()
        .works
        .iter()
        .find(|work| work.title == "work_a")
        .map(|work| work.id)
        .unwrap();
    let tag = db::create_tag(&conn, "残る", Some("#10b981")).unwrap();
    db::set_work_tags(&conn, alpha, &[tag.id]).unwrap();
    db::set_work_mark(&conn, alpha, true, Some(5), None).unwrap();
    db::record_open(&conn, alpha).unwrap();

    // ファイルを 1 枚足して再走査（works 行は upsert されるだけ）
    write_file(root_dir, "work_a/002.jpg");
    scan::scan_root(
        &mut conn,
        &root,
        &AtomicBool::new(false),
        &config,
        &mut |_progress| {},
    )
    .unwrap();

    let tags = db::get_work_tags(&conn, alpha).unwrap();
    assert_eq!(tags.len(), 1, "再走査でタグが消えています");
    assert_eq!(tags[0].name, "残る");

    let mark = db::get_work_mark(&conn, alpha).unwrap();
    assert!(mark.favorite);
    assert_eq!(mark.rating, Some(5));
    assert_eq!(mark.open_count, 1);

    // 作品 ID も変わらない（作り直していない）
    let again = db::find_works(&conn, &db::WorkFilter::default())
        .unwrap()
        .works
        .iter()
        .find(|work| work.title == "work_a")
        .map(|work| work.id)
        .unwrap();
    assert_eq!(again, alpha);
}

#[test]
fn deleting_work_or_tag_cascades_links_and_marks() {
    let (conn, root, works) = scanned_library();
    let alpha = work_id(&works, "alpha");
    let beta = work_id(&works, "beta");
    let red = db::create_tag(&conn, "赤", Some("#ff0000")).unwrap();
    let blue = db::create_tag(&conn, "青", Some("#0000ff")).unwrap();
    db::set_work_tags(&conn, alpha, &[red.id, blue.id]).unwrap();
    db::set_work_tags(&conn, beta, &[red.id, blue.id]).unwrap();
    db::set_work_mark(&conn, alpha, true, Some(3), None).unwrap();

    // タグを消すと付与だけが消える（作品は残る）
    db::delete_tag(&conn, red.id).unwrap();
    let remaining = db::get_work_tags(&conn, alpha).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, blue.id);

    // 作品を索引から消す（走査の削除と同じ経路）とタグ・評価も消える
    conn.execute("DELETE FROM files WHERE work_id = ?1", [alpha])
        .unwrap();
    conn.execute(
        "DELETE FROM works WHERE root_id = ?1 AND NOT EXISTS
           (SELECT 1 FROM files WHERE files.work_id = works.id)",
        [root.id],
    )
    .unwrap();

    let links: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM work_tags WHERE work_id = ?1",
            [alpha],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(links, 0, "作品削除で work_tags が残っています");
    let marks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM marks WHERE work_id = ?1",
            [alpha],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marks, 0, "作品削除で marks が残っています");

    // 他の作品の付与は無事
    assert_eq!(db::get_work_tags(&conn, beta).unwrap()[0].id, blue.id);
}

// ---------------------------------------------------------------------------
// #79: 生成情報の頻出語からタグ候補
// ---------------------------------------------------------------------------

/// 作品の全ファイルに、同じ生成情報をキャッシュする（実ファイルは読まない）。
fn cache_meta(conn: &Connection, work_id: i64, meta: &crate::meta::GenerationMeta) -> usize {
    let files: Vec<(i64, i64)> = {
        let mut stmt = conn
            .prepare("SELECT id, mtime FROM files WHERE work_id = ?1 ORDER BY id")
            .unwrap();
        stmt.query_map([work_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    for (file_id, mtime) in &files {
        db::save_file_meta(conn, *file_id, *mtime, Some(meta)).unwrap();
    }
    files.len()
}

#[test]
fn tag_suggestions_rank_terms_and_skip_existing_tags() {
    let (conn, _root, works) = scanned_library();
    let alpha = work_id(&works, "alpha");

    // 生成情報が無い作品は空
    assert!(db::tag_suggestions(&conn, alpha, 20).unwrap().is_empty());

    cache_meta(
        &conn,
        alpha,
        &crate::meta::GenerationMeta {
            prompt: Some("red dress, sunset, red eyes".to_string()),
            negative_prompt: Some("worst quality, low quality, blurry".to_string()),
            model: Some("sdxl_base".to_string()),
            loras: vec!["style_x: 0.8".to_string()],
            ..Default::default()
        },
    );

    let suggestions = db::tag_suggestions(&conn, alpha, 20).unwrap();
    let names: Vec<&str> = suggestions.iter().map(|item| item.name.as_str()).collect();
    // 2 ファイルに同じ内容を入れたので、各語の count は 2
    assert!(suggestions.iter().all(|item| item.count == 2));
    assert!(names.contains(&"dress"));
    assert!(names.contains(&"sunset"));
    assert!(names.contains(&"style"));
    // 品質系の定型語・数字だけの語は出ない
    assert!(!names.contains(&"worst"));
    assert!(!names.contains(&"quality"));
    assert!(!names.contains(&"blurry"));
    assert!(!names.contains(&"0.8"));

    // 既存タグと同名（正規化して一致）の語は外れる
    let tag = db::create_tag(&conn, "Dress", Some("#ff0000")).unwrap();
    db::set_work_tags(&conn, alpha, &[tag.id]).unwrap();
    let filtered = db::tag_suggestions(&conn, alpha, 20).unwrap();
    assert!(!filtered.iter().any(|item| item.name == "dress"));

    // 全角・大文字の既存タグも同じ語として外れる
    let fullwidth = db::create_tag(&conn, "ＳＵＮＳＥＴ", None).unwrap();
    db::set_work_tags(&conn, alpha, &[tag.id, fullwidth.id]).unwrap();
    let filtered_fullwidth = db::tag_suggestions(&conn, alpha, 20).unwrap();
    assert!(!filtered_fullwidth.iter().any(|item| item.name == "sunset"));

    // 上限を守る
    let limited = db::tag_suggestions(&conn, alpha, 1).unwrap();
    assert_eq!(limited.len(), 1);

    // 存在しない作品はエラー
    assert!(db::tag_suggestions(&conn, 9999, 20).is_err());
}

#[test]
fn tag_suggestions_skip_words_over_the_length_limit() {
    let (conn, _root, works) = scanned_library();
    let alpha = work_id(&works, "alpha");

    cache_meta(
        &conn,
        alpha,
        &crate::meta::GenerationMeta {
            // 句読点なしの日本語長文は 1 トークンになり、40 文字を超えうる
            prompt: Some(
                "桜の花びらが舞い散る美しい夜の街並みを歩く黒猫と少年, red dress".to_string(),
            ),
            ..Default::default()
        },
    );

    let suggestions = db::tag_suggestions(&conn, alpha, 20).unwrap();
    assert!(suggestions
        .iter()
        .all(|item| item.name.chars().count() <= crate::tagsuggest::MAX_CANDIDATE_CHARS));
    // タグ作成の 40 文字制限に達する語は絶対に出ない
    assert!(suggestions
        .iter()
        .all(|item| item.name.chars().count() < 40));
    assert!(suggestions.iter().any(|item| item.name == "red"));
}
