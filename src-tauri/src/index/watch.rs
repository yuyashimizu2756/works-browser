//! #7 フォルダ監視と差分更新（`notify` + `notify-debouncer-full`）。
//!
//! 走査（[`super::scan`]）は起動時・手動実行の全走査、こちらは常駐の差分更新。
//! 役割分担は同じで、作品の分割（[`super::scan::work_rel_path`]）と除外
//! （[`super::scan::is_excluded_name`]）の規則を共有する。
//!
//! 流れ:
//! 1. `enabled = 1` のルートだけを再帰監視（ネットワークドライブは既定で除外）
//! 2. 1 秒のデバウンスでイベントをまとめる
//! 3. 追加 / 更新は `files` へ UPSERT（サムネイルは NULL にして生成待ちに戻す）
//! 4. 削除は `files` から消し、空になった `works` とサムネイルキャッシュも消す
//! 5. リネームは「旧パスの削除 + 新パスの追加」（DB の id は変わってよい）
//!
//! 1 バッチが [`MAX_BATCH_EVENTS`] を超えたら差分適用を諦め、そのルートの
//! 再走査へフォールバックする。1 万件のコピーでもメモリと DB 書き込みが
//! 爆発しないための上限。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use walkdir::WalkDir;

use super::db::{self, Root, RootInfo};
use super::scan::{self, ScanConfig};
use super::{file_identity, file_kind, IndexError, Result};

/// デバウンス時間。エクスプローラのコピー完了を 1 つのバッチにまとめる。
pub const DEBOUNCE: Duration = Duration::from_secs(1);

/// 1 バッチで処理するイベント数の上限。超えたら再走査へフォールバックする。
pub const MAX_BATCH_EVENTS: usize = 4_000;

/// ディレクトリイベント 1 件から辿るファイル数の上限。
pub const MAX_DIR_FILES: usize = 5_000;

/// 監視しない拡張子（書きかけファイル）。
pub const IGNORED_EXTENSIONS: &[&str] = &["tmp", "part"];

/// 監視しないファイル名（OS が作るゴミ）。
pub const IGNORED_NAMES: &[&str] = &["thumbs.db", ".ds_store"];

/// 監視まわりのエラー。
#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("フォルダ監視を開始できません: {0}")]
    Notify(#[from] notify::Error),

    #[error(transparent)]
    Index(#[from] IndexError),
}

/// 監視するルート 1 件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchTarget {
    pub root_id: i64,
    /// 走査と同じ作品分割の深さ。
    pub depth: i64,
    /// 監視する実体パス（`roots.real_path`）。
    pub real_path: PathBuf,
    /// ルート直下のファイルをまとめる作品のタイトル。
    pub label: String,
}

impl WatchTarget {
    pub fn from_root(root: &Root) -> Self {
        Self {
            root_id: root.id,
            depth: root.depth,
            real_path: PathBuf::from(&root.real_path),
            label: root.label.clone(),
        }
    }

    /// ルート直下のファイルをまとめる作品キー（`""`）。
    fn label_for(&self, work_rel: &str) -> String {
        if work_rel.is_empty() {
            self.label.clone()
        } else {
            Path::new(work_rel)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| work_rel.to_string())
        }
    }
}

/// `watch_status()` の 1 ルート分。UI は「どのルートが生きているか」だけ見る。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct WatchRootStatus {
    pub root_id: i64,
    pub enabled: bool,
    pub path: String,
}

/// `watch_status()` の戻り値。
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct WatchStatus {
    /// アプリ設定で監視が有効か（`config.json` の `watch_enabled`）。
    pub enabled: bool,
    pub roots: Vec<WatchRootStatus>,
}

/// 監視設定（`config.json` から組み立てる）。
#[derive(Debug, Clone, Default)]
pub struct WatchSettings {
    pub enabled: bool,
    pub exclude: Vec<String>,
    pub allow_network_drives: bool,
    /// `.ts` を MPEG-TS として索引するか（#39）。
    pub index_mpeg_ts: bool,
}

impl WatchSettings {
    pub fn from_config(config: &crate::config::AppConfig) -> Self {
        Self {
            enabled: config.watch_enabled,
            exclude: config.watch_exclude.clone(),
            allow_network_drives: config.watch_network_drives,
            index_mpeg_ts: config.index_mpeg_ts,
        }
    }
}

/// 差分適用に使うオプション（設定 + テスト用の上限）。
#[derive(Debug, Clone)]
pub struct WatchOptions {
    /// ファイル名 / ルート相対パスに対する除外 glob。
    pub exclude: Vec<String>,
    /// 1 バッチのイベント上限。
    pub max_events: usize,
    /// `.ts` を MPEG-TS として索引するか（#39）。既定は `false`。
    pub index_mpeg_ts: bool,
}

impl Default for WatchOptions {
    fn default() -> Self {
        Self {
            exclude: Vec::new(),
            max_events: MAX_BATCH_EVENTS,
            index_mpeg_ts: false,
        }
    }
}

/// イベントの種類（リネームを「削除 + 追加」に分解した後）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Removed,
    /// 内容の更新。索引に無ければ追加として扱う。
    Updated,
}

/// 1 ルート分の変更を溜めるバッチ。
#[derive(Debug, Default, Clone)]
pub struct WatchBatch {
    pub added: Vec<PathBuf>,
    pub removed: Vec<PathBuf>,
    pub dirs_added: HashSet<PathBuf>,
    pub dirs_removed: HashSet<PathBuf>,
    /// 上限を超えたので、このルートは再走査する。
    pub overflow: bool,
    /// バッチに入れたイベント数（上限判定用）。
    events: usize,
}

impl WatchBatch {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty()
            && self.removed.is_empty()
            && self.dirs_added.is_empty()
            && self.dirs_removed.is_empty()
            && !self.overflow
    }

    /// イベントを 1 件足す。上限を超えたら `overflow` を立てて以後は捨てる。
    pub fn record(&mut self, target: &WatchTarget, event: &Event, options: &WatchOptions) -> bool {
        if self.overflow {
            return true;
        }
        if event.need_rescan() {
            self.mark_overflow();
            return true;
        }

        match event.kind {
            EventKind::Access(_) | EventKind::Other => {}
            EventKind::Create(kind) => {
                for path in &event.paths {
                    self.push_path(
                        target,
                        path,
                        ChangeKind::Added,
                        is_create_folder(kind),
                        options,
                    );
                }
            }
            EventKind::Remove(kind) => {
                for path in &event.paths {
                    self.push_path(
                        target,
                        path,
                        ChangeKind::Removed,
                        is_remove_folder(kind),
                        options,
                    );
                }
            }
            EventKind::Modify(ModifyKind::Name(mode)) => {
                self.push_rename(target, &event.paths, mode, options);
            }
            EventKind::Modify(_) | EventKind::Any => {
                for path in &event.paths {
                    // 更新はディスクの現物で「まだある / 消えた」を決める
                    if path.is_dir() {
                        self.push_path(target, path, ChangeKind::Added, true, options);
                    } else if path.exists() {
                        self.push_path(target, path, ChangeKind::Updated, false, options);
                    } else {
                        self.push_path(target, path, ChangeKind::Removed, false, options);
                    }
                }
            }
        }
        self.overflow
    }

    fn push_rename(
        &mut self,
        target: &WatchTarget,
        paths: &[PathBuf],
        mode: RenameMode,
        options: &WatchOptions,
    ) {
        match mode {
            RenameMode::Both => {
                if let Some(from) = paths.first() {
                    let is_dir = from.is_dir();
                    self.push_path(target, from, ChangeKind::Removed, is_dir, options);
                }
                if let Some(to) = paths.last() {
                    let is_dir = to.is_dir();
                    self.push_path(target, to, ChangeKind::Added, is_dir, options);
                }
            }
            RenameMode::From => {
                if let Some(from) = paths.first() {
                    let is_dir = from.is_dir();
                    self.push_path(target, from, ChangeKind::Removed, is_dir, options);
                }
            }
            RenameMode::To => {
                if let Some(to) = paths.last() {
                    let is_dir = to.is_dir();
                    self.push_path(target, to, ChangeKind::Added, is_dir, options);
                }
            }
            // 片側しか分からないバックエンド向け。現物で判定する。
            _ => {
                for path in paths {
                    if path.exists() {
                        let is_dir = path.is_dir();
                        self.push_path(target, path, ChangeKind::Added, is_dir, options);
                    } else {
                        self.push_path(target, path, ChangeKind::Removed, false, options);
                    }
                }
            }
        }
    }

    fn push_path(
        &mut self,
        target: &WatchTarget,
        path: &Path,
        kind: ChangeKind,
        is_dir: bool,
        options: &WatchOptions,
    ) {
        if self.overflow || relative_path(target, path).is_none() {
            return;
        }

        // 削除は「以前索引したもの」を消す必要があるので、無視パターンでは捨てない。
        if kind != ChangeKind::Removed && is_ignored(target, path, options) {
            return;
        }

        self.events += 1;
        if self.events > options.max_events.max(1) {
            self.mark_overflow();
            return;
        }

        // 追加・更新は現物を見ればフォルダか分かる（イベント種別が Any でも拾う）。
        let is_dir = if kind == ChangeKind::Removed {
            is_dir
        } else {
            is_dir || path.is_dir()
        };

        match kind {
            ChangeKind::Added | ChangeKind::Updated => {
                if is_dir {
                    self.dirs_added.insert(path.to_path_buf());
                } else {
                    self.added.push(path.to_path_buf());
                }
            }
            ChangeKind::Removed => {
                if is_dir {
                    self.dirs_removed.insert(path.to_path_buf());
                } else {
                    self.removed.push(path.to_path_buf());
                }
            }
        }
    }

    fn mark_overflow(&mut self) {
        self.overflow = true;
        self.added.clear();
        self.removed.clear();
        self.dirs_added.clear();
        self.dirs_removed.clear();
    }
}

fn is_create_folder(kind: CreateKind) -> bool {
    matches!(kind, CreateKind::Folder)
}

fn is_remove_folder(kind: RemoveKind) -> bool {
    matches!(kind, RemoveKind::Folder)
}

/// 差分適用の結果。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AppliedChanges {
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    /// 索引対象外・重複実体などで飛ばした数。
    pub skipped: u64,
    /// 上限超過で再走査したか。
    pub rescanned: bool,
}

impl AppliedChanges {
    /// UI に「増えた」として伝える数（更新も一覧の再取得が必要なので含める）。
    pub fn touched(&self) -> u64 {
        self.added + self.updated
    }
}

/// `watch://changed` のペイロード。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WatchChanged {
    pub root_id: i64,
    pub added: u64,
    pub removed: u64,
    /// 上限超過で全走査にフォールバックしたか。
    pub rescan: bool,
}

impl From<(&WatchTarget, &AppliedChanges)> for WatchChanged {
    fn from((target, applied): (&WatchTarget, &AppliedChanges)) -> Self {
        Self {
            root_id: target.root_id,
            added: applied.touched(),
            removed: applied.removed,
            rescan: applied.rescanned,
        }
    }
}

/// 変更を UI に伝えるコールバック。
pub type ChangeHandler = Arc<dyn Fn(WatchChanged) + Send + Sync>;

// ---------------------------------------------------------------------------
// #63 ルート別の新着件数（メモリのみ・永続化しない）
// ---------------------------------------------------------------------------

/// 1 ルート分の累計。`added >= removed` を保つ（バッジを負にしない）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct PendingCounts {
    pub added: u64,
    pub removed: u64,
}

impl PendingCounts {
    /// バッジに出す件数（`added - removed`。負にはしない）。
    pub fn net(&self) -> u64 {
        self.added.saturating_sub(self.removed)
    }

    pub fn is_empty(&self) -> bool {
        self.added == 0 && self.removed == 0
    }

    /// 監視イベントの件数を足す。削除が上回ったら両方 0 に丸める。
    pub fn accumulate(&mut self, added: u64, removed: u64) {
        self.added = self.added.saturating_add(added);
        self.removed = self.removed.saturating_add(removed);
        if self.removed >= self.added {
            self.added = 0;
            self.removed = 0;
        }
    }
}

/// `watch_pending()` の 1 ルート分。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct WatchPending {
    pub root_id: i64,
    pub added: u64,
    pub removed: u64,
}

/// ルート別の累計（`AppState` が持つ）。
pub type PendingMap = HashMap<i64, PendingCounts>;

/// 監視の 1 バッチ分を累計へ足す。
pub fn record_pending(map: &mut PendingMap, root_id: i64, added: u64, removed: u64) {
    if added == 0 && removed == 0 {
        return;
    }
    let counts = map.entry(root_id).or_default();
    counts.accumulate(added, removed);
    if counts.is_empty() {
        map.remove(&root_id);
    }
}

/// ルートの累計を消す（そのルートを開いたとき）。
pub fn clear_pending(map: &mut PendingMap, root_id: i64) {
    map.remove(&root_id);
}

/// 累計を UI 用の一覧にする（`root_id` 昇順、0 件は出さない）。
pub fn pending_list(map: &PendingMap) -> Vec<WatchPending> {
    let mut rows: Vec<WatchPending> = map
        .iter()
        .filter(|(_, counts)| !counts.is_empty())
        .map(|(root_id, counts)| WatchPending {
            root_id: *root_id,
            added: counts.added,
            removed: counts.removed,
        })
        .collect();
    rows.sort_by_key(|row| row.root_id);
    rows
}

// ---------------------------------------------------------------------------
// 監視サービス
// ---------------------------------------------------------------------------

/// 常駐の監視。フィールドを落とす（Drop）とデバウンススレッドも止まる。
pub struct WatchService {
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    roots: Vec<WatchRootStatus>,
}

impl WatchService {
    /// `enabled = 1` のルートを監視する。設定で無効なら `None`。
    pub fn start(
        db_path: &Path,
        settings: &WatchSettings,
        handler: ChangeHandler,
    ) -> std::result::Result<Option<Self>, WatchError> {
        if !settings.enabled {
            return Ok(None);
        }

        let conn = db::open(db_path)?;
        let infos = db::list_roots(&conn)?;
        let targets: Vec<WatchTarget> = infos
            .iter()
            .filter(|info| watchable_root(info, settings.allow_network_drives))
            .map(|info| WatchTarget::from_root(&info.root))
            .collect();
        drop(conn);

        if targets.is_empty() {
            return Ok(None);
        }

        let runtime = Arc::new(WatchRuntime {
            db_path: db_path.to_path_buf(),
            settings: settings.clone(),
            targets: targets.clone(),
            handler,
        });

        let mut debouncer =
            new_debouncer(
                DEBOUNCE,
                None,
                move |result: DebounceEventResult| match result {
                    Ok(events) => runtime.handle_events(&events),
                    Err(errors) => {
                        for error in errors {
                            eprintln!("フォルダ監視のイベントを読めません: {error}");
                        }
                    }
                },
            )?;

        let mut watched = Vec::new();
        for target in &targets {
            match debouncer.watch(&target.real_path, RecursiveMode::Recursive) {
                Ok(()) => watched.push(WatchRootStatus {
                    root_id: target.root_id,
                    enabled: true,
                    path: db::display_path(&target.real_path),
                }),
                Err(error) => {
                    eprintln!(
                        "フォルダ監視を開始できません ({}): {error}",
                        db::display_path(&target.real_path)
                    );
                    watched.push(WatchRootStatus {
                        root_id: target.root_id,
                        enabled: false,
                        path: db::display_path(&target.real_path),
                    });
                }
            }
        }

        Ok(Some(Self {
            debouncer,
            roots: watched,
        }))
    }

    /// 監視中のルート（開始に失敗したルートは `enabled = false`）。
    pub fn status(&self) -> WatchStatus {
        WatchStatus {
            enabled: true,
            roots: self.roots.clone(),
        }
    }

    /// 監視を明示的に止める（設定の切り替えで使う）。
    pub fn stop(self) {
        self.debouncer.stop();
    }
}

/// 監視対象にしてよいルートか。
fn watchable_root(info: &RootInfo, allow_network_drives: bool) -> bool {
    info.root.enabled
        && info.root.duplicate_of.is_none()
        && !info.root.real_path.trim().is_empty()
        && (allow_network_drives || !is_network_path(Path::new(&info.root.real_path)))
        && Path::new(&info.root.real_path).is_dir()
}

/// 監視の実体。デバウンススレッドから呼ばれる。
struct WatchRuntime {
    db_path: PathBuf,
    settings: WatchSettings,
    /// 長いパス（深いルート）を先に照合するため、パスの長さで降順に持つ。
    targets: Vec<WatchTarget>,
    handler: ChangeHandler,
}

impl WatchRuntime {
    fn handle_events(&self, events: &[DebouncedEvent]) {
        if events.is_empty() {
            return;
        }

        let options = WatchOptions {
            exclude: self.settings.exclude.clone(),
            max_events: MAX_BATCH_EVENTS,
            index_mpeg_ts: self.settings.index_mpeg_ts,
        };
        let mut batches: BTreeMap<i64, WatchBatch> = BTreeMap::new();
        let mut by_id: HashMap<i64, &WatchTarget> = HashMap::new();
        for target in &self.targets {
            by_id.insert(target.root_id, target);
        }

        for event in events {
            for target in self.targets_for(&event.event) {
                let batch = batches.entry(target.root_id).or_default();
                batch.record(target, &event.event, &options);
            }
        }

        for (root_id, batch) in batches {
            if batch.is_empty() {
                continue;
            }
            let Some(target) = by_id.get(&root_id) else {
                continue;
            };
            match self.flush(target, &batch, &options) {
                Ok(Some(change)) => (self.handler)(change),
                Ok(None) => {}
                Err(error) => eprintln!(
                    "フォルダ監視の差分を索引へ反映できません (root {}): {error}",
                    target.root_id
                ),
            }
        }
    }

    /// イベントのパスが一致するルート（入れ子・ルート間の移動に対応）。
    ///
    /// 深いルートを先に返す。同じイベントを複数ルートへ流すことはあるが、
    /// ルートごとに独立した索引なので二重計上にはならない。
    fn targets_for(&self, event: &Event) -> Vec<&WatchTarget> {
        let mut matched: Vec<&WatchTarget> = self
            .targets
            .iter()
            .filter(|target| {
                event
                    .paths
                    .iter()
                    .any(|path| path.starts_with(&target.real_path))
            })
            .collect();
        matched.sort_by_key(|target| std::cmp::Reverse(target.real_path.as_os_str().len()));
        matched
    }

    fn flush(
        &self,
        target: &WatchTarget,
        batch: &WatchBatch,
        options: &WatchOptions,
    ) -> Result<Option<WatchChanged>> {
        let mut conn = db::open(&self.db_path)?;
        let applied = apply_batch(&mut conn, target, batch, options)?;

        if applied.added == 0 && applied.updated == 0 && applied.removed == 0 {
            return Ok(None);
        }
        Ok(Some(WatchChanged::from((target, &applied))))
    }
}

/// 1 ルートを再走査する（上限超過時のフォールバック）。
fn rescan(conn: &mut Connection, root_id: i64, index_mpeg_ts: bool) -> Result<scan::ScanSummary> {
    let root = db::get_root(conn, root_id)?;
    let cancel = AtomicBool::new(false);
    let config = ScanConfig {
        index_mpeg_ts,
        ..ScanConfig::default()
    };
    scan::scan_root(conn, &root, &cancel, &config, &mut |_progress| {})
}

// ---------------------------------------------------------------------------
// 差分の適用（テスト可能な純粋な DB 処理）
// ---------------------------------------------------------------------------

/// トランザクションの外で stat 済みの 1 ファイル。
struct PreparedFile {
    rel: String,
    work_rel: String,
    name: String,
    kind: &'static str,
    bytes: i64,
    mtime: i64,
    volume: Option<u32>,
    index: Option<i64>,
}

/// 追加候補を stat して書き込み用のレコードにする。
fn prepare_files(
    target: &WatchTarget,
    added: &[PathBuf],
    applied: &mut AppliedChanges,
    options: &WatchOptions,
) -> Vec<PreparedFile> {
    let mut prepared = Vec::with_capacity(added.len());
    for path in added {
        let Some(rel) = relative_path(target, path) else {
            applied.skipped += 1;
            continue;
        };
        let Some(kind) = file_kind(path, options.index_mpeg_ts) else {
            applied.skipped += 1;
            continue;
        };
        let Ok(meta) = fs::metadata(path) else {
            applied.skipped += 1;
            continue;
        };
        if !meta.is_file() {
            applied.skipped += 1;
            continue;
        }
        let Some(work_rel) = scan::work_rel_path(&rel, target.depth) else {
            applied.skipped += 1;
            continue;
        };
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            applied.skipped += 1;
            continue;
        };
        let identity = file_identity(path);
        prepared.push(PreparedFile {
            rel: rel.to_string_lossy().to_string(),
            work_rel,
            name: name.to_string(),
            kind,
            bytes: meta.len() as i64,
            mtime: db::modified_ms(&meta),
            volume: identity.map(|(volume, _)| volume),
            index: identity.map(|(_, index)| index as i64),
        });
    }
    prepared
}

/// バッチを索引へ反映する。
///
/// 呼び出し側は `enabled` ルートの `real_path` を対象に渡すこと。
pub fn apply_batch(
    conn: &mut Connection,
    target: &WatchTarget,
    batch: &WatchBatch,
    options: &WatchOptions,
) -> Result<AppliedChanges> {
    apply_batch_with_cache(
        conn,
        target,
        batch,
        options,
        &crate::thumbs::default_cache_dir(),
    )
}

/// サムネイルキャッシュ先を差し替えられる版（テスト用）。
pub fn apply_batch_with_cache(
    conn: &mut Connection,
    target: &WatchTarget,
    batch: &WatchBatch,
    options: &WatchOptions,
    cache_dir: &Path,
) -> Result<AppliedChanges> {
    if batch.overflow {
        // 上限超過は「差分を当てない」判断なので、そのルートを丸ごと引き直す。
        let summary = rescan(conn, target.root_id, options.index_mpeg_ts)?;
        return Ok(AppliedChanges {
            added: summary.added + summary.updated,
            updated: 0,
            removed: summary.removed,
            skipped: 0,
            rescanned: true,
        });
    }

    let mut applied = AppliedChanges::default();

    // 1. 追加候補を集める（ディレクトリは中を歩く）
    let mut seen: HashSet<String> = HashSet::new();
    let mut added: Vec<PathBuf> = Vec::new();
    for path in &batch.added {
        push_candidate(target, path, &mut seen, &mut added, options, &mut applied);
    }
    for dir in &batch.dirs_added {
        let mut walked = 0_usize;
        let walker = WalkDir::new(dir)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !scan::is_excluded_name(&entry.file_name().to_string_lossy())
            });
        for entry in walker {
            let Ok(entry) = entry else {
                continue;
            };
            if !entry.file_type().is_file() {
                continue;
            }
            walked += 1;
            if walked > MAX_DIR_FILES {
                // ディレクトリ 1 件で大量のファイル。部分適用せず再走査に任せる。
                applied.rescanned = true;
                let summary = rescan(conn, target.root_id, options.index_mpeg_ts)?;
                applied.added += summary.added + summary.updated;
                applied.removed += summary.removed;
                return Ok(applied);
            }
            push_candidate(
                target,
                entry.path(),
                &mut seen,
                &mut added,
                options,
                &mut applied,
            );
        }
    }

    // 2. 削除候補を集める（含まれるファイルは DB から引く）
    let mut removed_paths: Vec<PathBuf> = Vec::new();
    for path in &batch.removed {
        if let Some(rel) = relative_path(target, path) {
            removed_paths.push(rel);
        }
    }
    let mut removed_dirs: Vec<PathBuf> = Vec::new();
    for dir in &batch.dirs_removed {
        if let Some(rel) = relative_path(target, dir) {
            removed_dirs.push(rel);
        }
    }

    // ファイルの stat / 実体 ID はトランザクションの外で取る（書き込みロックを
    // 持ったままディスク I/O しない。1,000 件コピーでも UI の読みを止めない）。
    let prepared = prepare_files(target, &added, &mut applied, options);

    let transaction = conn.transaction()?;
    let mut thumbs: Vec<PathBuf> = Vec::new();

    // 3. 削除（リネームの旧パスもここで消える）
    {
        let mut find_thumbs = transaction.prepare(
            "SELECT f.thumb_path FROM files f JOIN works w ON w.id = f.work_id
             WHERE w.root_id = ?1 AND f.rel_path = ?2 COLLATE NOCASE AND f.thumb_path IS NOT NULL",
        )?;
        let mut delete_file = transaction.prepare(
            "DELETE FROM files
             WHERE work_id IN (SELECT id FROM works WHERE root_id = ?1)
               AND rel_path = ?2 COLLATE NOCASE",
        )?;
        for rel in &removed_paths {
            let rel_text = rel.to_string_lossy().to_string();
            {
                let mut rows = find_thumbs.query(params![target.root_id, rel_text])?;
                while let Some(row) = rows.next()? {
                    if let Some(path) = row.get::<_, Option<String>>(0)? {
                        thumbs.push(PathBuf::from(path));
                    }
                }
            }
            applied.removed += delete_file.execute(params![target.root_id, rel_text])? as u64;
        }

        let mut find_dir_thumbs = transaction.prepare(
            "SELECT f.thumb_path FROM files f JOIN works w ON w.id = f.work_id
             WHERE w.root_id = ?1
               AND (f.rel_path = ?2 COLLATE NOCASE
                    OR substr(f.rel_path, 1, length(?2) + 1) = ?2 || ?3 COLLATE NOCASE)
               AND f.thumb_path IS NOT NULL",
        )?;
        let mut delete_dir = transaction.prepare(
            "DELETE FROM files
             WHERE work_id IN (SELECT id FROM works WHERE root_id = ?1)
               AND (rel_path = ?2 COLLATE NOCASE
                    OR substr(rel_path, 1, length(?2) + 1) = ?2 || ?3 COLLATE NOCASE)",
        )?;
        for rel in &removed_dirs {
            let rel_text = rel.to_string_lossy().to_string();
            let separator = std::path::MAIN_SEPARATOR.to_string();
            {
                let mut rows =
                    find_dir_thumbs.query(params![target.root_id, rel_text, separator])?;
                while let Some(row) = rows.next()? {
                    if let Some(path) = row.get::<_, Option<String>>(0)? {
                        thumbs.push(PathBuf::from(path));
                    }
                }
            }
            applied.removed +=
                delete_dir.execute(params![target.root_id, rel_text, separator])? as u64;
        }
    }

    // 4. 追加 / 更新
    {
        let mut upsert_work = transaction.prepare(
            "INSERT INTO works(root_id, rel_path, title, kind, mtime, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'image', ?4, ?4, ?4)
             ON CONFLICT(root_id, rel_path) DO UPDATE SET updated_at = excluded.updated_at
             RETURNING id",
        )?;
        let mut find_file = transaction
            .prepare("SELECT id, bytes, mtime FROM files WHERE work_id = ?1 AND rel_path = ?2")?;
        let mut insert_file = transaction.prepare(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime, volume_serial, file_index)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let mut update_file = transaction.prepare(
            "UPDATE files
             SET name = ?2, kind = ?3, bytes = ?4, mtime = ?5,
                 volume_serial = ?6, file_index = ?7,
                 thumb_path = NULL, thumb_mtime = NULL, thumb_bytes = NULL
             WHERE id = ?1",
        )?;
        let mut find_identity_in_root = transaction.prepare(
            "SELECT f.id, f.rel_path FROM files f JOIN works w ON w.id = f.work_id
             WHERE w.root_id = ?1 AND f.volume_serial = ?2 AND f.file_index = ?3
             LIMIT 1",
        )?;
        let mut move_file = transaction.prepare(
            "UPDATE files
             SET work_id = ?2, rel_path = ?3, name = ?4, kind = ?5,
                 bytes = ?6, mtime = ?7, volume_serial = ?8, file_index = ?9,
                 thumb_path = NULL, thumb_mtime = NULL, thumb_bytes = NULL
             WHERE id = ?1",
        )?;
        let mut duplicate_foreign = transaction.prepare(
            "SELECT w.root_id FROM files f JOIN works w ON w.id = f.work_id
             WHERE w.root_id <> ?1 AND f.volume_serial = ?2 AND f.file_index = ?3
             LIMIT 1",
        )?;

        for file in &prepared {
            let work_id: i64 = upsert_work.query_row(
                params![
                    target.root_id,
                    file.work_rel,
                    target.label_for(&file.work_rel),
                    db::now_ms()
                ],
                |row| row.get(0),
            )?;

            let existing: Option<(i64, i64, i64)> = find_file
                .query_row(params![work_id, file.rel], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .optional()?;

            match existing {
                Some((file_id, old_bytes, old_mtime)) => {
                    if old_bytes == file.bytes && old_mtime == file.mtime {
                        applied.skipped += 1;
                        continue;
                    }
                    update_file.execute(params![
                        file_id,
                        file.name,
                        file.kind,
                        file.bytes,
                        file.mtime,
                        file.volume,
                        file.index
                    ])?;
                    applied.updated += 1;
                }
                None => {
                    // 同じ実体が同じルートの別パスに残っている = リネームの取りこぼし
                    // （新しいフォルダ作成直後のリネームなどで notify が旧パスの
                    // Remove を出さないことがある）。旧パスが消えていれば行を移す。
                    // 両方のパスが実在するならハードリンクなので走査と同じく先勝ち。
                    if let (Some(volume), Some(index)) = (file.volume, file.index) {
                        let same: Option<(i64, String)> = find_identity_in_root
                            .query_row(params![target.root_id, volume, index], |row| {
                                Ok((row.get(0)?, row.get(1)?))
                            })
                            .optional()?;
                        if let Some((old_id, old_rel)) = same {
                            if !target.real_path.join(&old_rel).exists() {
                                move_file.execute(params![
                                    old_id, work_id, file.rel, file.name, file.kind, file.bytes,
                                    file.mtime, volume, index
                                ])?;
                                applied.added += 1;
                                applied.removed += 1;
                            } else {
                                applied.skipped += 1;
                            }
                            continue;
                        }

                        // 走査と同じく、他ルートの同一実体は先勝ちでスキップする
                        let foreign: Option<i64> = duplicate_foreign
                            .query_row(params![target.root_id, volume, index], |row| row.get(0))
                            .optional()?;
                        if foreign.is_some() {
                            applied.skipped += 1;
                            continue;
                        }
                    }
                    insert_file.execute(params![
                        work_id,
                        file.rel,
                        file.name,
                        file.kind,
                        file.bytes,
                        file.mtime,
                        file.volume,
                        file.index
                    ])?;
                    applied.added += 1;
                }
            }
        }
    }

    // 5. 空になった作品を落とし、集計とカバーを直す
    transaction.execute(
        "DELETE FROM works
         WHERE root_id = ?1 AND NOT EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id)",
        [target.root_id],
    )?;
    scan::aggregate_works(&transaction, target.root_id)?;
    transaction.commit()?;

    // 6. サムネイルキャッシュはコミット後に消す（DB が確定してから）
    delete_thumb_cache(&thumbs, cache_dir);

    Ok(applied)
}

/// 追加候補を重複なく積む。索引対象外はここで落とす。
fn push_candidate(
    target: &WatchTarget,
    path: &Path,
    seen: &mut HashSet<String>,
    out: &mut Vec<PathBuf>,
    options: &WatchOptions,
    applied: &mut AppliedChanges,
) {
    if relative_path(target, path).is_none() || is_ignored(target, path, options) {
        applied.skipped += 1;
        return;
    }
    if file_kind(path, options.index_mpeg_ts).is_none() {
        applied.skipped += 1;
        return;
    }
    let key = path.to_string_lossy().to_lowercase();
    if seen.insert(key) {
        out.push(path.to_path_buf());
    }
}

/// ルートからの相対パス。ルート外・ルート自身は `None`。
pub fn relative_path(target: &WatchTarget, path: &Path) -> Option<PathBuf> {
    let rel = path.strip_prefix(&target.real_path).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(rel.to_path_buf())
}

/// 走査の除外ディレクトリ + ファイル単位の無視パターンに当たるか。
pub fn is_ignored(target: &WatchTarget, path: &Path, options: &WatchOptions) -> bool {
    let Some(rel) = relative_path(target, path) else {
        return true;
    };

    // walk と同じ除外ディレクトリ。ファイル名そのものは walk 同様に除外しない
    // （`.hidden.jpg` のようなファイルは索引対象）。
    let mut components = rel.components().peekable();
    while let Some(component) = components.next() {
        let name = component.as_os_str().to_string_lossy();
        if components.peek().is_none() {
            if path.is_dir() && scan::is_excluded_name(&name) {
                return true;
            }
            break;
        }
        if scan::is_excluded_name(&name) {
            return true;
        }
    }

    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return true;
    };
    if IGNORED_NAMES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
    {
        return true;
    }
    if let Some(ext) = path.extension().and_then(|ext| ext.to_str()) {
        let ext = ext.to_ascii_lowercase();
        if IGNORED_EXTENSIONS.iter().any(|ignored| ext == *ignored) {
            return true;
        }
    }

    let rel_text = rel.to_string_lossy();
    options
        .exclude
        .iter()
        .any(|pattern| glob_match(pattern, name) || glob_match(pattern, &rel_text))
}

/// サムネイルキャッシュを消す。キャッシュ先の外は触らない。
fn delete_thumb_cache(thumbs: &[PathBuf], cache_dir: &Path) {
    for thumb in thumbs {
        if thumb.starts_with(cache_dir) {
            let _ = fs::remove_file(thumb);
        }
    }
}

// ---------------------------------------------------------------------------
// glob（`*` / `?` / `**`。Windows なので大文字小文字を無視）
// ---------------------------------------------------------------------------

/// 除外 glob のマッチ。`\` と `/` は同じ区切りとして扱う。
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().replace('\\', "/").chars().collect();
    let text: Vec<char> = text.to_lowercase().replace('\\', "/").chars().collect();
    match_from(&pattern, &text)
}

fn match_from(pattern: &[char], text: &[char]) -> bool {
    let Some(&first) = pattern.first() else {
        return text.is_empty();
    };

    if first == '*' {
        let double = pattern.get(1) == Some(&'*');
        let rest = if double { &pattern[2..] } else { &pattern[1..] };
        if double {
            // `**/` は 0 階層にも一致させる
            if rest.first() == Some(&'/') && match_from(&rest[1..], text) {
                return true;
            }
            for index in 0..=text.len() {
                if match_from(rest, &text[index..]) {
                    return true;
                }
            }
            return false;
        }
        for index in 0..=text.len() {
            if text[..index].contains(&'/') {
                break;
            }
            if match_from(rest, &text[index..]) {
                return true;
            }
        }
        return false;
    }

    let Some(&current) = text.first() else {
        return false;
    };

    if first == '?' {
        return current != '/' && match_from(&pattern[1..], &text[1..]);
    }
    first == current && match_from(&pattern[1..], &text[1..])
}

// ---------------------------------------------------------------------------
// ネットワークドライブの判定
// ---------------------------------------------------------------------------

/// ネットワークドライブ（`L:\` / UNC）か。既定では監視しない。
#[cfg(windows)]
pub fn is_network_path(path: &Path) -> bool {
    use std::path::Component;

    let raw = path.to_string_lossy();
    if raw.starts_with(r"\\") {
        // `\\?\UNC\server\share` と `\\server\share` はネットワーク。
        // `\\?\D:\...`（ローカルの verbatim パス）は違う。
        let rest = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
        let is_unc = rest.starts_with(r"\\")
            || rest
                .get(..4)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"UNC\"));
        if is_unc {
            return true;
        }
    }

    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    let letter = match prefix.kind() {
        std::path::Prefix::Disk(letter) | std::path::Prefix::VerbatimDisk(letter) => letter,
        _ => return false,
    };
    drive_type(letter) == 4 // DRIVE_REMOTE
}

#[cfg(windows)]
fn drive_type(letter: u8) -> u32 {
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    let root: Vec<u16> = vec![letter as u16, ':' as u16, '\\' as u16, 0];
    // SAFETY: `root` は NUL 終端の UTF-16 文字列で、呼び出しの間有効。
    unsafe { GetDriveTypeW(root.as_ptr()) }
}

#[cfg(not(windows))]
pub fn is_network_path(path: &Path) -> bool {
    path.to_string_lossy().starts_with("//")
}
