//! スマートフォルダ（保存検索、#69）のテスト。
//!
//! - 保存 → 一覧 → 削除の往復
//! - 同じ名前で保存すると条件だけ更新される（並び順・作成日時は保つ）
//! - 名前変更と、重複名の拒否
//! - 空の名前・壊れた条件 JSON の拒否

use super::db;
use super::IndexError;

fn query(search: &str) -> String {
    format!(r#"{{"search":"{search}","kind":"all","sort":"mtime","dir":"desc"}}"#)
}

#[test]
fn save_list_and_delete_round_trip() {
    let conn = db::open_in_memory().unwrap();

    let favorite = db::save_smart_folder(&conn, "お気に入り", &query("")).unwrap();
    let nights = db::save_smart_folder(&conn, "夜の動画", &query("night")).unwrap();
    assert_eq!(favorite.sort_order, 0);
    assert_eq!(nights.sort_order, 1);

    let listed = db::list_smart_folders(&conn).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|folder| folder.name.as_str())
            .collect::<Vec<_>>(),
        vec!["お気に入り", "夜の動画"]
    );
    assert_eq!(listed[0].query_json, query(""));

    db::delete_smart_folder(&conn, favorite.id).unwrap();
    let listed = db::list_smart_folders(&conn).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, nights.id);

    let error = db::delete_smart_folder(&conn, favorite.id).unwrap_err();
    assert!(matches!(error, IndexError::SmartFolderNotFound(_)));
}

#[test]
fn saving_same_name_updates_query_and_keeps_order() {
    let conn = db::open_in_memory().unwrap();
    let first = db::save_smart_folder(&conn, "絞り込み", &query("a")).unwrap();
    let second = db::save_smart_folder(&conn, "別名", &query("b")).unwrap();
    assert_eq!(second.sort_order, 1);

    // 大文字小文字を無視して同じ名前として扱う
    let updated = db::save_smart_folder(&conn, "絞り込み", &query("c")).unwrap();
    assert_eq!(updated.id, first.id);
    assert_eq!(updated.sort_order, first.sort_order);
    assert_eq!(updated.created_at, first.created_at);
    assert_eq!(updated.query_json, query("c"));

    let listed = db::list_smart_folders(&conn).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].query_json, query("c"));
}

#[test]
fn rename_changes_name_and_rejects_duplicates() {
    let conn = db::open_in_memory().unwrap();
    let first = db::save_smart_folder(&conn, "一つ目", &query("a")).unwrap();
    let second = db::save_smart_folder(&conn, "二つ目", &query("b")).unwrap();

    let renamed = db::rename_smart_folder(&conn, first.id, "  新しい名前  ").unwrap();
    assert_eq!(renamed.name, "新しい名前");

    let error = db::rename_smart_folder(&conn, second.id, "新しい名前").unwrap_err();
    assert!(matches!(error, IndexError::InvalidSmartFolder(_)));
    // 失敗しても元の名前のまま
    let listed = db::list_smart_folders(&conn).unwrap();
    assert_eq!(listed[1].name, "二つ目");
}

#[test]
fn invalid_name_and_query_are_rejected() {
    let conn = db::open_in_memory().unwrap();

    for name in ["", "   "] {
        let error = db::save_smart_folder(&conn, name, &query("a")).unwrap_err();
        assert!(matches!(error, IndexError::InvalidSmartFolder(_)));
    }

    let long_name = "あ".repeat(41);
    let error = db::save_smart_folder(&conn, &long_name, &query("a")).unwrap_err();
    assert!(matches!(error, IndexError::InvalidSmartFolder(_)));

    for broken in ["", "{oops", "[1,2,3]", "null"] {
        let error = db::save_smart_folder(&conn, "名前", broken).unwrap_err();
        assert!(
            matches!(error, IndexError::InvalidSmartFolder(_)),
            "{broken} は拒否されるべき: {error}"
        );
    }

    // 何も保存されていない
    assert!(db::list_smart_folders(&conn).unwrap().is_empty());
}
