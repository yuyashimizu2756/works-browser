//! Tauri コマンド（IPC の入口）。
//!
//! 走査は `spawn_blocking` に逃がし、進捗は `scan://progress` / `scan://done`
//! イベントで UI に流す。

pub mod meta;
pub mod smart;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{self, AppConfig};
use crate::delete::{self, DeleteOptions, DeleteResult, UndoBatch, UndoResult};
use crate::index::db::{
    self, FileEntry, FileFilter, FilePage, FilePosition, LibraryStats, Root, RootInfo, Tag,
    WorkDetail, WorkFilter, WorkInfo, WorkMark, WorkPage, WorkSummary,
};
use crate::index::scan::{self, ScanConfig, ScanSummary};
use crate::index::watch::{
    self, WatchChanged, WatchPending, WatchRootStatus, WatchService, WatchSettings, WatchStatus,
};
use crate::index::IndexError;
use crate::move_work::MoveUndoBatch;
use crate::roots::{self, PathCheck, RootSuggestions};
use crate::settings::{self, FfmpegProbe, Settings, SettingsPatch};
use crate::thumbs::{
    self, CacheUsage, GenerateOptions, ThumbQueueStats, ThumbSettings, ThumbSettingsUpdate,
    ThumbSummary,
};

/// アプリ全体で共有する索引の状態。
pub struct AppState {
    /// 索引 DB のパス。
    pub db_path: PathBuf,
    /// 表示設定（`config.json`）のパス。
    pub config_path: PathBuf,
    /// 実行中の走査のキャンセルフラグ。
    pub cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 同時走査の防止。
    pub scanning: AtomicBool,
    /// 実行中のサムネイル生成のキャンセルフラグ。
    pub thumb_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// 同時生成の防止。
    pub generating: AtomicBool,
    /// #15: 実行中の削除のキャンセルフラグ。
    pub delete_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// #15: 二重実行の防止。
    pub deleting: AtomicBool,
    /// #15: 直近のゴミ箱移動（Undo 用）。次の削除で置き換わる。
    pub pending_undo: Mutex<Option<UndoBatch>>,
    /// #57: 実行中の移動のキャンセルフラグ。
    pub move_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// #57: 二重実行の防止。
    pub moving: AtomicBool,
    /// #57: 直近の同一ボリューム移動（5 秒間の Undo 用）。次の移動で置き換わる。
    pub pending_move_undo: Mutex<Option<MoveUndoBatch>>,
    /// #7: 常駐のフォルダ監視。設定変更・ルート追加で差し替える。
    pub watcher: Mutex<Option<WatchService>>,
    /// #63: ルート別の新着件数（監視で増えた分。メモリのみ・永続化しない）。
    pub watch_pending: Mutex<watch::PendingMap>,
    /// #60: 生成メタデータの索引（`index_meta`）の二重実行防止。
    pub meta_indexing: AtomicBool,
}

impl AppState {
    pub fn new(db_path: PathBuf, config_path: PathBuf) -> Self {
        Self {
            db_path,
            config_path,
            cancel: Mutex::new(None),
            scanning: AtomicBool::new(false),
            thumb_cancel: Mutex::new(None),
            generating: AtomicBool::new(false),
            delete_cancel: Mutex::new(None),
            deleting: AtomicBool::new(false),
            pending_undo: Mutex::new(None),
            move_cancel: Mutex::new(None),
            moving: AtomicBool::new(false),
            pending_move_undo: Mutex::new(None),
            watcher: Mutex::new(None),
            watch_pending: Mutex::new(watch::PendingMap::new()),
            meta_indexing: AtomicBool::new(false),
        }
    }
}

fn error_message(error: &IndexError) -> String {
    error.to_string()
}

fn open(state: &State<'_, AppState>) -> Result<Connection, String> {
    db::open(&state.db_path).map_err(|error| error_message(&error))
}

/// 走査ルートを追加する（同じパスなら深さを更新）。
///
/// 追加に成功したら「最近追加したフォルダ」（最大 10 件）も更新する。
#[tauri::command]
pub fn add_root(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    depth: Option<i64>,
) -> Result<Root, String> {
    let depth = depth.unwrap_or(1);
    let conn = open(&state)?;
    let root = roots::add_root(&conn, &path, depth).map_err(|error| error_message(&error))?;
    // #7: 追加直後から監視を始める（スキャン前後のイベントも取りこぼさない）
    restart_watcher(&app);
    Ok(root)
}

/// フォルダ選択ダイアログ / ドラッグ&ドロップで受け取ったパスを追加前に検証する（#25）。
///
/// 存在・フォルダか・読み取り権限・ドライブ直下 / システムフォルダ・
/// 同一実体の重複を返す。UI は警告を出して確認してから [`add_root`] を呼ぶ。
#[tauri::command]
pub fn inspect_root_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<PathCheck>, String> {
    let conn = open(&state)?;
    Ok(roots::inspect_paths(&conn, &paths))
}

/// ルート追加の候補（最近追加したフォルダ・ドライブ・既知のフォルダ）を返す（#25）。
#[tauri::command]
pub fn root_suggestions(state: State<'_, AppState>) -> Result<RootSuggestions, String> {
    let conn = open(&state)?;
    Ok(roots::suggestions(&conn))
}

/// 登録済みルートの一覧（作品数・ファイル数付き）。
#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Result<Vec<RootInfo>, String> {
    let conn = open(&state)?;
    db::list_roots(&conn).map_err(|error| error_message(&error))
}

/// ルートを走査する。完了まで待ち、結果を返す（進捗はイベントで流れる）。
#[tauri::command]
pub async fn scan_root(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: i64,
) -> Result<ScanSummary, String> {
    if state.scanning.swap(true, Ordering::SeqCst) {
        return Err(IndexError::AlreadyScanning.to_string());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state
            .cancel
            .lock()
            .map_err(|_| "走査状態のロックに失敗しました".to_string())?;
        *slot = Some(Arc::clone(&cancel));
    }

    let db_path = state.db_path.clone();
    let config_path = state.config_path.clone();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_scan(&handle, &db_path, &config_path, root_id, &cancel)
    })
    .await;

    state.scanning.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = state.cancel.lock() {
        *slot = None;
    }

    match result {
        Ok(inner) => inner,
        Err(error) => Err(format!("走査タスクが異常終了しました: {error}")),
    }
}

fn run_scan(
    app: &AppHandle,
    db_path: &std::path::Path,
    config_path: &std::path::Path,
    root_id: i64,
    cancel: &AtomicBool,
) -> Result<ScanSummary, String> {
    let mut conn = db::open(db_path).map_err(|error| error_message(&error))?;
    let root = db::get_root(&conn, root_id).map_err(|error| error_message(&error))?;

    // #8: 除外パターンは設定画面の変更を次の走査からそのまま使う。
    // #39: `.ts` を MPEG-TS として索引するかも設定で決める。
    let config = ScanConfig {
        exclude_patterns: config::load(config_path).exclude_patterns,
        index_mpeg_ts: config::load(config_path).index_mpeg_ts,
        ..ScanConfig::default()
    };
    let summary = scan::scan_root(&mut conn, &root, cancel, &config, &mut |progress| {
        let _ = app.emit("scan://progress", progress);
    })
    .map_err(|error| error_message(&error))?;

    let _ = app.emit("scan://done", &summary);
    Ok(summary)
}

/// 実行中の走査をキャンセルする。キャンセル要求を出せたら `true`。
#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) -> Result<bool, String> {
    let slot = state
        .cancel
        .lock()
        .map_err(|_| "走査状態のロックに失敗しました".to_string())?;
    Ok(match slot.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

/// 作品一覧（並び順: `mtime` | `title` | `size` | `files` | `last_opened` | `open_count`）。
///
/// `tag_id` / `favorite` / `min_rating` でタグ・お気に入り・評価の絞り込みができる（#6）。
#[tauri::command]
pub fn list_works(
    state: State<'_, AppState>,
    limit: Option<i64>,
    offset: Option<i64>,
    sort: Option<String>,
    tag_id: Option<i64>,
    favorite: Option<bool>,
    min_rating: Option<i64>,
) -> Result<Vec<WorkSummary>, String> {
    let filter = WorkFilter {
        tag_id,
        favorite,
        min_rating,
        sort: sort.unwrap_or_else(|| "mtime".to_string()),
        limit: limit.unwrap_or(50).clamp(1, 1000),
        offset: offset.unwrap_or(0).max(0),
        ..Default::default()
    };
    let conn = open(&state)?;
    db::find_works(&conn, &filter)
        .map(|page| page.works)
        .map_err(|error| error_message(&error))
}

/// 作品一覧の検索・絞り込み・ページング（ライブラリ画面のグリッド用）。
///
/// `search` はタイトルと作品パスの部分一致、`kind` は `video`（動画あり）/
/// `image`（画像のみ）、`root_id` はルート絞り込み。`tag_id` / `favorite` /
/// `min_rating` は #6 のタグ・お気に入り・評価の絞り込み。`total` は仮想スクロールの
/// 行数計算に使う。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn find_works(
    state: State<'_, AppState>,
    limit: Option<i64>,
    offset: Option<i64>,
    after_id: Option<i64>,
    sort: Option<String>,
    search: Option<String>,
    kind: Option<String>,
    root_id: Option<i64>,
    tag_id: Option<i64>,
    favorite: Option<bool>,
    min_rating: Option<i64>,
    dir: Option<String>,
    meta_query: Option<String>,
) -> Result<WorkPage, String> {
    let filter = WorkFilter {
        search,
        kind,
        root_id,
        tag_id,
        favorite,
        min_rating,
        meta_query: meta_query.filter(|value| !value.trim().is_empty()),
        sort: sort.unwrap_or_else(|| "mtime".to_string()),
        dir,
        limit: limit.unwrap_or(100).clamp(1, 1000),
        offset: offset.unwrap_or(0).max(0),
        after_id,
    };
    let conn = open(&state)?;
    db::find_works(&conn, &filter).map_err(|error| error_message(&error))
}

// ---------------------------------------------------------------------------
// タグ・評価・開封回数（#6）
// ---------------------------------------------------------------------------

/// タグの一覧（名前順・作品数付き）。
#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    let conn = open(&state)?;
    db::list_tags(&conn).map_err(|error| error_message(&error))
}

/// タグを作る。同じ名前があれば色だけ更新して既存を返す。
#[tauri::command]
pub fn create_tag(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<Tag, String> {
    let conn = open(&state)?;
    db::create_tag(&conn, &name, color.as_deref()).map_err(|error| error_message(&error))
}

/// タグを消す（付与も一緒に消える）。
#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, tag_id: i64) -> Result<(), String> {
    let conn = open(&state)?;
    db::delete_tag(&conn, tag_id).map_err(|error| error_message(&error))
}

/// 作品に付いているタグ。
#[tauri::command]
pub fn get_work_tags(state: State<'_, AppState>, work_id: i64) -> Result<Vec<Tag>, String> {
    let conn = open(&state)?;
    db::get_work_tags(&conn, work_id).map_err(|error| error_message(&error))
}

/// 作品のタグを丸ごと差し替える（空配列で全解除）。
#[tauri::command]
pub fn set_work_tags(
    state: State<'_, AppState>,
    work_id: i64,
    tag_ids: Vec<i64>,
) -> Result<Vec<Tag>, String> {
    let conn = open(&state)?;
    db::set_work_tags(&conn, work_id, &tag_ids).map_err(|error| error_message(&error))
}

/// 生成情報の頻出語からタグ候補（#79）。件数はその語を含むファイル数。
#[tauri::command]
pub fn tag_suggestions(
    state: State<'_, AppState>,
    work_id: i64,
    limit: Option<i64>,
) -> Result<Vec<crate::tagsuggest::TagSuggestion>, String> {
    let conn = open(&state)?;
    db::tag_suggestions(&conn, work_id, limit.unwrap_or(20)).map_err(|error| error_message(&error))
}

/// お気に入り・評価・メモ。未設定なら全 false / 未評価 / 0 回を返す。
#[tauri::command]
pub fn get_work_mark(state: State<'_, AppState>, work_id: i64) -> Result<WorkMark, String> {
    let conn = open(&state)?;
    db::get_work_mark(&conn, work_id).map_err(|error| error_message(&error))
}

/// お気に入り・評価（1〜5・`null` で解除）・メモを保存する。
#[tauri::command]
pub fn set_work_mark(
    state: State<'_, AppState>,
    work_id: i64,
    favorite: Option<bool>,
    rating: Option<i64>,
    note: Option<String>,
) -> Result<WorkMark, String> {
    let conn = open(&state)?;
    db::set_work_mark(&conn, work_id, favorite.unwrap_or(false), rating, note)
        .map_err(|error| error_message(&error))
}

/// 作品詳細を開いたことを記録する（`open_count += 1` / `last_opened_at` 更新）。
#[tauri::command]
pub fn record_open(state: State<'_, AppState>, work_id: i64) -> Result<WorkMark, String> {
    let conn = open(&state)?;
    db::record_open(&conn, work_id).map_err(|error| error_message(&error))
}

/// ファイル一覧（作品をまたいで `files` を直接ページングする）。#21 のファイルモード。
///
/// `sort` は `mtime` | `name` | `size` | `duration`、`kind` は `video` / `image`、
/// `root_id` はルート絞り込み、`query` はファイル名 / 相対パスの部分一致。
/// `total` は仮想スクロールの行数計算に使う。
///
/// #50: `after_id`（直前ページの最後の `id`）を渡すとキーセット・ページングになる。
/// 深いページでも `OFFSET` のように先頭から読み飛ばさない（`offset` は互換のため残す）。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn list_files(
    state: State<'_, AppState>,
    limit: Option<i64>,
    offset: Option<i64>,
    after_id: Option<i64>,
    sort: Option<String>,
    kind: Option<String>,
    root_id: Option<i64>,
    query: Option<String>,
    dir: Option<String>,
    meta_query: Option<String>,
) -> Result<FilePage, String> {
    let filter = FileFilter {
        search: query,
        kind: kind.filter(|value| !value.trim().is_empty()),
        root_id,
        work_id: None,
        meta_query: meta_query.filter(|value| !value.trim().is_empty()),
        sort: sort.unwrap_or_else(|| "mtime".to_string()),
        dir,
        limit: limit.unwrap_or(600).clamp(1, 1000),
        offset: offset.unwrap_or(0).max(0),
        after_id,
    };
    let conn = open(&state)?;
    db::find_files(&conn, &filter).map_err(|error| error_message(&error))
}

/// 表示モードとサムネ表示トグル（#21）。`config.json` から読む。
#[tauri::command]
pub fn load_config(state: State<'_, AppState>) -> AppConfig {
    config::load(&state.config_path)
}

/// 表示設定を `config.json` に保存する（次回起動時に復元する）。
///
/// UI は表示・シールドの項目だけを送るため、送られてこなかった項目
/// （`index_mpeg_ts` など）は既存の値を保つ（[`config::merge`]）。
#[tauri::command]
pub fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: serde_json::Value,
) -> Result<AppConfig, String> {
    let previous = config::load(&state.config_path);
    let normalized = crate::config::merge(&previous, &config);
    let watch_changed = previous.watch_enabled != normalized.watch_enabled
        || previous.watch_exclude != normalized.watch_exclude
        || previous.watch_network_drives != normalized.watch_network_drives;
    config::save(&state.config_path, &normalized)
        .map_err(|error| format!("設定を保存できません: {error}"))?;
    // #7: 監視に関わる項目が変わったときだけ再起動する（表示設定の保存で
    // 監視を切らない）。有効 / 無効・除外 glob の変更は即時反映する。
    if watch_changed {
        restart_watcher(&app);
    }
    Ok(normalized)
}

// ---------------------------------------------------------------------------
// フォルダ監視（#7）
// ---------------------------------------------------------------------------

/// 設定に従って監視を（再）開始する。無効なら既存の監視を止めるだけ。
pub(crate) fn restart_watcher(app: &AppHandle) {
    let state = app.state::<AppState>();
    let config = config::load(&state.config_path);
    let settings = WatchSettings::from_config(&config);

    let db_path = state.db_path.clone();
    let handle = app.clone();
    let handler: watch::ChangeHandler = Arc::new(move |change: WatchChanged| {
        // #63: ルート別の累計をメモリに足す（永続化しない）。
        if let Ok(mut map) = handle.state::<AppState>().watch_pending.lock() {
            watch::record_pending(&mut map, change.root_id, change.added, change.removed);
        }
        // UI はこのイベントで一覧を取り直す（ペイロードの件数は目安）
        let _ = handle.emit("watch://changed", change);
    });

    let service = match WatchService::start(&db_path, &settings, handler) {
        Ok(service) => service,
        Err(error) => {
            eprintln!("フォルダ監視を開始できませんでした: {error}");
            None
        }
    };

    // 旧監視はここで drop され、デバウンススレッドも止まる
    let slot = state.watcher.lock();
    if let Ok(mut slot) = slot {
        *slot = service;
    }
}

/// 監視状態。`enabled` は設定、`roots` は実際に監視できているルート。
#[tauri::command]
pub fn watch_status(state: State<'_, AppState>) -> Result<WatchStatus, String> {
    let live = match state.watcher.lock() {
        Ok(slot) => slot.as_ref().map(|service| service.status()),
        Err(_) => None,
    };
    if let Some(status) = live {
        return Ok(status);
    }

    // 監視が無効・開始前でも「対象になるルート」を返す（UI の表示用）
    let config = config::load(&state.config_path);
    let conn = open(&state)?;
    let roots = db::list_roots(&conn).map_err(|error| error_message(&error))?;
    Ok(WatchStatus {
        enabled: config.watch_enabled,
        roots: roots
            .into_iter()
            .filter(|info| info.root.enabled && info.root.duplicate_of.is_none())
            .map(|info| WatchRootStatus {
                root_id: info.root.id,
                enabled: false,
                path: info.root.real_path,
            })
            .collect(),
    })
}

/// ルート別の新着件数（#63）。監視で増えた分の累計を返す（メモリのみ）。
#[tauri::command]
pub fn watch_pending(state: State<'_, AppState>) -> Result<Vec<WatchPending>, String> {
    let map = state
        .watch_pending
        .lock()
        .map_err(|_| "新着件数のロックに失敗しました".to_string())?;
    Ok(watch::pending_list(&map))
}

/// ルートを開いたときに新着バッジを消す（#63）。
#[tauri::command]
pub fn clear_watch_pending(state: State<'_, AppState>, root_id: i64) -> Result<(), String> {
    let mut map = state
        .watch_pending
        .lock()
        .map_err(|_| "新着件数のロックに失敗しました".to_string())?;
    watch::clear_pending(&mut map, root_id);
    Ok(())
}

/// 作品 1 件とファイル一覧。
#[tauri::command]
pub fn get_work(state: State<'_, AppState>, work_id: i64) -> Result<WorkDetail, String> {
    let conn = open(&state)?;
    db::get_work(&conn, work_id)
        .map_err(|error| error_message(&error))?
        .ok_or_else(|| format!("作品 {work_id} が見つかりません"))
}

/// 作品 1 件のヘッダ情報（ファイル一覧なし）。作品詳細の初回描画用（#5）。
#[tauri::command]
pub fn get_work_summary(state: State<'_, AppState>, work_id: i64) -> Result<WorkInfo, String> {
    let conn = open(&state)?;
    db::get_work_info(&conn, work_id)
        .map_err(|error| error_message(&error))?
        .ok_or_else(|| format!("作品 {work_id} が見つかりません"))
}

/// 作品内のファイル一覧（#5 の作品詳細ギャラリー）。
///
/// `list_files` と同じ絞り込み・並び順を受けるが、`work_id` で作品 1 件に固定する。
/// UI は 300 件ずつ読み、仮想スクロールで 1,000 ファイルでも軽く動かす。
/// `get_work_files` は `list_files` と同じ絞り込みを受けるため引数が多い。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn get_work_files(
    state: State<'_, AppState>,
    work_id: i64,
    limit: Option<i64>,
    offset: Option<i64>,
    sort: Option<String>,
    kind: Option<String>,
    query: Option<String>,
    meta_query: Option<String>,
) -> Result<FilePage, String> {
    let filter = FileFilter {
        search: query,
        kind: kind.filter(|value| !value.trim().is_empty()),
        root_id: None,
        work_id: Some(work_id),
        meta_query: meta_query.filter(|value| !value.trim().is_empty()),
        sort: sort.unwrap_or_else(|| "name".to_string()),
        dir: None,
        limit: limit.unwrap_or(300).clamp(1, 1000),
        offset: offset.unwrap_or(0).max(0),
        after_id: None,
    };
    let conn = open(&state)?;
    db::find_files(&conn, &filter).map_err(|error| error_message(&error))
}

/// 動画の再生位置を保存する（#5）。UI は再生中 5 秒ごと / 一時停止 / 閉じる時に呼ぶ。
#[tauri::command]
pub fn save_file_position(
    state: State<'_, AppState>,
    file_id: i64,
    position_ms: i64,
    duration_ms: Option<i64>,
) -> Result<(), String> {
    let conn = open(&state)?;
    db::save_file_position(&conn, file_id, position_ms.max(0), duration_ms)
        .map_err(|error| error_message(&error))
}

/// 保存済みの再生位置を返す（#5）。未保存なら `null`。
#[tauri::command]
pub fn get_file_position(
    state: State<'_, AppState>,
    file_id: i64,
) -> Result<Option<FilePosition>, String> {
    let conn = open(&state)?;
    db::get_file_position(&conn, file_id).map_err(|error| error_message(&error))
}

/// 再生位置を消す（「最初から再生」）。
#[tauri::command]
pub fn clear_file_position(state: State<'_, AppState>, file_id: i64) -> Result<(), String> {
    let conn = open(&state)?;
    db::clear_file_position(&conn, file_id).map_err(|error| error_message(&error))
}

/// エクスプローラでファイルを選択して開く（#5）。UI からはパスではなく ID を渡す。
#[tauri::command]
pub fn reveal_file(state: State<'_, AppState>, file_id: i64) -> Result<(), String> {
    let conn = open(&state)?;
    let path = db::file_absolute_path(&conn, file_id)
        .map_err(|error| error_message(&error))?
        .ok_or_else(|| format!("ファイル {file_id} が見つかりません"))?;
    reveal::select(&path)
}

/// エクスプローラで作品フォルダを開く（#5）。
#[tauri::command]
pub fn reveal_work(state: State<'_, AppState>, work_id: i64) -> Result<(), String> {
    let conn = open(&state)?;
    let path = db::work_absolute_path(&conn, work_id)
        .map_err(|error| error_message(&error))?
        .ok_or_else(|| format!("作品 {work_id} が見つかりません"))?;
    reveal::open(&path)
}

/// Windows のエクスプローラ操作。`tauri-plugin-opener` を足さずに済ませる。
pub(crate) mod reveal {
    use std::path::Path;
    use std::process::Command;

    /// フォルダを開く。
    #[cfg(windows)]
    pub fn open(path: &Path) -> Result<(), String> {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("エクスプローラを開けません: {error}"))
    }

    /// 親フォルダを開いてファイルを選択状態にする。
    #[cfg(windows)]
    pub fn select(path: &Path) -> Result<(), String> {
        Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("エクスプローラを開けません: {error}"))
    }

    /// #73: 既定のブラウザで URL を開く（`explorer <url>`）。
    ///
    /// 開くのは設定から組み立てた `http` / `https` の URL だけで、
    /// UI から任意の文字列を受け取らない。
    #[cfg(windows)]
    pub fn open_url(url: &str) -> Result<(), String> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("開けるのは http / https の URL だけです".to_string());
        }
        Command::new("explorer")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("ブラウザを開けません: {error}"))
    }

    #[cfg(not(windows))]
    pub fn open(_path: &Path) -> Result<(), String> {
        Err("エクスプローラは Windows 専用です".to_string())
    }

    #[cfg(not(windows))]
    pub fn select(_path: &Path) -> Result<(), String> {
        Err("エクスプローラは Windows 専用です".to_string())
    }

    #[cfg(not(windows))]
    pub fn open_url(_url: &str) -> Result<(), String> {
        Err("ブラウザを開く操作は Windows 専用です".to_string())
    }
}

/// ライブラリ全体の集計。
#[tauri::command]
pub fn library_stats(state: State<'_, AppState>) -> Result<LibraryStats, String> {
    let conn = open(&state)?;
    db::library_stats(&conn).map_err(|error| error_message(&error))
}

/// ファイル名検索（FTS5）。UI の検索欄から使う。
#[tauri::command]
pub fn search_files(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<FileEntry>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let conn = open(&state)?;
    db::search_files(&conn, trimmed, limit.unwrap_or(100)).map_err(|error| error_message(&error))
}

// ---------------------------------------------------------------------------
// サムネイル（#3）
// ---------------------------------------------------------------------------

fn thumb_error(error: &thumbs::ThumbError) -> String {
    error.to_string()
}

/// 未生成のサムネイルを `limit` 枚まで生成する。
///
/// 生成中は `thumbs://progress`（done / total）を流す。UI はスクロールで
/// 必要になった分だけ呼べばよい（遅延生成）。`force = true` で作り直し。
#[tauri::command]
pub async fn generate_thumbs(
    app: AppHandle,
    state: State<'_, AppState>,
    limit: Option<i64>,
    force: Option<bool>,
) -> Result<ThumbSummary, String> {
    if state.generating.swap(true, Ordering::SeqCst) {
        return Err("サムネイル生成は既に実行中です".to_string());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state
            .thumb_cancel
            .lock()
            .map_err(|_| "サムネイル状態のロックに失敗しました".to_string())?;
        *slot = Some(Arc::clone(&cancel));
    }

    let db_path = state.db_path.clone();
    let config_path = state.config_path.clone();
    let handle = app.clone();
    let options = GenerateOptions {
        limit: limit.unwrap_or(500).clamp(1, 5000) as usize,
        force: force.unwrap_or(false),
    };
    // #21: サムネ非表示中は `generate` が早期に戻り、キャッシュへ書き込まない
    let visible = config::load(&state.config_path).thumbnails_visible;

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_thumbs(&handle, &db_path, &config_path, &options, visible, &cancel)
    })
    .await;

    state.generating.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = state.thumb_cancel.lock() {
        *slot = None;
    }

    match result {
        Ok(inner) => inner,
        Err(error) => Err(format!("サムネイル生成タスクが異常終了しました: {error}")),
    }
}

fn run_thumbs(
    app: &AppHandle,
    db_path: &std::path::Path,
    config_path: &std::path::Path,
    options: &GenerateOptions,
    visible: bool,
    cancel: &AtomicBool,
) -> Result<ThumbSummary, String> {
    let conn = db::open(db_path).map_err(|error| error_message(&error))?;
    // #8: 品質・ffmpeg は config.json を正とする。
    let app_config = config::load(config_path);
    let config = settings::effective_thumb_config(&conn, &app_config)?;
    let shared = Mutex::new(conn);

    let summary = thumbs::generate(
        &shared,
        &config,
        visible,
        cancel,
        options,
        &mut |progress| {
            let _ = app.emit("thumbs://progress", progress);
        },
    )
    .map_err(|error| thumb_error(&error))?;

    // #8: 生成後にキャッシュ上限を超えていたら古い順に削る。
    if let Ok(prune_conn) = db::open(db_path) {
        if let Err(error) = thumbs::prune_cache(
            &prune_conn,
            &config.cache_dir,
            app_config.thumb_cache_limit_bytes(),
        ) {
            eprintln!("サムネイルキャッシュを整理できませんでした: {error}");
        }
    }

    Ok(summary)
}

/// サムネイル生成待ちの件数。
#[tauri::command]
pub fn thumb_queue_size(state: State<'_, AppState>) -> Result<u64, String> {
    let conn = open(&state)?;
    thumbs::pending_count(&conn).map_err(|error| thumb_error(&error))
}

/// サムネイルの状態（残り・生成済み・設定・ffmpeg の場所）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ThumbStatus {
    pub queue: ThumbQueueStats,
    pub settings: ThumbSettings,
    pub generating: bool,
}

#[tauri::command]
pub fn thumb_status(state: State<'_, AppState>) -> Result<ThumbStatus, String> {
    let conn = open(&state)?;
    let queue = thumbs::queue_stats(&conn).map_err(|error| thumb_error(&error))?;
    // #8: 設定画面と同じ実効値（config.json 優先）を返す。
    let app_config = config::load(&state.config_path);
    let settings = settings::effective_thumb_config(&conn, &app_config)?.settings();

    Ok(ThumbStatus {
        queue,
        settings,
        generating: state.generating.load(Ordering::SeqCst),
    })
}

/// 実行中のサムネイル生成をキャンセルする。要求を出せたら `true`。
#[tauri::command]
pub fn cancel_thumbs(state: State<'_, AppState>) -> Result<bool, String> {
    let slot = state
        .thumb_cancel
        .lock()
        .map_err(|_| "サムネイル状態のロックに失敗しました".to_string())?;
    Ok(match slot.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

/// サムネイル設定（品質・長辺・並列数・ffmpeg パス）を保存する。
#[tauri::command]
pub fn update_thumb_settings(
    state: State<'_, AppState>,
    settings: ThumbSettingsUpdate,
) -> Result<ThumbSettings, String> {
    let conn = open(&state)?;
    let next = thumbs::update_settings(&conn, &settings).map_err(|error| thumb_error(&error))?;
    // #8: 設定画面と同じ `config.json` にも写して、次に開いたときに揃うようにする。
    let mut app = config::load(&state.config_path);
    if let Some(quality) = settings.quality {
        app.thumb_quality = quality;
    }
    if let Some(path) = &settings.ffmpeg_path {
        app.ffmpeg_path = path.clone();
    }
    config::save(&state.config_path, &app)
        .map_err(|error| format!("設定を保存できません: {error}"))?;
    Ok(next)
}

// ---------------------------------------------------------------------------
// 設定画面（#8）
// ---------------------------------------------------------------------------

/// 設定画面の初期表示（`config.json` + ルート一覧 + サムネイル + ffmpeg）。
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = open(&state)?;
    settings::get(&conn, &state.config_path)
}

/// 設定の差分を保存して、更新後の内容を返す。
///
/// 走査の除外パターンは次の走査から、ルートの有効 / 無効は即時に反映される。
#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let conn = open(&state)?;
    settings::update(&conn, &state.config_path, &patch)
}

/// サムネイルキャッシュを削除した結果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ClearThumbCacheResult {
    /// 削除したファイル数。
    pub removed: u64,
    /// 解放したバイト数。
    pub freed_bytes: u64,
    /// 削除後の使用量。
    pub cache: CacheUsage,
}

/// サムネイルキャッシュを削除する（DB の参照も外し、次回に作り直す）。
#[tauri::command]
pub fn clear_thumb_cache(state: State<'_, AppState>) -> Result<ClearThumbCacheResult, String> {
    let conn = open(&state)?;
    let app = config::load(&state.config_path);
    let thumb_config = settings::effective_thumb_config(&conn, &app)?;
    let (removed, freed_bytes) =
        thumbs::clear_cache(&conn, &thumb_config.cache_dir).map_err(|error| thumb_error(&error))?;
    Ok(ClearThumbCacheResult {
        removed,
        freed_bytes,
        cache: thumbs::cache_usage(&thumb_config.cache_dir, app.thumb_cache_limit_bytes()),
    })
}

/// ffmpeg を確認する。`path` を渡すとそのパスだけ、省略すると自動検出。
#[tauri::command]
pub fn ffmpeg_probe(_state: State<'_, AppState>, path: Option<String>) -> FfmpegProbe {
    settings::probe(path.as_deref())
}

/// ルートの深さ・有効 / 無効を更新する（#8）。
#[tauri::command]
pub fn update_root(
    state: State<'_, AppState>,
    root_id: i64,
    depth: Option<i64>,
    enabled: Option<bool>,
) -> Result<Root, String> {
    let conn = open(&state)?;
    db::update_root(&conn, root_id, depth, enabled, None).map_err(|error| error_message(&error))
}

/// ルートを削除する（作品・ファイル・走査履歴も消える。#8）。
#[tauri::command]
pub fn delete_root(state: State<'_, AppState>, root_id: i64) -> Result<(), String> {
    let conn = open(&state)?;
    db::delete_root(&conn, root_id).map_err(|error| error_message(&error))?;
    // #63: 消したルートの新着バッジも残さない
    if let Ok(mut map) = state.watch_pending.lock() {
        watch::clear_pending(&mut map, root_id);
    }
    Ok(())
}

/// キャッシュ状態を捨てて、次の `generate_thumbs` で作り直せるようにする。
///
/// `delete_files = true`（既定）ならキャッシュ先の WebP も削除する。
#[tauri::command]
pub fn reset_thumbs(state: State<'_, AppState>, delete_files: Option<bool>) -> Result<u64, String> {
    let conn = open(&state)?;
    let cache_dir = thumbs::default_cache_dir();
    thumbs::reset(&conn, &cache_dir, delete_files.unwrap_or(true))
        .map_err(|error| thumb_error(&error))
}

// ---------------------------------------------------------------------------
// 削除（#15）
// ---------------------------------------------------------------------------

/// 作品 id から削除対象のファイル id を引く（UI は作品 id だけを渡す）。
///
/// 返るのは索引済みの `files.id` だけで、パスは受け取らない。
#[tauri::command]
pub fn work_file_ids(state: State<'_, AppState>, work_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    let conn = open(&state)?;
    db::work_file_ids(&conn, &work_ids).map_err(|error| error_message(&error))
}

/// 選択したファイルを削除する。
///
/// 既定はゴミ箱へ移動（Windows は IFileOperation）。`permanent = true` で恒久削除。
/// 1 件ごとに `delete://progress`（done / total）を流し、`cancel_delete` で止められる。
/// 成功分は DB とサムネイルキャッシュからも消し、失敗分は理由付きで返す。
#[tauri::command]
pub async fn delete_files(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    permanent: Option<bool>,
) -> Result<DeleteResult, String> {
    let ids = db::unique_ids(&ids);
    if ids.is_empty() {
        return Err("削除するファイルが選択されていません".to_string());
    }
    if state.deleting.swap(true, Ordering::SeqCst) {
        return Err("削除は既に実行中です".to_string());
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = state
            .delete_cancel
            .lock()
            .map_err(|_| "削除状態のロックに失敗しました".to_string())?;
        *slot = Some(Arc::clone(&cancel));
    }

    let db_path = state.db_path.clone();
    let cache_dir = thumbs::default_cache_dir();
    let permanent = permanent.unwrap_or(false);
    // ゴミ箱の項目は秒単位なので、削除開始秒以降のものだけを Undo の対象にする。
    let started_at = db::now_ms() / 1_000;
    let handle = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db::open(&db_path).map_err(|error| error_message(&error))?;
        let outcome = delete::delete(
            &mut conn,
            &ids,
            &DeleteOptions {
                permanent,
                cache_dir: &cache_dir,
                cancel: &cancel,
            },
            &mut |progress| {
                let _ = handle.emit("delete://progress", progress);
            },
        )
        .map_err(|error| error_message(&error))?;

        let mut outcome = outcome;
        let items = if !permanent && !outcome.trashed_paths.is_empty() {
            match delete::match_trash_items(&outcome.trashed_paths, started_at) {
                Ok(items) => {
                    if !items.is_empty() {
                        outcome.result.undo_id = Some(delete::new_undo_id());
                    }
                    items
                }
                Err(error) => {
                    // ゴミ箱を列挙できない環境でも削除自体は成功している。
                    eprintln!("Undo の準備に失敗しました: {error}");
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        Ok::<_, String>((outcome, items))
    })
    .await;

    state.deleting.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = state.delete_cancel.lock() {
        *slot = None;
    }

    match result {
        Ok(Ok((outcome, items))) => {
            let delete::DeleteOutcome {
                result,
                snapshots,
                root_ids,
                ..
            } = outcome;
            if let Some(undo_id) = result.undo_id.clone() {
                let mut slot = state
                    .pending_undo
                    .lock()
                    .map_err(|_| "Undo 状態のロックに失敗しました".to_string())?;
                *slot = Some(UndoBatch {
                    id: undo_id,
                    items,
                    snapshots,
                    root_ids,
                });
            }
            Ok(result)
        }
        Ok(Err(message)) => Err(message),
        Err(error) => Err(format!("削除タスクが異常終了しました: {error}")),
    }
}

/// 実行中の削除をキャンセルする。リクエストを出せたら `true`。
#[tauri::command]
pub fn cancel_delete(state: State<'_, AppState>) -> Result<bool, String> {
    let slot = state
        .delete_cancel
        .lock()
        .map_err(|_| "削除状態のロックに失敗しました".to_string())?;
    Ok(match slot.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

/// 直前のゴミ箱移動を取り消す（ゴミ箱から元の場所へ戻し、索引も戻す）。
///
/// UI の Undo トーストから 5 秒以内に呼ばれる想定。トークンは 1 回だけ有効。
#[tauri::command]
pub async fn undo_delete(
    state: State<'_, AppState>,
    undo_id: String,
) -> Result<UndoResult, String> {
    let batch = {
        let mut slot = state
            .pending_undo
            .lock()
            .map_err(|_| "Undo 状態のロックに失敗しました".to_string())?;
        match slot.as_ref() {
            Some(batch) if batch.id == undo_id => slot.take(),
            _ => None,
        }
    };
    let Some(batch) = batch else {
        return Err("この操作は取り消せません（Undo の有効期限が切れています）".to_string());
    };

    let db_path = state.db_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db::open(&db_path).map_err(|error| error_message(&error))?;
        delete::undo(&mut conn, batch.items, batch.snapshots, batch.root_ids)
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(error) => Err(format!("Undo タスクが異常終了しました: {error}")),
    }
}
