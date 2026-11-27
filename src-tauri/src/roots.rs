//! ルート追加の入口（#25）。
//!
//! - フォルダ選択ダイアログ / ドラッグ&ドロップで受け取ったパスの検証
//! - 最近追加したフォルダ（`meta.recent_roots`、最大 [`RECENT_LIMIT`] 件）
//! - ドライブ一覧と既知の候補
//!
//! 検証は「存在するか」「フォルダか」「読めるか」「ドライブ直下 / システム
//! フォルダか」「同じ実体のルートが既にあるか」を見る。追加そのものは
//! [`add_root`]（[`db::add_root`] + 最近使ったフォルダの更新）を使う。

use std::fs;
use std::path::{Component, Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::index::db::{self, Root};
use crate::index::{self, Result};

/// `meta` テーブルに最近追加したフォルダを入れるキー（JSON 配列）。
pub const RECENT_KEY: &str = "recent_roots";
/// 候補に出す最近追加したフォルダの最大件数。
pub const RECENT_LIMIT: usize = 10;

/// 実データでありがちな候補。存在するものだけ UI に出す。
const KNOWN_CANDIDATES: &[&str] = &[r"D:\ComfyUI\output", r"D:\Projects\Blender\03_generated"];

/// 1 つのパスの検証結果。UI はこれを並べて警告を出し、確認後に追加する。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathCheck {
    /// 入力（前後の空白・引用符を落とした表示パス）。
    pub path: String,
    /// `directory` | `file` | `missing`。
    pub kind: String,
    /// `D:\` のようなドライブ直下。
    pub is_drive_root: bool,
    /// `C:\Windows` / `Program Files` などのシステムフォルダ。
    pub is_system: bool,
    /// 同じ実体パス（`roots.real_path`）の既存ルート。深さの更新になる。
    pub duplicate_of: Option<i64>,
    /// `volume serial + file index` が一致する別ルート（junction / ハードリンク）。
    pub same_identity_root: Option<i64>,
    /// 確認してほしい内容（改行区切り）。
    pub warning: Option<String>,
    /// 追加できない理由。
    pub error: Option<String>,
}

impl PathCheck {
    fn new(path: String) -> Self {
        Self {
            path,
            kind: "missing".to_string(),
            is_drive_root: false,
            is_system: false,
            duplicate_of: None,
            same_identity_root: None,
            warning: None,
            error: None,
        }
    }
}

/// 最近追加したフォルダ・ドライブ・既知の候補。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RootSuggestions {
    pub recent: Vec<String>,
    pub drives: Vec<String>,
    pub known: Vec<String>,
}

/// 入力から前後の空白と引用符（エクスプローラの「パスをコピー」）を落とす。
pub fn clean_input(input: &str) -> String {
    input
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim()
        .to_string()
}

/// `D:\` や `C:/` のようなドライブ直下か。
pub fn is_drive_root(path: &Path) -> bool {
    let mut components = path.components();
    let prefix = components.next();
    let root = components.next();
    matches!(prefix, Some(Component::Prefix(_)))
        && matches!(root, Some(Component::RootDir))
        && components.next().is_none()
}

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

/// システムフォルダか（ドライブ直下は別扱い）。テストできるよう候補を渡す。
pub fn is_system_path_with(path: &Path, system_dirs: &[PathBuf]) -> bool {
    system_dirs.iter().any(|dir| is_within(path, dir))
}

/// 実際の OS 設定からシステムフォルダを集める。
pub fn system_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for key in [
        "SystemRoot",
        "WINDIR",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramData",
    ] {
        if let Some(value) = std::env::var_os(key) {
            if !value.is_empty() {
                dirs.push(PathBuf::from(value));
            }
        }
    }
    if dirs.is_empty() {
        // 環境変数が無いときのフォールバック（Windows の標準的な場所）
        dirs.push(PathBuf::from(r"C:\Windows"));
    }
    dirs
}

/// システムフォルダか。
pub fn is_system_path(path: &Path) -> bool {
    is_system_path_with(path, &system_dirs())
}

/// パスを検証する。UI は追加前にこれを呼んで警告・エラーを出す。
pub fn inspect_path(conn: &Connection, input: &str) -> PathCheck {
    inspect_path_with(conn, input, &system_dirs())
}

/// システムフォルダの候補を差し替えられる検証（テスト用）。
pub fn inspect_path_with(conn: &Connection, input: &str, system_dirs: &[PathBuf]) -> PathCheck {
    let cleaned = clean_input(input);
    let path = PathBuf::from(&cleaned);
    let mut check = PathCheck::new(db::display_path(&path));

    if cleaned.is_empty() {
        check.error = Some("フォルダのパスが空です".to_string());
        return check;
    }

    match fs::metadata(&path) {
        Err(source) => {
            check.error = Some(format!("フォルダが見つかりません: {source}"));
            return check;
        }
        Ok(meta) if !meta.is_dir() => {
            check.kind = "file".to_string();
            check.error =
                Some("フォルダではありません。フォルダをドロップしてください".to_string());
            return check;
        }
        Ok(_) => {
            check.kind = "directory".to_string();
        }
    }

    // 権限が無いフォルダは追加しても走査できないので、ここで読めるか確かめる。
    // （read_dir は列挙せずハンドルを開くだけ）
    if let Err(source) = fs::read_dir(&path) {
        check.error = Some(format!(
            "フォルダを開けません（権限が無い可能性があります）: {source}"
        ));
        return check;
    }

    check.is_drive_root = is_drive_root(&path);
    check.is_system = is_system_path_with(&path, system_dirs);

    // 同じ実体パスのルート（同じフォルダを追加し直した場合は深さの更新）
    if let Ok(real) = fs::canonicalize(&path) {
        let real = db::display_path(&real);
        check.duplicate_of = conn
            .query_row(
                "SELECT id FROM roots WHERE real_path = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
                [real],
                |row| row.get(0),
            )
            .ok();
    }

    // 別パスから同じ実体を見ているルート（junction / ハードリンク）を
    // volume serial + file index で検出する（#2 の仕組み）。
    if let Some(identity) = index::path_identity(&path) {
        if let Ok(roots) = db::list_roots(conn) {
            for info in roots {
                if check.duplicate_of == Some(info.root.id) {
                    continue;
                }
                if index::path_identity(Path::new(&info.root.real_path)) == Some(identity) {
                    check.same_identity_root = Some(info.root.id);
                    break;
                }
            }
        }
    }

    let mut warnings: Vec<String> = Vec::new();
    if let Some(id) = check.duplicate_of {
        warnings.push(format!(
            "既に登録済みのフォルダです（ルート #{id}）。追加すると深さだけ更新します"
        ));
    }
    if let Some(id) = check.same_identity_root {
        warnings.push(format!(
            "同じ実体のルート #{id} が既にあります。索引は先に追加した側だけを使います"
        ));
    }
    if check.is_drive_root {
        warnings
            .push("ドライブ直下です。対象外のファイルも多く、走査に時間がかかります".to_string());
    }
    if check.is_system {
        warnings
            .push("システムフォルダです。作品フォルダを選び直すことをおすすめします".to_string());
    }
    if !warnings.is_empty() {
        check.warning = Some(warnings.join("\n"));
    }

    check
}

/// 複数パスをまとめて検証する。順序は入力のまま。
pub fn inspect_paths(conn: &Connection, inputs: &[String]) -> Vec<PathCheck> {
    inputs
        .iter()
        .map(|input| inspect_path(conn, input))
        .collect()
}

/// 最近追加したフォルダ（新しい順、最大 [`RECENT_LIMIT`] 件）。
pub fn recent_roots(conn: &Connection) -> Vec<String> {
    db::get_meta(conn, RECENT_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .map(|list| {
            list.into_iter()
                .filter(|path| !path.trim().is_empty())
                .take(RECENT_LIMIT)
                .collect()
        })
        .unwrap_or_default()
}

/// 最近追加したフォルダの先頭に `path` を積む（重複は 1 件に畳む）。
pub fn remember_recent(conn: &Connection, path: &str) -> Result<Vec<String>> {
    let cleaned = clean_input(path);
    let mut list = recent_roots(conn);
    list.retain(|item| !item.eq_ignore_ascii_case(&cleaned));
    if !cleaned.is_empty() {
        list.insert(0, cleaned);
    }
    list.truncate(RECENT_LIMIT);
    let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string());
    db::set_meta(conn, RECENT_KEY, &json)?;
    Ok(list)
}

/// ルートを追加し、最近追加したフォルダも更新する。
pub fn add_root(conn: &Connection, path: &str, depth: i64) -> Result<Root> {
    let root = db::add_root(conn, path, depth)?;
    let _ = remember_recent(conn, &root.path);
    Ok(root)
}

/// ドライブのビットマスク（`GetLogicalDrives` の戻り値）を `C:\` の一覧にする。
pub fn drives_from_mask(mask: u32) -> Vec<String> {
    (0..26)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| format!("{}:\\", (b'A' + bit as u8) as char))
        .collect()
}

/// 存在するドライブの一覧。列挙は `GetLogicalDrives`（メディアの挿入確認をしない）。
#[cfg(windows)]
pub fn list_drives() -> Vec<String> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

    // SAFETY: 引数を取らず、失敗時は 0 を返すだけの Win32 API。
    drives_from_mask(unsafe { GetLogicalDrives() })
}

/// 非 Windows ではルートだけを返す（このアプリの配布対象は Windows）。
#[cfg(not(windows))]
pub fn list_drives() -> Vec<String> {
    vec!["/".to_string()]
}

/// 既知の候補のうち、実際に存在するフォルダ。
pub fn known_candidates() -> Vec<String> {
    KNOWN_CANDIDATES
        .iter()
        .filter(|path| Path::new(path).is_dir())
        .map(|path| (*path).to_string())
        .collect()
}

/// 候補一式（最近・ドライブ・既知）。
pub fn suggestions(conn: &Connection) -> RootSuggestions {
    RootSuggestions {
        recent: recent_roots(conn),
        drives: list_drives(),
        known: known_candidates(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn clean_input_trims_quotes_and_spaces() {
        assert_eq!(
            clean_input("  \" D:\\ComfyUI\\output \"  "),
            r"D:\ComfyUI\output"
        );
        assert_eq!(clean_input("'C:\\Temp'"), r"C:\Temp");
        assert_eq!(clean_input("   "), "");
    }

    #[test]
    fn drive_root_detection() {
        assert!(is_drive_root(Path::new(r"D:\")));
        assert!(is_drive_root(Path::new("C:/")));
        assert!(!is_drive_root(Path::new(r"D:\ComfyUI")));
        assert!(!is_drive_root(Path::new(r"D:")));
    }

    #[test]
    fn system_path_detection() {
        let dirs = vec![
            PathBuf::from(r"C:\Windows"),
            PathBuf::from(r"C:\Program Files"),
        ];
        assert!(is_system_path_with(Path::new(r"C:\Windows"), &dirs));
        assert!(is_system_path_with(
            Path::new(r"c:\windows\System32"),
            &dirs
        ));
        assert!(is_system_path_with(
            Path::new(r"C:\Program Files\Blender Foundation"),
            &dirs
        ));
        // 前方一致の別フォルダはシステム扱いしない
        assert!(!is_system_path_with(Path::new(r"C:\WindowsApps"), &dirs));
        assert!(!is_system_path_with(
            Path::new(r"C:\Users\me\Pictures"),
            &dirs
        ));
        assert!(!is_system_path_with(Path::new(r"D:\Windows"), &dirs));
    }

    #[test]
    fn drives_from_mask_lists_letters() {
        assert_eq!(
            drives_from_mask(0b101),
            vec![r"A:\".to_string(), r"C:\".to_string()]
        );
        assert_eq!(drives_from_mask(1 << 3), vec![r"D:\".to_string()]);
        assert!(drives_from_mask(0).is_empty());
    }

    #[test]
    fn recent_roots_are_deduped_and_capped() {
        let conn = db::open_in_memory().unwrap();
        for index in 0..15 {
            remember_recent(&conn, &format!(r"D:\work\{index}")).unwrap();
        }
        remember_recent(&conn, r"d:\WORK\10").unwrap();

        let recent = recent_roots(&conn);
        assert_eq!(recent.len(), RECENT_LIMIT);
        assert_eq!(recent[0], r"d:\WORK\10");
        assert_eq!(
            recent
                .iter()
                .filter(|path| path.eq_ignore_ascii_case(r"D:\work\10"))
                .count(),
            1
        );
    }

    #[test]
    fn inspect_directory_is_ok() {
        let conn = db::open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        let check = inspect_path(&conn, &dir.path().to_string_lossy());

        assert_eq!(check.kind, "directory");
        assert!(check.error.is_none());
        assert!(check.duplicate_of.is_none());
        assert!(!check.is_drive_root);
    }

    #[test]
    fn inspect_file_and_missing_path_report_errors() {
        let conn = db::open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.txt");
        fs::write(&file, b"hello").unwrap();

        let as_file = inspect_path(&conn, &file.to_string_lossy());
        assert_eq!(as_file.kind, "file");
        assert!(as_file.error.unwrap().contains("フォルダではありません"));

        let missing = inspect_path(&conn, &dir.path().join("nope").to_string_lossy());
        assert_eq!(missing.kind, "missing");
        assert!(missing.error.unwrap().contains("見つかりません"));
    }

    #[test]
    fn inspect_marks_registered_path_as_duplicate() {
        let conn = db::open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        let path = db::display_path(dir.path());
        let root = add_root(&conn, &path, 1).unwrap();

        let check = inspect_path(&conn, &path);
        assert_eq!(check.duplicate_of, Some(root.id));
        assert!(check.warning.unwrap().contains("既に登録済み"));
    }

    #[test]
    fn inspect_warns_about_system_folders() {
        let conn = db::open_in_memory().unwrap();
        let system = TempDir::new().unwrap();
        let inside = system.path().join("System32");
        fs::create_dir_all(&inside).unwrap();

        let dirs = vec![system.path().to_path_buf()];
        let check = inspect_path_with(&conn, &inside.to_string_lossy(), &dirs);
        assert!(check.is_system);
        assert!(check.warning.unwrap().contains("システムフォルダ"));
    }

    #[test]
    fn add_root_remembers_recent() {
        let conn = db::open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        let path = db::display_path(dir.path());
        add_root(&conn, &path, 2).unwrap();

        let recent = recent_roots(&conn);
        assert_eq!(recent, vec![path]);
    }

    #[cfg(windows)]
    #[test]
    fn directory_identity_is_available() {
        let dir = TempDir::new().unwrap();
        let first = index::path_identity(dir.path());
        let second = index::path_identity(dir.path());
        assert!(first.is_some());
        assert_eq!(first, second);
    }

    #[cfg(windows)]
    #[test]
    fn inspect_warns_about_drive_root() {
        let conn = db::open_in_memory().unwrap();
        let check = inspect_path_with(&conn, r"C:\", &[]);
        assert_eq!(check.kind, "directory");
        assert!(check.is_drive_root);
        assert!(check.warning.unwrap().contains("ドライブ直下"));
    }
}
