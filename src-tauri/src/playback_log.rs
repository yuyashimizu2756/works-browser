//! #32: 再生診断ログ（`%APPDATA%\works-browser\playback.log`）。
//!
//! 起動後 1 本目の動画が再生されない問題を実機で追うため、UI が整形した
//! 1 行を受け取ってそのまま追記する。パス・追記方法・改行の扱いは Rust 側で
//! 決め、UI からは文字列だけを渡す。
//!
//! 失敗しても再生は止めない（呼び出し側はエラーを握りつぶしてよい）。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 1 行の上限。壊れた / 巨大な文字列でディスクを埋めないための保険。
pub const MAX_LINE_CHARS: usize = 8_000;

/// 設定ファイルと同じディレクトリの `playback.log`。
///
/// 既定は `%APPDATA%\works-browser\playback.log`。`WORKS_BROWSER_CONFIG` で
/// 設定の場所を変えている開発時は、その隣に書く。
pub fn log_path(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .map(|dir| dir.join("playback.log"))
        .unwrap_or_else(|| PathBuf::from("playback.log"))
}

/// 1 行として安全な形にする（改行を空白へ、長すぎる行を切り詰める）。
pub fn sanitize(line: &str) -> String {
    line.chars()
        .take(MAX_LINE_CHARS)
        .map(|ch| if ch == '\r' || ch == '\n' { ' ' } else { ch })
        .collect::<String>()
        .trim()
        .to_string()
}

/// 1 行を追記する。親ディレクトリが無ければ作る。空行は書かない。
pub fn append(path: &Path, line: &str) -> std::io::Result<()> {
    let line = sanitize(line);
    if line.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn log_path_sits_next_to_config() {
        let path = log_path(Path::new(
            r"C:\Users\me\AppData\Roaming\works-browser\config.json",
        ));
        assert_eq!(
            path,
            PathBuf::from(r"C:\Users\me\AppData\Roaming\works-browser\playback.log")
        );
    }

    #[test]
    fn sanitize_keeps_one_line_and_caps_length() {
        assert_eq!(sanitize("a\r\nb\n c "), "a  b  c");
        let long = "x".repeat(MAX_LINE_CHARS + 20);
        assert_eq!(sanitize(&long).chars().count(), MAX_LINE_CHARS);
    }

    #[test]
    fn append_creates_directory_and_adds_lines() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("playback.log");

        append(&path, "2026-01-01T00:00:00.000Z event=play-reject fileId=7").unwrap();
        append(&path, "second line\nmust stay one line").unwrap();
        // 空行は書かない（行番号を無駄に進めない）
        append(&path, "   ").unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            "2026-01-01T00:00:00.000Z event=play-reject fileId=7\nsecond line must stay one line\n"
        );
    }
}
