//! サムネイル配信（カスタム URI スキーム `thumb`）。
//!
//! `asset` protocol のスコープ設定に依存すると、Tauri のバージョンやパス変数の
//! 解釈で `<img>` が空になる事故が起きる（実測: `$LOCALAPPDATA` は v2 では無効）。
//! そのため、キャッシュディレクトリ配下の `.webp` だけを返す専用スキームを使う。
//!
//! - URL は `convertFileSrc("<hash>.webp", "thumb")`
//!   （Windows では `http://thumb.localhost/<hash>.webp`）
//! - 返すのは `%LOCALAPPDATA%\works-browser\thumbs` 直下の `*.webp` のみ
//! - ディレクトリ区切りや `..` を含むパスは拒否する

use std::path::PathBuf;

use tauri::http::{header, Request, Response, StatusCode};

/// カスタムスキーム名。`convertFileSrc(name, "thumb")` と一致させる。
pub const SCHEME: &str = "thumb";

/// サムネイルキャッシュのディレクトリ。
pub fn cache_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("works-browser").join("thumbs")
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(b"not found".to_vec())
        .expect("静的ヘッダのため失敗しない")
}

/// リクエストされたサムネイルを返す。
pub fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path();
    let name = path.trim_start_matches('/');

    // 直下の `<hex>.webp` だけを許可する（トラバーサル・別ディレクトリを拒否）
    if name.is_empty()
        || name.len() > 96
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.ends_with(".webp")
        || !name
            .trim_end_matches(".webp")
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return not_found();
    }

    match std::fs::read(cache_dir().join(name)) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/webp")
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .body(bytes)
            .unwrap_or_else(|_| not_found()),
        Err(_) => not_found(),
    }
}
