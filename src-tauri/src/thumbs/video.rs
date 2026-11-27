//! 動画サムネイル（ffmpeg で 1 フレーム抜き出して WebP 化）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{photo, ThumbError, FFMPEG_FALLBACK, VIDEO_FALLBACK_SECS, VIDEO_OFFSET_RATIO};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// ffmpeg を「設定 → 同梱 sidecar → PATH → 既定候補」の順で探す。
///
/// 返り値の 2 つ目は発見元（UI に出す）: `setting` / `sidecar` / `path` / `fallback` / `none`。
/// sidecar は Tauri の `bundle.externalBin`（#9）でアプリと同じフォルダに置かれる `ffmpeg.exe`。
pub fn resolve(configured: Option<&str>) -> (Option<PathBuf>, &'static str) {
    if let Some(configured) = configured {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if is_usable(&candidate) {
                return (Some(candidate), "setting");
            }
        }
    }

    if let Some(found) = find_sidecar() {
        return (Some(found), "sidecar");
    }

    if let Some(found) = find_on_path() {
        return (Some(found), "path");
    }

    let fallback = PathBuf::from(FFMPEG_FALLBACK);
    if is_usable(&fallback) {
        return (Some(fallback), "fallback");
    }

    (None, "none")
}

/// 実行できる可能性のあるファイルか。
///
/// CI では `bundle.externalBin` の存在チェックを通すために 0 バイトの
/// スタブを置く（`.github/workflows/ci.yml`）。それを ffmpeg と誤認しないよう、
/// 空ファイルは候補から外す。
fn is_usable(path: &Path) -> bool {
    path.metadata()
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

/// アプリの exe と同じフォルダの ffmpeg（Tauri sidecar）。
fn find_sidecar() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let candidate = dir.join(name);
    is_usable(&candidate).then_some(candidate)
}

fn find_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: &[&str] = if cfg!(windows) {
        &["ffmpeg.exe", "ffmpeg"]
    } else {
        &["ffmpeg"]
    };

    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if is_usable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn command(ffmpeg: &Path) -> Command {
    let mut command = Command::new(ffmpeg);
    // #50: 1 プロセス 1 スレッドに固定し、プロセス並列を増やす。
    // ffmpeg の既定は入力の解像度に応じて多数のスレッドを立てるため、
    // 8 並列でも CPU が飽和してサムネイルの完了が遅くなっていた。
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "1",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 子プロセスのコンソールウィンドウを出さない
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 動画から 1 フレーム抜き出して WebP のバイト列を返す。
///
/// 10% 地点 → 1 秒地点 → 先頭、の順に試す。duration が DB に無ければ ffmpeg の
/// 出力から読み取り、更新用に返す（`Option<i64>`）。
pub fn thumbnail(
    ffmpeg: &Path,
    input: &Path,
    duration_ms: Option<i64>,
    max_edge: u32,
    quality: f32,
    scratch_dir: &Path,
) -> (Result<Vec<u8>, ThumbError>, Option<i64>) {
    // 10% 地点を狙うには尺が要る。DB に無ければ ffmpeg の stderr から 1 回だけ測る。
    let duration = duration_ms.or_else(|| probe_duration_ms(ffmpeg, input));

    let mut last_error = None;
    for seconds in offsets(duration) {
        match extract_webp(ffmpeg, input, seconds, max_edge, quality, scratch_dir) {
            Ok(bytes) => return (Ok(bytes), duration),
            Err(error) => last_error = Some(error),
        }
    }

    (
        Err(last_error.unwrap_or_else(|| ThumbError::VideoFrame("フレームを取得できません".into()))),
        duration,
    )
}

/// 試す位置（秒）。重複は除き、duration を超える位置は捨てる。
fn offsets(duration_ms: Option<i64>) -> Vec<f64> {
    let mut candidates = Vec::new();
    if let Some(ms) = duration_ms.filter(|ms| *ms > 0) {
        candidates.push(ms as f64 / 1000.0 * VIDEO_OFFSET_RATIO);
    }
    candidates.push(VIDEO_FALLBACK_SECS);
    candidates.push(0.0);

    let max = duration_ms
        .filter(|ms| *ms > 0)
        .map(|ms| (ms as f64 / 1000.0 - 0.05).max(0.0));

    let mut unique: Vec<f64> = Vec::new();
    for seconds in candidates {
        let seconds = seconds.max(0.0);
        if let Some(max) = max {
            if seconds > max {
                continue;
            }
        }
        if unique.iter().any(|value| (value - seconds).abs() < 0.01) {
            continue;
        }
        unique.push(seconds);
    }

    if unique.is_empty() {
        unique.push(0.0);
    }
    unique
}

fn extract_webp(
    ffmpeg: &Path,
    input: &Path,
    seconds: f64,
    max_edge: u32,
    quality: f32,
    scratch_dir: &Path,
) -> Result<Vec<u8>, ThumbError> {
    std::fs::create_dir_all(scratch_dir).map_err(|error| ThumbError::io(scratch_dir, error))?;

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = scratch_dir.join(format!(".frame-{}-{counter}.png", std::process::id()));

    let output = command(ffmpeg)
        .arg("-ss")
        .arg(format!("{seconds:.3}"))
        .arg("-i")
        .arg(input)
        .arg("-map")
        .arg("0:v:0")
        .args(["-frames:v", "1", "-an", "-sn", "-dn"])
        .arg("-vf")
        .arg(format!("scale={max_edge}:-2"))
        .arg("-f")
        .arg("image2")
        .arg(&temp)
        .output()
        .map_err(|error| ThumbError::io(ffmpeg, error))?;

    if !output.status.success() || !temp.is_file() {
        let _ = std::fs::remove_file(&temp);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .unwrap_or("ffmpeg がフレームを書き出しませんでした");
        return Err(ThumbError::Ffmpeg(message.to_string()));
    }

    let result = photo::thumbnail(&temp, max_edge, quality);
    let _ = std::fs::remove_file(&temp);
    result
}

/// `ffmpeg -i` の stderr から尺（ミリ秒）を読む。
pub fn probe_duration_ms(ffmpeg: &Path, input: &Path) -> Option<i64> {
    // 尺は info レベルでしか出ないので、ここだけ loglevel を上げる（後勝ち）
    let output = command(ffmpeg)
        .args(["-loglevel", "info", "-i"])
        .arg(input)
        .output()
        .ok()?;
    parse_duration_ms(&String::from_utf8_lossy(&output.stderr))
}

/// `Duration: HH:MM:SS.cc` をミリ秒にする。
fn parse_duration_ms(stderr: &str) -> Option<i64> {
    for line in stderr.lines() {
        let Some(index) = line.find("Duration:") else {
            continue;
        };
        let rest = line[index + "Duration:".len()..].trim_start();
        let stamp = rest.split(',').next()?.trim();
        let mut parts = stamp.split(':');

        let hours: f64 = parts.next()?.trim().parse().ok()?;
        let minutes: f64 = parts.next()?.trim().parse().ok()?;
        let seconds: f64 = parts.next()?.trim().parse().ok()?;

        let total = (hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0;
        if total.is_finite() && total >= 0.0 {
            return Some(total.round() as i64);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_duration_line() {
        let stderr = "  Duration: 00:01:23.45, start: 0.000000, bitrate: 1234 kb/s";
        assert_eq!(parse_duration_ms(stderr), Some(83_450));

        let stderr = "Input #0, mov,mp4\n  Duration: 00:00:02.00, start: 0.0, bitrate: 1 kb/s";
        assert_eq!(parse_duration_ms(stderr), Some(2_000));

        assert_eq!(parse_duration_ms("Duration: N/A, bitrate: N/A"), None);
        assert_eq!(parse_duration_ms("no duration here"), None);
    }

    #[test]
    fn offsets_try_ten_percent_then_one_second() {
        assert_eq!(offsets(None), vec![1.0, 0.0]);
        assert_eq!(offsets(Some(10_000)), vec![1.0, 0.0]);
        assert_eq!(offsets(Some(60_000)), vec![6.0, 1.0, 0.0]);
        // 短い動画では 10% と 1 秒が別位置になる
        assert_eq!(offsets(Some(2_000)), vec![0.2, 1.0, 0.0]);
    }

    #[test]
    fn resolve_prefers_the_configured_path() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        std::fs::write(&fake, b"stub").unwrap();

        let (found, source) = resolve(Some(fake.to_str().unwrap()));
        assert_eq!(source, "setting");
        assert_eq!(found.as_deref(), Some(fake.as_path()));

        // 存在しない設定値は無視して次の候補へ（この環境では何か見つかるかも）
        let (_, source) = resolve(Some("Z:\\nowhere\\ffmpeg.exe"));
        assert_ne!(source, "setting");
    }

    #[test]
    fn empty_ffmpeg_file_is_rejected() {
        // CI の sidecar スタブ（0 バイト）を ffmpeg と誤認しない
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("ffmpeg.exe");
        std::fs::write(&empty, b"").unwrap();

        let (found, source) = resolve(Some(empty.to_str().unwrap()));
        assert_ne!(source, "setting");
        assert_ne!(found.as_deref(), Some(empty.as_path()));
    }
}
