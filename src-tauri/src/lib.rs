pub mod comfy;
mod commands;
pub mod config;
pub mod delete;
pub mod dupes;
pub mod exclude;
pub mod index;
pub mod media;
pub mod meta;
mod move_work;
pub mod roots;
pub mod settings;
pub mod shield;
pub mod tagsuggest;
pub mod thumbs;

use commands::AppState;
use tauri::Manager;

/// UI から IPC の疎通を確認するための最小コマンド。
#[tauri::command]
fn ping() -> String {
    "pong from Rust".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = index::db::default_db_path();
    // 起動時に一度だけ開いてスキーマを作る（失敗しても各コマンドで再試行される）
    if let Err(error) = index::db::open(&db_path) {
        eprintln!("索引 DB を初期化できませんでした: {error}");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // #22: グローバルホットキー。押下 / 離上を `shield://hotkey` で UI に流す。
        // 登録そのものは setup で config.json を読んで行う（設定変更時はコマンドで再登録）。
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    shield::handle_shortcut_event(app, event.state());
                })
                .build(),
        )
        // #5: 10GB の動画でも Range で必要な部分だけ返すメディア配信。
        // UI は `convertFileSrc(String(files.id), "wbm")` で参照する。
        .register_uri_scheme_protocol(thumbs::serve::SCHEME, |_ctx, request| {
            thumbs::serve::respond(&request)
        })
        .register_asynchronous_uri_scheme_protocol(media::SCHEME, {
            let db_path = db_path.clone();
            move |_ctx, request, responder| {
                let db_path = db_path.clone();
                std::thread::spawn(move || {
                    responder.respond(media::respond(&db_path, &request));
                });
            }
        })
        .manage(AppState::new(db_path, config::default_config_path()))
        // #67: 重複・類似の解析は 1 本だけ走らせる（キャンセルは `cancel_dupes`）。
        .manage(dupes::DupesState::default())
        // 起動時に config.json のホットキーを登録する（他アプリと衝突したら既定で再試行）
        .setup(|app| {
            let config_path = app.state::<AppState>().config_path.clone();
            let config = config::load(&config_path);
            shield::register_from_config(app.handle(), &config.shield_hotkey);
            // #7: 有効ルートのフォルダ監視を常駐させる（設定で無効化できる）
            commands::restart_watcher(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            shield::set_shield_active,
            shield::apply_shield_hotkey,
            commands::add_root,
            commands::inspect_root_paths,
            commands::root_suggestions,
            commands::list_roots,
            commands::scan_root,
            commands::cancel_scan,
            commands::list_works,
            commands::find_works,
            commands::list_tags,
            commands::create_tag,
            commands::delete_tag,
            commands::get_work_tags,
            commands::set_work_tags,
            commands::tag_suggestions,
            commands::get_work_mark,
            commands::set_work_mark,
            commands::record_open,
            commands::list_files,
            commands::get_work,
            commands::get_work_summary,
            commands::get_work_files,
            commands::save_file_position,
            commands::get_file_position,
            commands::clear_file_position,
            commands::reveal_file,
            commands::reveal_work,
            commands::library_stats,
            commands::search_files,
            commands::load_config,
            commands::save_config,
            commands::get_settings,
            commands::update_settings,
            commands::clear_thumb_cache,
            commands::ffmpeg_probe,
            commands::update_root,
            commands::delete_root,
            commands::generate_thumbs,
            commands::meta::get_generation_meta,
            commands::meta::search_meta,
            commands::meta::meta_report,
            commands::meta::index_meta,
            // #69: スマートフォルダ（保存検索）
            commands::smart::list_smart_folders,
            commands::smart::save_smart_folder,
            commands::smart::rename_smart_folder,
            commands::smart::delete_smart_folder,
            // #73: ComfyUI 連携
            comfy::comfy_check,
            comfy::comfy_open,
            comfy::comfy_queue_prompt,
            commands::thumb_queue_size,
            commands::thumb_status,
            commands::cancel_thumbs,
            commands::update_thumb_settings,
            commands::reset_thumbs,
            commands::work_file_ids,
            commands::delete_files,
            commands::cancel_delete,
            commands::undo_delete,
            move_work::inspect_move,
            move_work::move_work,
            move_work::cancel_move,
            move_work::undo_move,
            commands::watch_status,
            commands::watch_pending,
            commands::clear_watch_pending,
            // #67: 重複・類似画像の検出
            dupes::dupes_stats,
            dupes::dupes_groups,
            dupes::dupes_analyze,
            dupes::cancel_dupes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
