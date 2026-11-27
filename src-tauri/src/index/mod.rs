//! 走査と SQLite 索引の中核。
//!
//! - [`db`]  … 接続・マイグレーション・問い合わせ
//! - [`scan`] … walkdir + rayon による走査と差分更新
//!
//! 設計は `docs/scan-design.md` を参照。

pub mod db;
pub mod scan;
pub mod watch;

#[cfg(test)]
mod file_tests;
#[cfg(test)]
mod gallery_tests;
#[cfg(test)]
mod meta_tests;
#[cfg(test)]
mod perf;
#[cfg(test)]
mod smart_tests;
#[cfg(test)]
mod tag_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod watch_tests;

use std::path::Path;

/// 索引に載せる画像拡張子（小文字）。
pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];

/// 索引に載せる動画拡張子（小文字）。
///
/// `.ts` は TypeScript のソースと衝突するため既定では含めない（#39）。
/// MPEG-TS として索引したい場合だけ、設定 `index_mpeg_ts` を有効にする。
pub const VIDEO_EXT: &[&str] = &["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv"];

/// 設定で有効化できる MPEG-TS の拡張子（小文字）。
pub const MPEG_TS_EXT: &str = "ts";

/// 走査・索引まわりのエラー。
#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("{path} を読み取れません: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("データベースエラー: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("{0} は存在するディレクトリではありません")]
    NotADirectory(String),

    #[error("depth は 0〜{max} の範囲で指定してください（指定値: {got}）")]
    InvalidDepth { max: i64, got: i64 },

    #[error("ルート {0} は登録されていません")]
    RootNotFound(i64),

    #[error("走査は既に実行中です")]
    AlreadyScanning,

    #[error("未対応の並び順です: {0}")]
    InvalidSort(String),

    #[error("未対応の種別フィルタです: {0}")]
    InvalidKind(String),

    #[error("作品 {0} は索引にありません")]
    WorkNotFound(i64),

    #[error("タグ {0} は存在しません")]
    TagNotFound(i64),

    #[error("タグ名が不正です: {0}")]
    InvalidTag(String),

    #[error("評価は 1〜5 で指定してください（指定値: {0}）")]
    InvalidRating(i64),

    #[error("スマートフォルダ {0} は存在しません")]
    SmartFolderNotFound(i64),

    #[error("スマートフォルダの内容が不正です: {0}")]
    InvalidSmartFolder(String),

    #[error(
        "DB のスキーマバージョン {found} がアプリの対応版 {supported} より新しいため開けません"
    )]
    SchemaTooNew { found: i64, supported: i64 },
}

pub type Result<T> = std::result::Result<T, IndexError>;

/// パスからファイル種別を判定する。索引対象外なら `None`。
///
/// `index_mpeg_ts` が `true` のときだけ `.ts` を動画として扱う（既定は `false`）。
/// TypeScript のソースを動画として索引しないための区別（#39）。
pub fn file_kind(path: &Path, index_mpeg_ts: bool) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if IMAGE_EXT.contains(&ext.as_str()) {
        Some("image")
    } else if VIDEO_EXT.contains(&ext.as_str()) || (index_mpeg_ts && ext == MPEG_TS_EXT) {
        Some("video")
    } else {
        None
    }
}

/// ファイルの実体を表す `(volume_serial, file_index)`。
///
/// Windows の `std::os::windows::fs::MetadataExt::volume_serial_number` /
/// `file_index` はまだ不安定 API なので、`GetFileInformationByHandle` を直接使う。
#[cfg(windows)]
pub fn file_identity(path: &Path) -> Option<(u32, u64)> {
    use std::fs::File;

    let file = File::open(path).ok()?;
    handle_identity(&file)
}

/// フォルダも含めた実体 ID。ディレクトリは `File::open` できないため、
/// `FILE_FLAG_BACKUP_SEMANTICS` を付けて開く（ルート追加時の重複検出用）。
#[cfg(windows)]
pub fn path_identity(path: &Path) -> Option<(u32, u64)> {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    handle_identity(&file)
}

#[cfg(windows)]
fn handle_identity(file: &std::fs::File) -> Option<(u32, u64)> {
    use std::mem::MaybeUninit;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut info = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: `file` はこのスコープで有効なハンドルで、`info` は書き込み可能な領域。
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) };
    if ok == 0 {
        return None;
    }
    // SAFETY: 呼び出しが成功したので `info` は初期化済み。
    let info = unsafe { info.assume_init() };
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Some((info.dwVolumeSerialNumber, index))
}

#[cfg(not(windows))]
fn handle_identity(_file: &std::fs::File) -> Option<(u32, u64)> {
    None
}

/// 1 回の `open` でメタデータと実体 ID をまとめて取る（#50）。
///
/// 以前は `fs::metadata` と実体 ID 用の `File::open` で **2 回**開いていた。
/// 走査では 1 ファイルあたりの open が支配的なので 1 回にまとめる。
/// open だけが失敗するファイル（ロック中など）は従来どおりメタデータのみで索引する。
pub(crate) fn metadata_and_identity(
    path: &Path,
) -> Option<(std::fs::Metadata, Option<(u32, u64)>)> {
    match std::fs::File::open(path) {
        Ok(file) => {
            let meta = file.metadata().ok()?;
            Some((meta, handle_identity(&file)))
        }
        Err(_) => Some((std::fs::metadata(path).ok()?, None)),
    }
}

/// 非 Windows では実体 ID を取得しない（重複判定はパス基準のみ）。
#[cfg(not(windows))]
pub fn file_identity(_path: &Path) -> Option<(u32, u64)> {
    None
}

/// 非 Windows では実体 ID を取得しない（重複判定はパス基準のみ）。
#[cfg(not(windows))]
pub fn path_identity(_path: &Path) -> Option<(u32, u64)> {
    None
}
