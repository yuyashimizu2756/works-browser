//! スマートフォルダ（保存検索、#69）。
//!
//! 現在の絞り込み条件を名前付きで保存し、サイドバーから適用する。
//! 条件そのものは UI が組み立てた JSON をそのまま持ち、件数は既存の
//! `find_works` / `find_files` の `total` を使う（新しい集計はしない）。

use tauri::State;

use crate::index::db::{self, SmartFolder};
use crate::AppState;

use super::open;

/// 保存したスマートフォルダの一覧（並び順 → id 順）。
#[tauri::command]
pub fn list_smart_folders(state: State<'_, AppState>) -> Result<Vec<SmartFolder>, String> {
    let conn = open(&state)?;
    db::list_smart_folders(&conn).map_err(|error| error.to_string())
}

/// 現在の条件を `name` で保存する。同じ名前があれば条件だけ更新する。
#[tauri::command]
pub fn save_smart_folder(
    state: State<'_, AppState>,
    name: String,
    query_json: String,
) -> Result<SmartFolder, String> {
    let conn = open(&state)?;
    db::save_smart_folder(&conn, &name, &query_json).map_err(|error| error.to_string())
}

/// 名前を変える（他のスマートフォルダと同じ名前は不可）。
#[tauri::command]
pub fn rename_smart_folder(
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<SmartFolder, String> {
    let conn = open(&state)?;
    db::rename_smart_folder(&conn, id, &name).map_err(|error| error.to_string())
}

/// スマートフォルダを消す（作品・ファイルには触れない）。
#[tauri::command]
pub fn delete_smart_folder(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = open(&state)?;
    db::delete_smart_folder(&conn, id).map_err(|error| error.to_string())
}
