//! 作品フォルダの移動（#57）。
//!
//! サイドバーのルートへドラッグ&ドロップしたときの実処理。**実際のファイルを移動**
//! するため、#15 の削除と同じく次の安全策を必ず通す。
//!
//! - UI からは `work_id` と移動先の `root_id` だけを受け取り、パスは DB から引く
//! - 移動元・移動先とも登録ルートの内側に解決されることを確認する
//! - シンボリックリンク / ジャンクション（作品内に含まれるものも）は拒否する
//! - 移動先の同名は上書きせず `"name (2)"` にリネームする
//! - 同一ボリュームは `fs::rename`、別ボリュームは **コピー → サイズ検証 → 削除**
//! - キャンセル時はコピー先の部分データを消す
//! - 同一ボリュームの成功時だけ、5 秒間の Undo（[`undo`]）用トークンを返す
//!
//! 進捗は [`MoveProgress`] を `move://progress` で流す。

use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::AppState;
use crate::index::db::{self, Root, WorkMoveSource};

/// 進捗イベント名。`delete://progress` とは別に、バイト単位で返す。
pub const PROGRESS_EVENT: &str = "move://progress";

/// 5GB を超える移動は「時間がかかる」と確認ダイアログに出す。
const LARGE_BYTES: i64 = 5 * 1024 * 1024 * 1024;
/// コピーの読み書き単位（キャンセルをこの粒度で確認する）。
const COPY_CHUNK: usize = 256 * 1024;
/// 進捗イベントの最小間隔（バイト）。総量の 1/200 か 1MiB の大きい方。
const MIN_PROGRESS_STEP: i64 = 1024 * 1024;

/// 同名があったときの扱い。UI は常に `rename` を使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
    /// 上書きせず `"name (2)"` にする。
    Rename,
    /// 同名があれば移動しない。
    Skip,
}

impl ConflictPolicy {
    pub fn parse(raw: &str) -> std::result::Result<Self, String> {
        match raw.trim() {
            "" | "rename" => Ok(Self::Rename),
            "skip" => Ok(Self::Skip),
            other => Err(format!("不明な競合時の指定です: {other}")),
        }
    }
}

/// 確認ダイアログに出す移動計画。実ファイルにはまだ触れない。
#[derive(Debug, Clone, Serialize)]
pub struct MovePlan {
    pub work_id: i64,
    pub title: String,
    pub source_root_id: i64,
    pub source_root_label: String,
    pub target_root_id: i64,
    pub target_root_label: String,
    /// 移動元のフルパス（表示用）。
    pub source_path: String,
    /// 移動先のフルパス（同名リネーム後）。表示用。
    pub target_path: String,
    /// 実際に付けるフォルダ名（`"name (2)"` を含む）。
    pub target_name: String,
    pub file_count: i64,
    pub total_bytes: i64,
    /// `true` なら rename で一瞬。`false` はコピー + 削除で時間がかかる。
    pub same_volume: bool,
    /// 同名があったため `"name (2)"` にしたか。
    pub conflict_renamed: bool,
    /// 確認ダイアログに出す補足（改行区切り）。
    pub warning: Option<String>,
}

/// `move://progress` のペイロード。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct MoveProgress {
    pub moved_bytes: i64,
    pub total_bytes: i64,
}

/// `move_work` の戻り値。失敗しても「どこまで進んだか」を返す。
#[derive(Debug, Clone, Serialize)]
pub struct MoveOutcome {
    /// 実ファイルの移動と索引の更新まで完了したか。
    pub moved: bool,
    pub cancelled: bool,
    pub work_id: i64,
    pub source_root_id: i64,
    pub target_root_id: i64,
    pub source_path: String,
    pub target_path: String,
    /// 移動後の作品名（`"name (2)"` になることがある）。
    pub new_title: String,
    pub conflict_renamed: bool,
    pub same_volume: bool,
    pub files: i64,
    pub moved_bytes: i64,
    /// 同一ボリュームの成功時だけ入る（5 秒間有効）。
    pub undo_id: Option<String>,
    /// 失敗・中止の理由（空なら完全に成功）。
    pub failures: Vec<String>,
}

/// 同一ボリュームの移動を取り消すための控え。`AppState` に 1 件だけ保持する。
#[derive(Debug, Clone)]
pub struct MoveUndoBatch {
    pub id: String,
    pub work_id: i64,
    pub from_root_id: i64,
    pub from_rel_path: String,
    pub original_title: String,
    pub to_root_id: i64,
    pub to_rel_path: String,
}

/// `undo_move` の戻り値。
#[derive(Debug, Clone, Serialize)]
pub struct MoveUndoResult {
    pub restored: bool,
    pub work_id: i64,
    /// 表示を更新するルート（移動元・移動先）。
    pub root_ids: Vec<i64>,
}

/// 実行条件。
pub struct MoveOptions<'a> {
    pub on_conflict: ConflictPolicy,
    pub cancel: &'a AtomicBool,
    /// テスト用。別ボリュームのコピー経路を強制する。
    pub force_cross_volume: bool,
}

/// 移動計画の内部表現（表示用の文字列ではなく実パスを持つ）。
struct ResolvedPlan {
    source: WorkMoveSource,
    target_root: Root,
    source_root_path: PathBuf,
    source_path: PathBuf,
    target_path: PathBuf,
    target_name: String,
    conflict_renamed: bool,
    stats: TreeStats,
    same_volume: bool,
}

/// ディレクトリ 1 つの集計。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TreeStats {
    files: i64,
    bytes: i64,
}

/// `execute` の結果（Undo 用の控えをコマンド層へ渡す）。
#[derive(Debug)]
pub struct MoveRun {
    pub outcome: MoveOutcome,
    pub undo: Option<MoveUndoBatch>,
}

enum CopyError {
    Cancelled,
    Failed(String),
}

// ---------------------------------------------------------------------------
// パス検証
// ---------------------------------------------------------------------------

fn comparable(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('/', "\\");
    raw.trim_end_matches('\\').to_lowercase()
}

fn is_within(path: &Path, base: &Path) -> bool {
    let target = comparable(path);
    let base = comparable(base);
    if base.is_empty() || target.is_empty() {
        return false;
    }
    target == base || target.starts_with(&format!("{base}\\"))
}

/// Windows のジャンクション / シンボリックリンク（再解析ポイント）か。
#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

/// `rel_path` がルート直下に閉じているか（`..` や絶対パスを拒否）。
fn relative_is_safe(rel_path: &str) -> bool {
    let mut components = Path::new(rel_path).components();
    if !components.any(|component| matches!(component, Component::Normal(_))) {
        return false;
    }
    !Path::new(rel_path).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

/// ドライブ（ボリューム）の識別子。`None` は判定できないので同一扱い。
fn volume_key(path: &Path) -> Option<String> {
    path.components().find_map(|component| match component {
        Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().to_lowercase()),
        _ => None,
    })
}

fn same_volume(a: &Path, b: &Path) -> bool {
    match (volume_key(a), volume_key(b)) {
        (Some(left), Some(right)) => left == right,
        _ => true,
    }
}

/// 移動元の作品フォルダを検証し、作品パスとルートの正規化パスを返す。
fn validate_source(source: &WorkMoveSource) -> std::result::Result<(PathBuf, PathBuf), String> {
    if source.rel_path.is_empty() {
        return Err("ルート直下のファイルは作品フォルダではないため移動できません".to_string());
    }
    if !relative_is_safe(&source.rel_path) {
        return Err("登録ルートの外を指すパスのため移動できません".to_string());
    }

    let canonical_root = fs::canonicalize(&source.root_real_path)
        .map_err(|error| format!("移動元のルートを参照できません: {error}"))?;
    let path = db::join_root(&source.root_real_path, &source.rel_path);

    let meta = fs::symlink_metadata(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "作品フォルダが見つかりません".to_string(),
        _ => format!("作品フォルダを確認できません: {error}"),
    })?;
    if meta.file_type().is_symlink() || is_reparse_point(&meta) {
        return Err("シンボリックリンク / ジャンクションは移動できません".to_string());
    }
    if !meta.is_dir() {
        return Err("作品フォルダではありません".to_string());
    }

    let resolved = fs::canonicalize(&path)
        .map_err(|error| format!("作品フォルダのパスを解決できません: {error}"))?;
    if !is_within(&resolved, &canonical_root) {
        return Err("登録ルートの外にあるため移動できません".to_string());
    }
    Ok((resolved, canonical_root))
}

/// 移動先ルートを検証し、正規化したパスを返す。
fn validate_target_root(root: &Root, source_path: &Path) -> std::result::Result<PathBuf, String> {
    if !root.enabled {
        return Err("移動先のルートが無効になっています".to_string());
    }
    let path = PathBuf::from(&root.real_path);
    let meta = fs::symlink_metadata(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            "移動先のルートが見つかりません（ドライブが未接続の可能性があります）".to_string()
        }
        _ => format!("移動先のルートを確認できません: {error}"),
    })?;
    if meta.file_type().is_symlink() || is_reparse_point(&meta) {
        return Err(
            "移動先のルートがシンボリックリンク / ジャンクションのため移動できません".to_string(),
        );
    }
    if !meta.is_dir() {
        return Err("移動先がフォルダではありません".to_string());
    }
    fs::read_dir(&path)
        .map_err(|error| format!("移動先のフォルダを開けません（権限が無い可能性）: {error}"))?;

    let canonical = fs::canonicalize(&path)
        .map_err(|error| format!("移動先のパスを解決できません: {error}"))?;
    if canonical == source_path || is_within(&canonical, source_path) {
        return Err("移動先が作品フォルダの中です".to_string());
    }
    if source_path.parent() == Some(canonical.as_path()) {
        return Err("移動元と移動先のルートが同じです".to_string());
    }
    Ok(canonical)
}

/// 作品フォルダの中身を走査する。リンクが 1 つでもあれば拒否する。
fn scan_tree(path: &Path) -> std::result::Result<TreeStats, String> {
    let mut stats = TreeStats::default();
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("フォルダを読めません（{}）: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("フォルダの内容を読めません: {error}"))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|error| {
                format!("ファイルを確認できません（{}）: {error}", path.display())
            })?;
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                return Err(
                    "シンボリックリンク / ジャンクションを含む作品は移動できません".to_string(),
                );
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                stats.files += 1;
                stats.bytes += meta.len() as i64;
            } else {
                return Err(format!(
                    "通常のファイルではない項目が含まれています: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(stats)
}

/// 移動先のフォルダ名を決める。同名は `"name (2)"` にずらす（上書きしない）。
fn resolve_destination(
    conn: &Connection,
    target_root_id: i64,
    target_root_path: &Path,
    source_name: &str,
) -> std::result::Result<(PathBuf, String, bool), String> {
    for index in 1..=9999u32 {
        let name = if index == 1 {
            source_name.to_string()
        } else {
            format!("{source_name} ({index})")
        };
        let path = target_root_path.join(&name);
        let exists = match fs::symlink_metadata(&path) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => {
                return Err(format!(
                    "移動先を確認できません（{}）: {error}",
                    path.display()
                ))
            }
        };
        let indexed =
            db::work_rel_exists(conn, target_root_id, &name).map_err(|error| error.to_string())?;
        if !exists && !indexed {
            return Ok((path, name, index > 1));
        }
    }
    Err("移動先の名前を決められません（同名が多すぎます）".to_string())
}

fn source_folder_name(source: &WorkMoveSource) -> String {
    Path::new(&source.rel_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| source.title.clone())
}

/// 計画を立てる（実ファイルには触らない）。
fn resolve(
    conn: &Connection,
    work_id: i64,
    target_root_id: i64,
) -> std::result::Result<ResolvedPlan, String> {
    let source = db::work_move_source(conn, work_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "作品が見つかりません（索引にありません）".to_string())?;
    if source.root_id == target_root_id {
        return Err("移動元と移動先のルートが同じです".to_string());
    }

    let target_root = db::get_root(conn, target_root_id)
        .map_err(|_| "移動先のルートが見つかりません".to_string())?;

    let (source_path, source_root_path) = validate_source(&source)?;
    let target_root_path = validate_target_root(&target_root, &source_path)?;
    let stats = scan_tree(&source_path)?;
    let source_name = source_folder_name(&source);
    let (target_path, target_name, conflict_renamed) =
        resolve_destination(conn, target_root_id, &target_root_path, &source_name)?;
    let same = same_volume(&source_path, &target_root_path);

    Ok(ResolvedPlan {
        source,
        target_root,
        source_root_path,
        source_path,
        target_path,
        target_name,
        conflict_renamed,
        stats,
        same_volume: same,
    })
}

/// `inspect_move` の実体。UI はこれを確認ダイアログに出す。
pub fn inspect(
    conn: &Connection,
    work_id: i64,
    target_root_id: i64,
) -> std::result::Result<MovePlan, String> {
    let plan = resolve(conn, work_id, target_root_id)?;

    let mut warnings: Vec<String> = Vec::new();
    if plan.same_volume {
        warnings.push(
            "同一ボリュームのため rename で移動します。移動後 5 秒間は「元に戻す」が使えます"
                .to_string(),
        );
    } else {
        warnings.push(
            "別ボリュームのためコピーしてから削除します。時間がかかり、取り消しはできません"
                .to_string(),
        );
    }
    if plan.stats.bytes >= LARGE_BYTES {
        warnings.push("5GB を超えるため、時間がかかります".to_string());
    }
    if plan.conflict_renamed {
        warnings.push(format!(
            "移動先に同名のフォルダがあるため「{}」に変更します（上書きしません）",
            plan.target_name
        ));
    }

    Ok(MovePlan {
        work_id: plan.source.work_id,
        title: plan.source.title.clone(),
        source_root_id: plan.source.root_id,
        source_root_label: plan.source.root_label.clone(),
        target_root_id: plan.target_root.id,
        target_root_label: plan.target_root.label.clone(),
        source_path: db::display_path(&plan.source_path),
        target_path: db::display_path(&plan.target_path),
        target_name: plan.target_name,
        file_count: plan.stats.files,
        total_bytes: plan.stats.bytes,
        same_volume: plan.same_volume,
        conflict_renamed: plan.conflict_renamed,
        warning: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join("\n"))
        },
    })
}

// ---------------------------------------------------------------------------
// コピー（別ボリューム）
// ---------------------------------------------------------------------------

/// 進捗を間引いて返す。
struct ProgressSink<'a> {
    total: i64,
    moved: i64,
    step: i64,
    last: i64,
    callback: &'a mut dyn FnMut(MoveProgress),
}

impl ProgressSink<'_> {
    fn new(total: i64, callback: &mut dyn FnMut(MoveProgress)) -> ProgressSink<'_> {
        ProgressSink {
            total,
            moved: 0,
            step: (total / 200).max(MIN_PROGRESS_STEP),
            last: 0,
            callback,
        }
    }

    fn add(&mut self, bytes: i64) {
        self.moved += bytes;
        if self.moved - self.last >= self.step {
            self.last = self.moved;
            (self.callback)(MoveProgress {
                moved_bytes: self.moved.min(self.total),
                total_bytes: self.total,
            });
        }
    }

    fn finish(&mut self) {
        (self.callback)(MoveProgress {
            moved_bytes: self.total,
            total_bytes: self.total,
        });
    }
}

fn copy_file(
    src: &Path,
    dst: &Path,
    cancel: &AtomicBool,
    progress: &mut ProgressSink<'_>,
) -> std::result::Result<(), CopyError> {
    let mut input = fs::File::open(src)
        .map_err(|error| CopyError::Failed(format!("{} を開けません: {error}", src.display())))?;
    let mut output = fs::File::create(dst)
        .map_err(|error| CopyError::Failed(format!("{} を作れません: {error}", dst.display())))?;
    let mut buffer = vec![0u8; COPY_CHUNK];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(CopyError::Cancelled);
        }
        let read = input.read(&mut buffer).map_err(|error| {
            CopyError::Failed(format!("{} を読めません: {error}", src.display()))
        })?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).map_err(|error| {
            CopyError::Failed(format!("{} に書けません: {error}", dst.display()))
        })?;
        progress.add(read as i64);
    }
    output
        .flush()
        .map_err(|error| CopyError::Failed(format!("{} に書けません: {error}", dst.display())))?;
    Ok(())
}

fn copy_tree(
    src: &Path,
    dst: &Path,
    cancel: &AtomicBool,
    progress: &mut ProgressSink<'_>,
) -> std::result::Result<(), CopyError> {
    fs::create_dir_all(dst)
        .map_err(|error| CopyError::Failed(format!("{} を作れません: {error}", dst.display())))?;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((dir, out)) = stack.pop() {
        if cancel.load(Ordering::SeqCst) {
            return Err(CopyError::Cancelled);
        }
        let entries = fs::read_dir(&dir).map_err(|error| {
            CopyError::Failed(format!("{} を読めません: {error}", dir.display()))
        })?;
        for entry in entries {
            if cancel.load(Ordering::SeqCst) {
                return Err(CopyError::Cancelled);
            }
            let entry = entry
                .map_err(|error| CopyError::Failed(format!("フォルダを読めません: {error}")))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).map_err(|error| {
                CopyError::Failed(format!("{} を確認できません: {error}", path.display()))
            })?;
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                return Err(CopyError::Failed(
                    "シンボリックリンク / ジャンクションは移動できません".to_string(),
                ));
            }
            let target = out.join(entry.file_name());
            if meta.is_dir() {
                fs::create_dir_all(&target).map_err(|error| {
                    CopyError::Failed(format!("{} を作れません: {error}", target.display()))
                })?;
                stack.push((path, target));
            } else if meta.is_file() {
                copy_file(&path, &target, cancel, progress)?;
            } else {
                return Err(CopyError::Failed(format!(
                    "通常のファイルではない項目が含まれています: {}",
                    path.display()
                )));
            }
        }
    }
    Ok(())
}

/// コピー結果を検証する。全ファイルの存在とサイズ、合計件数・バイト数を照合する。
fn verify_tree(src: &Path, dst: &Path, expected: TreeStats) -> std::result::Result<(), String> {
    let mut files = 0i64;
    let mut bytes = 0i64;
    let mut stack = vec![src.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir)
            .map_err(|error| format!("検証でフォルダを読めません（{}）: {error}", dir.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("検証でフォルダを読めません: {error}"))?;
            let path = entry.path();
            let meta = fs::symlink_metadata(&path)
                .map_err(|error| format!("検証で {} を確認できません: {error}", path.display()))?;
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let relative = path
                .strip_prefix(src)
                .map_err(|_| format!("検証でパスを組み立てられません: {}", path.display()))?;
            let copied = dst.join(relative);
            let copied_meta = fs::metadata(&copied).map_err(|error| {
                format!(
                    "コピー先にファイルがありません（{}）: {error}",
                    copied.display()
                )
            })?;
            if !copied_meta.is_file() || copied_meta.len() != meta.len() {
                return Err(format!(
                    "コピーしたファイルのサイズが一致しません: {}",
                    copied.display()
                ));
            }
            files += 1;
            bytes += meta.len() as i64;
        }
    }
    if files != expected.files || bytes != expected.bytes {
        return Err(format!(
            "コピーした内容が元と一致しません（{files} ファイル / {bytes} バイト、期待 {0} ファイル / {1} バイト）",
            expected.files, expected.bytes
        ));
    }
    Ok(())
}

/// 失敗・キャンセル時にコピー先の部分データを消す。消せなければ理由を返す。
fn remove_partial(path: &Path) -> Option<String> {
    if fs::symlink_metadata(path).is_err() {
        return None;
    }
    match fs::remove_dir_all(path) {
        Ok(()) => None,
        Err(error) => Some(format!(
            "コピー先の部分データを削除できませんでした（{}）: {error}",
            db::display_path(path)
        )),
    }
}

/// 移動で空になった親フォルダを、移動元ルートの手前まで片付ける。
fn prune_empty_parents(parent: &Path, stop_at: &Path) {
    let mut current = parent.to_path_buf();
    while current != stop_at && is_within(&current, stop_at) {
        if fs::remove_dir(&current).is_err() {
            break;
        }
        match current.parent() {
            Some(next) => current = next.to_path_buf(),
            None => break,
        }
    }
}

fn new_move_id() -> String {
    use std::sync::atomic::AtomicU64;
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("move-{}-{}", db::now_ms(), count)
}

fn outcome_base(plan: &ResolvedPlan, same_volume: bool) -> MoveOutcome {
    MoveOutcome {
        moved: false,
        cancelled: false,
        work_id: plan.source.work_id,
        source_root_id: plan.source.root_id,
        target_root_id: plan.target_root.id,
        source_path: db::display_path(&plan.source_path),
        target_path: db::display_path(&plan.target_path),
        new_title: plan.target_name.clone(),
        conflict_renamed: plan.conflict_renamed,
        same_volume,
        files: plan.stats.files,
        moved_bytes: 0,
        undo_id: None,
        failures: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/// 作品フォルダを移動先ルートへ移す。
///
/// 実ファイルと索引の両方を更新する。検証エラー（移動先が無効・リンクなど）は `Err`、
/// 途中失敗・キャンセルは「どこまで進んだか」を含む [`MoveOutcome`] で返す。
pub fn execute(
    conn: &mut Connection,
    work_id: i64,
    target_root_id: i64,
    options: &MoveOptions<'_>,
    progress: &mut dyn FnMut(MoveProgress),
) -> std::result::Result<MoveRun, String> {
    let plan = resolve(conn, work_id, target_root_id)?;

    if options.on_conflict == ConflictPolicy::Skip && plan.conflict_renamed {
        return Err("移動先に同名のフォルダがあるため移動しません".to_string());
    }
    // 計画から実行までの間に同名が現れた場合は rename で吸収する（上書きはしない）。
    if fs::symlink_metadata(&plan.target_path).is_ok() {
        return Err("移動先に同名のフォルダができたため移動しません".to_string());
    }

    let use_rename = plan.same_volume && !options.force_cross_volume;
    progress(MoveProgress {
        moved_bytes: 0,
        total_bytes: plan.stats.bytes,
    });

    if use_rename {
        return move_by_rename(conn, &plan, progress).map(|mut run| {
            run.outcome.same_volume = true;
            run
        });
    }

    move_by_copy(conn, &plan, options, progress)
}

fn move_by_rename(
    conn: &mut Connection,
    plan: &ResolvedPlan,
    progress: &mut dyn FnMut(MoveProgress),
) -> std::result::Result<MoveRun, String> {
    fs::rename(&plan.source_path, &plan.target_path)
        .map_err(|error| format!("移動できません: {error}"))?;

    if let Err(error) = db::apply_work_move(
        conn,
        plan.source.work_id,
        plan.target_root.id,
        &plan.source.rel_path,
        &plan.target_name,
        &plan.target_name,
    ) {
        // 索引を更新できなければ元の場所へ戻す（実ファイルを中途半端にしない）。
        let rollback = fs::rename(&plan.target_path, &plan.source_path);
        return Err(match rollback {
            Ok(()) => format!("索引を更新できないため移動を取りやめました: {error}"),
            Err(rollback_error) => format!(
                "索引を更新できませんでした（{error}）。ファイルは {} に移動済みです（戻せません: {rollback_error}）",
                db::display_path(&plan.target_path)
            ),
        });
    }

    if let Some(parent) = plan.source_path.parent() {
        prune_empty_parents(parent, &plan.source_root_path);
    }

    progress(MoveProgress {
        moved_bytes: plan.stats.bytes,
        total_bytes: plan.stats.bytes,
    });

    let mut outcome = outcome_base(plan, true);
    outcome.moved = true;
    outcome.moved_bytes = plan.stats.bytes;

    let undo = MoveUndoBatch {
        id: new_move_id(),
        work_id: plan.source.work_id,
        from_root_id: plan.source.root_id,
        from_rel_path: plan.source.rel_path.clone(),
        original_title: plan.source.title.clone(),
        to_root_id: plan.target_root.id,
        to_rel_path: plan.target_name.clone(),
    };
    outcome.undo_id = Some(undo.id.clone());
    Ok(MoveRun {
        outcome,
        undo: Some(undo),
    })
}

fn move_by_copy(
    conn: &mut Connection,
    plan: &ResolvedPlan,
    options: &MoveOptions<'_>,
    progress: &mut dyn FnMut(MoveProgress),
) -> std::result::Result<MoveRun, String> {
    let mut sink = ProgressSink::new(plan.stats.bytes, progress);

    let copied = copy_tree(
        &plan.source_path,
        &plan.target_path,
        options.cancel,
        &mut sink,
    );
    if let Err(error) = copied {
        let cleanup = remove_partial(&plan.target_path);
        let mut outcome = outcome_base(plan, false);
        match error {
            CopyError::Cancelled => {
                outcome.cancelled = true;
            }
            CopyError::Failed(reason) => outcome.failures.push(reason),
        }
        if let Some(reason) = cleanup {
            outcome.failures.push(reason);
        }
        return Ok(MoveRun {
            outcome,
            undo: None,
        });
    }

    sink.finish();
    if options.cancel.load(Ordering::SeqCst) {
        let cleanup = remove_partial(&plan.target_path);
        let mut outcome = outcome_base(plan, false);
        outcome.cancelled = true;
        if let Some(reason) = cleanup {
            outcome.failures.push(reason);
        }
        return Ok(MoveRun {
            outcome,
            undo: None,
        });
    }

    if let Err(reason) = verify_tree(&plan.source_path, &plan.target_path, plan.stats) {
        let cleanup = remove_partial(&plan.target_path);
        let mut outcome = outcome_base(plan, false);
        outcome.failures.push(reason);
        if let Some(reason) = cleanup {
            outcome.failures.push(reason);
        }
        return Ok(MoveRun {
            outcome,
            undo: None,
        });
    }

    if let Err(error) = fs::remove_dir_all(&plan.source_path) {
        let mut outcome = outcome_base(plan, false);
        outcome.failures.push(format!(
            "コピーは完了しましたが、移動元を削除できませんでした（{error}）。コピー先 {} に完全なコピーがあります",
            db::display_path(&plan.target_path)
        ));
        return Ok(MoveRun {
            outcome,
            undo: None,
        });
    }

    let mut outcome = outcome_base(plan, false);
    outcome.moved = true;
    outcome.moved_bytes = plan.stats.bytes;
    match db::apply_work_move(
        conn,
        plan.source.work_id,
        plan.target_root.id,
        &plan.source.rel_path,
        &plan.target_name,
        &plan.target_name,
    ) {
        Ok(_) => {
            if let Some(parent) = plan.source_path.parent() {
                prune_empty_parents(parent, &plan.source_root_path);
            }
        }
        Err(error) => {
            outcome.moved = false;
            outcome.failures.push(format!(
                "ファイルは {} へ移動しましたが、索引を更新できませんでした（{error}）。再スキャンしてください",
                db::display_path(&plan.target_path)
            ));
        }
    }

    Ok(MoveRun {
        outcome,
        undo: None,
    })
}

/// Undo（同一ボリュームのみ）。移動先から元の場所へ rename で戻し、索引も戻す。
pub fn undo(
    conn: &mut Connection,
    batch: &MoveUndoBatch,
) -> std::result::Result<MoveUndoResult, String> {
    let to_root = db::get_root(conn, batch.to_root_id)
        .map_err(|_| "移動先のルートが見つかりません".to_string())?;
    let current = db::join_root(&to_root.real_path, &batch.to_rel_path);
    let from_root = db::get_root(conn, batch.from_root_id)
        .map_err(|_| "移動元のルートが見つかりません".to_string())?;
    let original = db::join_root(&from_root.real_path, &batch.from_rel_path);

    let meta = fs::symlink_metadata(&current).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "移動したフォルダが見つかりません".to_string(),
        _ => format!("移動したフォルダを確認できません: {error}"),
    })?;
    if meta.file_type().is_symlink() || is_reparse_point(&meta) {
        return Err("シンボリックリンク / ジャンクションは戻せません".to_string());
    }
    if !meta.is_dir() {
        return Err("移動した作品フォルダではありません".to_string());
    }
    if fs::symlink_metadata(&original).is_ok() {
        return Err("元の場所に同じ名前のフォルダがあるため戻せません".to_string());
    }
    if let Some(parent) = original.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("元のフォルダを作れません: {error}"))?;
    }

    fs::rename(&current, &original).map_err(|error| format!("元の場所へ戻せません: {error}"))?;
    if let Err(error) = db::apply_work_move(
        conn,
        batch.work_id,
        batch.from_root_id,
        &batch.to_rel_path,
        &batch.from_rel_path,
        &batch.original_title,
    ) {
        let rollback = fs::rename(&original, &current);
        return Err(match rollback {
            Ok(()) => format!("索引を戻せないため取り消しを中止しました: {error}"),
            Err(rollback_error) => format!(
                "索引を戻せませんでした（{error}）。フォルダは {} に戻っています（戻せません: {rollback_error}）",
                db::display_path(&original)
            ),
        });
    }

    Ok(MoveUndoResult {
        restored: true,
        work_id: batch.work_id,
        root_ids: vec![batch.from_root_id, batch.to_root_id],
    })
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

fn open_state(state: &State<'_, AppState>) -> std::result::Result<Connection, String> {
    db::open(&state.db_path).map_err(|error| error.to_string())
}

/// 移動前の確認内容（移動先パス・サイズ・同一 / 別ボリューム）を返す。
#[tauri::command]
pub fn inspect_move(
    state: State<'_, AppState>,
    work_id: i64,
    target_root_id: i64,
) -> std::result::Result<MovePlan, String> {
    let conn = open_state(&state)?;
    inspect(&conn, work_id, target_root_id)
}

/// 作品フォルダを移動先ルートへ移す。
///
/// 1 回の移動ごとに `move://progress`（移動済み / 総バイト）を流す。
/// 同一ボリュームで成功した場合だけ `undo_id` を返す（5 秒間有効）。
#[tauri::command]
pub async fn move_work(
    app: AppHandle,
    state: State<'_, AppState>,
    work_id: i64,
    target_root_id: i64,
    on_conflict: Option<String>,
) -> std::result::Result<MoveOutcome, String> {
    let policy = ConflictPolicy::parse(on_conflict.as_deref().unwrap_or("rename"))?;
    if state.moving.swap(true, Ordering::SeqCst) {
        return Err("移動は既に実行中です".to_string());
    }
    {
        let mut slot = state
            .pending_move_undo
            .lock()
            .map_err(|_| "移動の Undo 状態のロックに失敗しました".to_string())?;
        *slot = None;
    }

    let cancel = std::sync::Arc::new(AtomicBool::new(false));
    {
        let mut slot = state
            .move_cancel
            .lock()
            .map_err(|_| "移動状態のロックに失敗しました".to_string())?;
        *slot = Some(std::sync::Arc::clone(&cancel));
    }

    let db_path = state.db_path.clone();
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db::open(&db_path).map_err(|error| error.to_string())?;
        execute(
            &mut conn,
            work_id,
            target_root_id,
            &MoveOptions {
                on_conflict: policy,
                cancel: &cancel,
                force_cross_volume: false,
            },
            &mut |progress| {
                let _ = handle.emit(PROGRESS_EVENT, progress);
            },
        )
    })
    .await;

    state.moving.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = state.move_cancel.lock() {
        *slot = None;
    }

    match result {
        Ok(Ok(run)) => {
            let MoveRun { outcome, undo } = run;
            if let Some(batch) = undo {
                let mut slot = state
                    .pending_move_undo
                    .lock()
                    .map_err(|_| "移動の Undo 状態のロックに失敗しました".to_string())?;
                *slot = Some(batch);
            }
            Ok(outcome)
        }
        Ok(Err(message)) => Err(message),
        Err(error) => Err(format!("移動タスクが異常終了しました: {error}")),
    }
}

/// 実行中の移動をキャンセルする。リクエストを出せたら `true`。
#[tauri::command]
pub fn cancel_move(state: State<'_, AppState>) -> std::result::Result<bool, String> {
    let slot = state
        .move_cancel
        .lock()
        .map_err(|_| "移動状態のロックに失敗しました".to_string())?;
    Ok(match slot.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    })
}

/// 直前に移動した作品を元のルートへ戻す（同一ボリュームのみ・5 秒以内）。
#[tauri::command]
pub async fn undo_move(
    state: State<'_, AppState>,
    move_id: String,
) -> std::result::Result<MoveUndoResult, String> {
    let batch = {
        let mut slot = state
            .pending_move_undo
            .lock()
            .map_err(|_| "移動の Undo 状態のロックに失敗しました".to_string())?;
        match slot.as_ref() {
            Some(batch) if batch.id == move_id => slot.take(),
            _ => None,
        }
    };
    let Some(batch) = batch else {
        return Err("この移動は取り消せません（Undo の有効期限が切れています）".to_string());
    };

    let db_path = state.db_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db::open(&db_path).map_err(|error| error.to_string())?;
        undo(&mut conn, &batch)
    })
    .await;

    match result {
        Ok(inner) => inner,
        Err(error) => Err(format!("Undo タスクが異常終了しました: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use tempfile::TempDir;

    struct Fixture {
        conn: Connection,
        source: TempDir,
        target: TempDir,
        source_id: i64,
        target_id: i64,
    }

    fn register(conn: &Connection, path: &Path, label: &str) -> i64 {
        let real = db::display_path(path);
        conn.execute(
            "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
             VALUES (?1, ?1, ?2, 1, 1, 0)",
            params![real, label],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    impl Fixture {
        fn new() -> Self {
            let conn = db::open_in_memory().unwrap();
            let source = TempDir::new().unwrap();
            let target = TempDir::new().unwrap();
            let source_id = register(&conn, source.path(), "source");
            let target_id = register(&conn, target.path(), "target");
            Self {
                conn,
                source,
                target,
                source_id,
                target_id,
            }
        }

        fn work(&self, rel_path: &str) -> i64 {
            let title = Path::new(rel_path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.to_string());
            self.conn
                .execute(
                    "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'image', 0, 0, 0, 0, 0)",
                    params![self.source_id, rel_path, title],
                )
                .unwrap();
            self.conn.last_insert_rowid()
        }

        /// 移動元ルートに実ファイルを作り、索引にも 1 行足す。
        fn file(&self, work_id: i64, rel_path: &str, bytes: usize) -> i64 {
            let path = db::join_root(&db::display_path(self.source.path()), rel_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, vec![b'x'; bytes]).unwrap();
            let name = Path::new(rel_path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string();
            self.conn
                .execute(
                    "INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime)
                     VALUES (?1, ?2, ?3, 'image', ?4, 1)",
                    params![work_id, rel_path, name, bytes as i64],
                )
                .unwrap();
            self.conn
                .execute(
                    "UPDATE works SET file_count = file_count + 1,
                       total_bytes = total_bytes + ?2, mtime = 1 WHERE id = ?1",
                    params![work_id, bytes as i64],
                )
                .unwrap();
            self.conn.last_insert_rowid()
        }

        fn target_work_path(&self, name: &str) -> PathBuf {
            self.target.path().join(name)
        }

        fn source_work_path(&self, name: &str) -> PathBuf {
            self.source.path().join(name)
        }
    }

    fn run_with(
        fixture: &mut Fixture,
        work_id: i64,
        target_root_id: i64,
        cross_volume: bool,
        cancel: &AtomicBool,
        mut progress: impl FnMut(MoveProgress),
    ) -> MoveRun {
        execute(
            &mut fixture.conn,
            work_id,
            target_root_id,
            &MoveOptions {
                on_conflict: ConflictPolicy::Rename,
                cancel,
                force_cross_volume: cross_volume,
            },
            &mut progress,
        )
        .unwrap()
    }

    fn run(fixture: &mut Fixture, work_id: i64, target_root_id: i64) -> MoveRun {
        run_with(
            fixture,
            work_id,
            target_root_id,
            false,
            &AtomicBool::new(false),
            |_| {},
        )
    }

    fn work_location(conn: &Connection, work_id: i64) -> (i64, String, String) {
        conn.query_row(
            "SELECT root_id, rel_path, title FROM works WHERE id = ?1",
            [work_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
    }

    fn file_rel_paths(conn: &Connection, work_id: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT rel_path FROM files WHERE work_id = ?1 ORDER BY name")
            .unwrap();
        stmt.query_map([work_id], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap()
    }

    #[test]
    fn same_volume_move_updates_index() {
        let mut fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 10);
        fixture.file(work, r"work-a\2.png", 20);

        let plan = inspect(&fixture.conn, work, fixture.target_id).unwrap();
        assert!(plan.same_volume);
        assert!(!plan.conflict_renamed);
        assert_eq!(plan.file_count, 2);
        assert_eq!(plan.total_bytes, 30);

        let target_id = fixture.target_id;
        let run = run(&mut fixture, work, target_id);
        assert!(run.outcome.moved);
        assert!(!run.outcome.cancelled);
        assert!(run.outcome.failures.is_empty());
        assert!(run.outcome.undo_id.is_some());

        assert!(!fixture.source_work_path("work-a").exists());
        assert!(fixture.target_work_path("work-a").join("1.png").is_file());
        assert!(fixture.target_work_path("work-a").join("2.png").is_file());

        let (root_id, rel_path, title) = work_location(&fixture.conn, work);
        assert_eq!(root_id, fixture.target_id);
        assert_eq!(rel_path, "work-a");
        assert_eq!(title, "work-a");
        assert_eq!(
            file_rel_paths(&fixture.conn, work),
            vec![r"work-a\1.png", r"work-a\2.png"]
        );
    }

    #[test]
    fn conflict_is_renamed_without_overwrite() {
        let mut fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 4);

        // 移動先に同名フォルダとファイルを先に置く。
        let existing = fixture.target_work_path("work-a");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("keep.png"), b"keep").unwrap();

        let plan = inspect(&fixture.conn, work, fixture.target_id).unwrap();
        assert!(plan.conflict_renamed);
        assert_eq!(plan.target_name, "work-a (2)");

        let target_id = fixture.target_id;
        let run = run(&mut fixture, work, target_id);
        assert!(run.outcome.moved);
        assert!(run.outcome.conflict_renamed);
        assert!(
            existing.join("keep.png").is_file(),
            "既存フォルダを上書きしない"
        );
        assert!(fixture
            .target_work_path("work-a (2)")
            .join("1.png")
            .is_file());
        assert_eq!(work_location(&fixture.conn, work).1, "work-a (2)");
        assert_eq!(
            file_rel_paths(&fixture.conn, work),
            vec![r"work-a (2)\1.png"]
        );
    }

    #[test]
    fn rejects_missing_target_root() {
        let mut fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 4);
        fs::remove_dir_all(fixture.target.path()).unwrap();

        let target_id = fixture.target_id;
        let error = execute(
            &mut fixture.conn,
            work,
            target_id,
            &MoveOptions {
                on_conflict: ConflictPolicy::Rename,
                cancel: &AtomicBool::new(false),
                force_cross_volume: false,
            },
            &mut |_| {},
        )
        .unwrap_err();
        assert!(error.contains("見つかりません"), "error: {error}");
        assert!(fixture.source_work_path("work-a").exists());
    }

    #[test]
    fn rejects_disabled_target_root() {
        let fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 4);
        fixture
            .conn
            .execute(
                "UPDATE roots SET enabled = 0 WHERE id = ?1",
                [fixture.target_id],
            )
            .unwrap();

        let error = inspect(&fixture.conn, work, fixture.target_id).unwrap_err();
        assert!(error.contains("無効"), "error: {error}");
        assert!(fixture.source_work_path("work-a").exists());
    }

    #[test]
    fn rejects_same_root() {
        let fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 4);

        let error = inspect(&fixture.conn, work, fixture.source_id).unwrap_err();
        assert!(error.contains("同じ"), "error: {error}");
    }

    #[test]
    fn rejects_root_flat_work() {
        let fixture = Fixture::new();
        let work = fixture.work("");
        let error = inspect(&fixture.conn, work, fixture.target_id).unwrap_err();
        assert!(error.contains("ルート直下"), "error: {error}");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_junction_inside_work() {
        let fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 4);

        let outside = TempDir::new().unwrap();
        let link = fixture.source_work_path("work-a").join("junction");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .status();
        let Ok(status) = status else {
            eprintln!("mklink を実行できない環境のためスキップします");
            return;
        };
        if !status.success() {
            eprintln!("ジャンクションを作れない環境のためスキップします");
            return;
        }

        let error = inspect(&fixture.conn, work, fixture.target_id).unwrap_err();
        assert!(
            error.contains("シンボリックリンク") || error.contains("ジャンクション"),
            "error: {error}"
        );

        // 後片付け（ジャンクションは remove_dir で消す）
        let _ = fs::remove_dir(&link);
    }

    #[test]
    fn cross_volume_copy_moves_and_removes_source() {
        let mut fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 1024);
        fixture.file(work, r"work-a\sub\2.png", 2048);

        let target_id = fixture.target_id;
        let run = run_with(
            &mut fixture,
            work,
            target_id,
            true,
            &AtomicBool::new(false),
            |_| {},
        );
        assert!(run.outcome.moved);
        assert!(!run.outcome.same_volume);
        assert!(run.outcome.undo_id.is_none(), "別ボリュームは Undo 非対応");
        assert!(!fixture.source_work_path("work-a").exists());
        assert_eq!(
            fs::read(fixture.target_work_path("work-a").join("sub").join("2.png"))
                .unwrap()
                .len(),
            2048
        );
        assert_eq!(work_location(&fixture.conn, work).0, fixture.target_id);
        assert_eq!(
            file_rel_paths(&fixture.conn, work),
            vec![r"work-a\1.png", r"work-a\sub\2.png"]
        );
    }

    #[test]
    fn cancel_cross_volume_leaves_no_partial_copy() {
        let mut fixture = Fixture::new();
        let work = fixture.work("work-a");
        for index in 0..4 {
            fixture.file(work, &format!(r"work-a\{index}.png"), 512 * 1024);
        }
        let cancel = AtomicBool::new(false);

        let target_id = fixture.target_id;
        let run = run_with(&mut fixture, work, target_id, true, &cancel, |progress| {
            if progress.moved_bytes > 0 {
                cancel.store(true, Ordering::SeqCst);
            }
        });

        assert!(run.outcome.cancelled);
        assert!(!run.outcome.moved);
        assert!(
            fixture.source_work_path("work-a").join("0.png").is_file(),
            "移動元は残す"
        );
        assert_eq!(
            file_rel_paths(&fixture.conn, work).len(),
            4,
            "索引も移動元のまま"
        );
        assert!(
            !fixture.target_work_path("work-a").exists(),
            "コピー先の部分データを残さない"
        );
        assert_eq!(work_location(&fixture.conn, work).0, fixture.source_id);
    }

    #[test]
    fn undo_restores_same_volume_move() {
        let mut fixture = Fixture::new();
        let work = fixture.work("work-a");
        fixture.file(work, r"work-a\1.png", 10);

        let target_id = fixture.target_id;
        let run = run(&mut fixture, work, target_id);
        let batch = run.undo.expect("同一ボリュームは Undo できる");
        let undo_id = run.outcome.undo_id.clone().unwrap();
        assert_eq!(batch.id, undo_id);

        let result = undo(&mut fixture.conn, &batch).unwrap();
        assert!(result.restored);
        assert_eq!(result.root_ids, vec![fixture.source_id, fixture.target_id]);
        assert!(fixture.source_work_path("work-a").join("1.png").is_file());
        assert!(!fixture.target_work_path("work-a").exists());
        let (root_id, rel_path, title) = work_location(&fixture.conn, work);
        assert_eq!(root_id, fixture.source_id);
        assert_eq!(rel_path, "work-a");
        assert_eq!(title, "work-a");
        assert_eq!(file_rel_paths(&fixture.conn, work), vec![r"work-a\1.png"]);
    }

    #[test]
    fn nested_work_keeps_relative_file_layout() {
        let mut fixture = Fixture::new();
        let work = fixture.work(r"parent\work-a");
        fixture.file(work, r"parent\work-a\1.png", 8);

        let target_id = fixture.target_id;
        let run = run(&mut fixture, work, target_id);
        assert!(run.outcome.moved);
        assert_eq!(work_location(&fixture.conn, work).1, "work-a");
        assert_eq!(file_rel_paths(&fixture.conn, work), vec![r"work-a\1.png"]);
    }
}
