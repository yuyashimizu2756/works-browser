//! メディア配信（カスタム URI スキーム `wbm`）。
//!
//! 作品詳細（#5）のライトボックス / プレイヤーは、10GB の動画でもメモリに
//! 載せずにシークできる必要がある。`asset` protocol はサムネイル用のディレクトリ
//! しか許可していないので、`files.id` だけを受け取って DB から実パスを引き、
//! HTTP の `Range` に応じて必要な範囲だけ読む専用スキームを用意する。
//!
//! - URL は `convertFileSrc(String(file_id), "wbm")`
//!   （Windows では `http://wbm.localhost/<file_id>`）
//! - `Range: bytes=start-end` / `bytes=start-` / `bytes=-suffix` に対応
//! - 応答は 1 回あたり最大 8MB（動画）。開いたままの巨大ファイルでもメモリは増えない
//! - 動画の拡張子から Content-Type を決める（WebView2 が再生できるのは mp4 / webm など）

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};

use crate::index::db;

/// カスタムスキーム名。`convertFileSrc(path, "wbm")` と一致させる。
pub const SCHEME: &str = "wbm";

/// 1 応答で返す最大バイト数（動画）。プレイヤーは続きを Range で取りに来る。
pub const MAX_VIDEO_CHUNK: u64 = 8 * 1024 * 1024;

/// 画像は `<img>` が Range を送らないことがあるので少し大きめに許す。
pub const MAX_IMAGE_CHUNK: u64 = 32 * 1024 * 1024;

/// `Range` ヘッダの解釈結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedRange {
    /// Range なし（全体を返す）。
    Full,
    /// 返す範囲（両端を含む）。
    Partial { start: u64, end: u64 },
    /// `start` がファイル長以上（416 を返す）。
    Unsatisfiable,
}

/// `Range: bytes=...` を解釈する。壊れた書式は `Full`（Range 無視）として扱う。
///
/// 複数範囲（`bytes=0-1,5-6`）は先頭の 1 つだけを使う。マルチパート応答は
/// 動画のシークには不要で、実装を増やすほど壊れやすいため。
pub fn parse_range(value: &str, len: u64) -> ParsedRange {
    if len == 0 {
        return ParsedRange::Unsatisfiable;
    }
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return ParsedRange::Full;
    };
    let Some(first) = spec.split(',').next().map(str::trim) else {
        return ParsedRange::Full;
    };
    let Some((start_raw, end_raw)) = first.split_once('-') else {
        return ParsedRange::Full;
    };

    if start_raw.is_empty() {
        // `bytes=-N` … 末尾 N バイト
        let Ok(suffix) = end_raw.trim().parse::<u64>() else {
            return ParsedRange::Full;
        };
        if suffix == 0 {
            return ParsedRange::Unsatisfiable;
        }
        let start = len.saturating_sub(suffix);
        return ParsedRange::Partial {
            start,
            end: len - 1,
        };
    }

    let Ok(start) = start_raw.trim().parse::<u64>() else {
        return ParsedRange::Full;
    };
    if start >= len {
        return ParsedRange::Unsatisfiable;
    }
    let end = if end_raw.trim().is_empty() {
        len - 1
    } else {
        match end_raw.trim().parse::<u64>() {
            Ok(end) => end.min(len - 1),
            Err(_) => return ParsedRange::Full,
        }
    };
    if end < start {
        return ParsedRange::Unsatisfiable;
    }
    ParsedRange::Partial { start, end }
}

/// 拡張子から Content-Type を決める（WebView2 が判断に使う）。
pub fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "ts" => "video/mp2t",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// URI のパス（`/12` や `/12?x`）から `files.id` を取り出す。
pub fn file_id_from_path(path: &str) -> Option<i64> {
    let trimmed = path.trim_start_matches('/');
    let segment = trimmed.split(['/', '?']).next()?;
    segment.parse::<i64>().ok().filter(|id| *id > 0)
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// 1 リクエストを処理して HTTP レスポンスを返す。
///
/// DB から `files.id` → 絶対パスを引き、`Range` に応じてファイルの一部だけを読む。
/// 失敗時は 400 / 404 / 416 / 500 を返す（UI は `<img>` / `<video>` の error で拾う）。
pub fn respond(db_path: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let Some(file_id) = file_id_from_path(request.uri().path()) else {
        return error_response(StatusCode::BAD_REQUEST, "file id が不正です");
    };

    let conn = match db::open(db_path) {
        Ok(conn) => conn,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("索引を開けません: {error}"),
            )
        }
    };
    let path: Option<PathBuf> = match db::file_absolute_path(&conn, file_id) {
        Ok(path) => path,
        Err(error) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("パスを取得できません: {error}"),
            )
        }
    };
    let Some(path) = path else {
        return error_response(StatusCode::NOT_FOUND, "ファイルが見つかりません");
    };

    match serve_file(&path, request.headers().get(header::RANGE)) {
        Ok(response) => response,
        Err(error) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &error),
    }
}

fn serve_file(
    path: &Path,
    range_header: Option<&tauri::http::HeaderValue>,
) -> Result<Response<Vec<u8>>, String> {
    let meta = std::fs::metadata(path).map_err(|error| format!("読み取れません: {error}"))?;
    if !meta.is_file() {
        return Err("ファイルではありません".to_string());
    }
    let total = meta.len();
    let mime = mime_for(path);
    let chunk_limit = if mime.starts_with("image/") {
        MAX_IMAGE_CHUNK
    } else {
        MAX_VIDEO_CHUNK
    };

    let parsed = match range_header.and_then(|value| value.to_str().ok()) {
        Some(value) => parse_range(value, total),
        None => ParsedRange::Full,
    };

    let (status, start, end) = match parsed {
        ParsedRange::Unsatisfiable => {
            return Ok(Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .unwrap_or_else(|_| Response::new(Vec::new())));
        }
        ParsedRange::Partial { start, end } => {
            let end = end.min(start + chunk_limit - 1);
            (StatusCode::PARTIAL_CONTENT, start, end)
        }
        ParsedRange::Full => {
            // Range なしでも巨大ファイルは先頭チャンクだけ返し、続きは Range で来させる
            let end = (total - 1).min(chunk_limit - 1);
            let status = if end + 1 < total {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            };
            (status, 0, end)
        }
    };

    let length = end - start + 1;
    let mut buffer = vec![0_u8; length as usize];
    let mut file = File::open(path).map_err(|error| format!("開けません: {error}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("シークできません: {error}"))?;
    file.read_exact(&mut buffer)
        .map_err(|error| format!("読み込めません: {error}"))?;

    let builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "private, max-age=0")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("cross-origin-resource-policy", "cross-origin");

    let builder = if status == StatusCode::PARTIAL_CONTENT {
        builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        )
    } else {
        builder
    };

    builder
        .body(buffer)
        .map_err(|error| format!("応答を作れません: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_closed_open_and_suffix_ranges() {
        assert_eq!(
            parse_range("bytes=0-99", 1000),
            ParsedRange::Partial { start: 0, end: 99 }
        );
        assert_eq!(
            parse_range("bytes=500-", 1000),
            ParsedRange::Partial {
                start: 500,
                end: 999
            }
        );
        assert_eq!(
            parse_range("bytes=-100", 1000),
            ParsedRange::Partial {
                start: 900,
                end: 999
            }
        );
        // 末尾を超える end はファイル末尾に丸める
        assert_eq!(
            parse_range("bytes=900-5000", 1000),
            ParsedRange::Partial {
                start: 900,
                end: 999
            }
        );
        // 複数範囲は先頭だけ
        assert_eq!(
            parse_range("bytes=10-19,30-39", 1000),
            ParsedRange::Partial { start: 10, end: 19 }
        );
    }

    #[test]
    fn rejects_out_of_bounds_and_ignores_garbage() {
        assert_eq!(parse_range("bytes=1000-", 1000), ParsedRange::Unsatisfiable);
        assert_eq!(parse_range("bytes=-0", 1000), ParsedRange::Unsatisfiable);
        assert_eq!(parse_range("bytes=50-10", 1000), ParsedRange::Unsatisfiable);
        assert_eq!(parse_range("items=0-10", 1000), ParsedRange::Full);
        assert_eq!(parse_range("bytes=abc-def", 1000), ParsedRange::Full);
        assert_eq!(parse_range("", 1000), ParsedRange::Full);
        assert_eq!(parse_range("bytes=0-0", 0), ParsedRange::Unsatisfiable);
    }

    #[test]
    fn maps_extensions_to_content_types() {
        assert_eq!(mime_for(Path::new("a.MP4")), "video/mp4");
        assert_eq!(mime_for(Path::new("a.webm")), "video/webm");
        assert_eq!(mime_for(Path::new("C:\\work\\a.mkv")), "video/x-matroska");
        assert_eq!(mime_for(Path::new("thumb.JPEG")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.avif")), "image/avif");
        assert_eq!(mime_for(Path::new("a.txt")), "application/octet-stream");
    }

    #[test]
    fn reads_file_id_from_uri_path() {
        assert_eq!(file_id_from_path("/12"), Some(12));
        assert_eq!(file_id_from_path("/12?x=1"), Some(12));
        assert_eq!(file_id_from_path("34/"), Some(34));
        assert_eq!(file_id_from_path("/"), None);
        assert_eq!(file_id_from_path("/abc"), None);
        assert_eq!(file_id_from_path("/0"), None);
    }

    fn range(value: &'static str) -> tauri::http::HeaderValue {
        tauri::http::HeaderValue::from_static(value)
    }

    #[test]
    fn serves_requested_range_without_reading_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        std::fs::write(&path, vec![7_u8; 100]).unwrap();

        let response = serve_file(&path, Some(&range("bytes=10-19"))).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &[7_u8; 10]);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_RANGE)
                .unwrap()
                .to_str()
                .unwrap(),
            "bytes 10-19/100"
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "video/mp4"
        );
        assert_eq!(
            response
                .headers()
                .get(header::ACCEPT_RANGES)
                .unwrap()
                .to_str()
                .unwrap(),
            "bytes"
        );

        // 末尾まで（suffix）
        let response = serve_file(&path, Some(&range("bytes=-5"))).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), 5);

        // 範囲外は 416
        let response = serve_file(&path, Some(&range("bytes=500-"))).unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_RANGE)
                .unwrap()
                .to_str()
                .unwrap(),
            "bytes */100"
        );
    }

    #[test]
    fn serves_small_file_in_full_with_mime_type() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("photo.png");
        std::fs::write(&path, vec![1_u8; 32]).unwrap();

        let response = serve_file(&path, None).unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().len(), 32);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
    }

    #[test]
    fn caps_video_responses_so_huge_files_stay_off_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.mp4");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_VIDEO_CHUNK * 3).unwrap();

        let response = serve_file(&path, None).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len() as u64, MAX_VIDEO_CHUNK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_RANGE)
                .unwrap()
                .to_str()
                .unwrap(),
            format!(
                "bytes 0-{}/{total}",
                MAX_VIDEO_CHUNK - 1,
                total = MAX_VIDEO_CHUNK * 3
            )
        );
    }

    #[test]
    fn resolves_file_id_through_the_index_and_serves_the_range() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("作品")).unwrap();
        let path = root.join("作品").join("a.mp4");
        std::fs::write(&path, (0..64_u8).collect::<Vec<_>>()).unwrap();

        let db_path = dir.path().join("index.db");
        {
            let conn = db::open(&db_path).unwrap();
            conn.execute(
                "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
                 VALUES ('r', ?1, 'r', 1, 1, 0)",
                [root.to_string_lossy().to_string()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO works(id, root_id, rel_path, title, kind, file_count, total_bytes,
                    mtime, created_at, updated_at)
                 VALUES (1, 1, '作品', '作品', 'video', 1, 64, 0, 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files(id, work_id, rel_path, name, kind, bytes, mtime)
                 VALUES (1, 1, '作品/a.mp4', 'a.mp4', 'video', 64, 0)",
                [],
            )
            .unwrap();
        }

        let request = Request::builder()
            .uri("/1")
            .header(header::RANGE, "bytes=4-7")
            .body(Vec::new())
            .unwrap();
        let response = respond(&db_path, &request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().as_slice(), &[4_u8, 5, 6, 7]);
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 4-7/64"
        );

        // 存在しない ID は 404
        let request = Request::builder().uri("/999").body(Vec::new()).unwrap();
        assert_eq!(respond(&db_path, &request).status(), StatusCode::NOT_FOUND);

        // ID でないパスは 400
        let request = Request::builder()
            .uri("/etc/passwd")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            respond(&db_path, &request).status(),
            StatusCode::BAD_REQUEST
        );
    }
}
