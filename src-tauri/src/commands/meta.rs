//! 生成メタデータの取得・検索・索引（#60）。

use std::sync::atomic::Ordering;

use rusqlite::OptionalExtension;
use tauri::{AppHandle, Emitter, State};

use crate::index::db::{self, FileMetaHit, MetaIndexSummary, MetaReport};
use crate::meta::GenerationMeta;
use crate::AppState;

use super::open;

/// 1 回の `index_meta` で処理する既定件数。
const META_INDEX_BATCH: i64 = 500;

/// ファイル ID から実パスを引いて、生成情報を抽出する。
///
/// 2 回目以降は DB のキャッシュ（`meta_json` / `meta_mtime`）を返す。
/// 取得できなければ `None`（エラーにはしない）。
///
/// #73: ComfyUI 連携（workflow の保存 / `POST /prompt`）からも同じ抽出・
/// キャッシュ経路を使うため、コマンド本体と分けて公開する。
pub fn load_meta(
    conn: &rusqlite::Connection,
    file_id: i64,
) -> Result<Option<GenerationMeta>, String> {
    // キャッシュが最新ならそのまま返す（空文字 = 生成情報なし）
    if let Some((json, meta_mtime, mtime)) =
        db::cached_file_meta(conn, file_id).map_err(|error| error.to_string())?
    {
        if meta_mtime == Some(mtime) {
            if let Some(json) = json {
                if json.trim().is_empty() {
                    return Ok(None);
                }
                if let Ok(meta) = serde_json::from_str::<GenerationMeta>(&json) {
                    return Ok(Some(meta));
                }
                // 壊れたキャッシュは読み直して上書きする
            }
        }
    }

    let Some(path) = db::file_absolute_path(conn, file_id).map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let meta = crate::meta::extract(&path);
    if let Some(mtime) = conn
        .query_row("SELECT mtime FROM files WHERE id = ?1", [file_id], |row| {
            row.get::<_, i64>(0)
        })
        .optional()
        .map_err(|error| error.to_string())?
    {
        let _ = db::save_file_meta(conn, file_id, mtime, meta.as_ref());
    }
    Ok(meta)
}

#[tauri::command]
pub fn get_generation_meta(
    state: State<'_, AppState>,
    file_id: i64,
) -> Result<Option<GenerationMeta>, String> {
    let conn = open(&state)?;
    load_meta(&conn, file_id)
}

/// 生成メタデータを検索する。FTS5 が空なら `LIKE` に落ちる。
#[tauri::command]
pub fn search_meta(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<FileMetaHit>, String> {
    let conn = open(&state)?;
    db::search_meta(&conn, &query, limit.unwrap_or(100)).map_err(|error| error.to_string())
}

/// 生成メタデータの付与率（全体 + ルート別）。
#[tauri::command]
pub fn meta_report(state: State<'_, AppState>) -> Result<MetaReport, String> {
    let conn = open(&state)?;
    db::meta_report(&conn).map_err(|error| error.to_string())
}

fn run_index(
    app: &AppHandle,
    db_path: &std::path::Path,
    limit: i64,
) -> Result<MetaIndexSummary, String> {
    let conn = db::open(db_path).map_err(|error| error.to_string())?;
    let pending = db::pending_meta_files(&conn, limit).map_err(|error| error.to_string())?;
    let total = pending.len() as i64;
    let mut with_meta = 0;
    let mut failed = 0;

    for (index, item) in pending.iter().enumerate() {
        match crate::meta::extract(&item.path) {
            Some(meta) => {
                if db::save_file_meta(&conn, item.file_id, item.mtime, Some(&meta)).is_ok() {
                    with_meta += 1;
                } else {
                    failed += 1;
                }
            }
            None => {
                // 見つからなかったこともキャッシュして、次回の読み直しを避ける
                if db::save_file_meta(&conn, item.file_id, item.mtime, None).is_err() {
                    failed += 1;
                }
            }
        }

        if index % 10 == 0 || index + 1 == total as usize {
            let _ = app.emit(
                "meta://progress",
                serde_json::json!({
                    "done": index + 1,
                    "total": total,
                    "with_meta": with_meta,
                }),
            );
        }
    }

    let remaining = db::pending_meta_count(&conn).map_err(|error| error.to_string())?;
    Ok(MetaIndexSummary {
        total,
        with_meta,
        without_meta: total - with_meta - failed,
        failed,
        remaining,
    })
}

/// 未キャッシュのファイルだけ生成情報を抽出して保存する（遅延抽出のバッチ）。
///
/// 進捗は `meta://progress` で流れる。`limit` 件で打ち切るので、
/// UI は `remaining` が 0 になるまで繰り返し呼ぶ。
#[tauri::command]
pub async fn index_meta(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<MetaIndexSummary, String> {
    if state.meta_indexing.swap(true, Ordering::SeqCst) {
        return Err("生成情報の索引は既に実行中です".to_string());
    }
    let db_path = state.db_path.clone();
    let limit = limit.unwrap_or(META_INDEX_BATCH).clamp(1, 5000);
    let result =
        tauri::async_runtime::spawn_blocking(move || run_index(&app, &db_path, limit)).await;
    state.meta_indexing.store(false, Ordering::SeqCst);

    match result {
        Ok(inner) => inner,
        Err(error) => Err(format!("索引タスクが異常終了しました: {error}")),
    }
}
