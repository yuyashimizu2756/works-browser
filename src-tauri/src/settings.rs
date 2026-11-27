//! 設定画面（#8）の集約 API。
//!
//! `%APPDATA%\works-browser\config.json`（[`crate::config`]）と索引 DB
//! （ルート一覧・サムネイル設定）を 1 つの [`Settings`] にまとめて UI に返す。
//! UI は `get_settings` / `update_settings` だけを呼び、`config.json` の
//! 読み書きやサムネイル設定の同期を意識しない。
//!
//! - 設定の正は `config.json`。`update_settings` は保存後に必ず再読み込みする。
//! - ルート（パス・深さ・有効 / 無効）は索引 DB が正。走査対象そのものなので
//!   設定ファイルには複製しない。
//! - サムネイルの品質・上限・ffmpeg は `config.json` を正とし、#3 の既存
//!   `meta` 設定にも同期する（古いコード経路でも同じ値になるように）。

use std::path::Path;
use std::process::Command;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::config::{self, AppConfig};
use crate::index::db::{self, RootInfo};
use crate::thumbs::{self, video, ThumbConfig, ThumbSettings, ThumbSettingsUpdate};

/// `get_settings` の戻り値。
#[derive(Debug, Clone, Serialize)]
pub struct Settings {
    /// アプリ設定（`config.json` の内容）。
    pub config: AppConfig,
    /// 設定ファイルのパス（UI に表示する）。
    pub config_path: String,
    /// 登録済みルート（無効化したものも含む）。
    pub roots: Vec<RootInfo>,
    /// 実効のサムネイル設定。
    pub thumbs: ThumbSettings,
    /// キャッシュの使用量。
    pub cache: thumbs::CacheUsage,
    /// ffmpeg の検出結果。
    pub ffmpeg: FfmpegProbe,
}

/// ffmpeg の検出結果。
#[derive(Debug, Clone, Default, Serialize)]
pub struct FfmpegProbe {
    /// 見つかった実行ファイル（無ければ `None`）。
    pub path: Option<String>,
    /// `setting` / `sidecar` / `path` / `fallback` / `none`。
    pub source: String,
    /// `ffmpeg -version` の 1 行目。
    pub version: Option<String>,
    /// 指定パスが見つからない等の理由。
    pub error: Option<String>,
}

/// `update_settings` の差分。指定した項目だけ更新する。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SettingsPatch {
    pub view_mode: Option<String>,
    pub thumbnails_visible: Option<bool>,
    pub shield_hotkey: Option<String>,
    pub shield_hold_ms: Option<u32>,
    pub shield_start_hidden: Option<bool>,
    pub shield_appearance: Option<String>,
    /// 1 行 1 glob。空配列なら何も除外しない（既定に戻すのは UI 側）。
    pub exclude_patterns: Option<Vec<String>>,
    /// 空文字で自動検出に戻す。
    pub ffmpeg_path: Option<String>,
    pub thumb_quality: Option<f32>,
    pub thumb_cache_limit_mb: Option<u32>,
    pub remember_volume: Option<bool>,
    /// #73: ComfyUI の URL。空文字は既定（ローカル）に丸める。
    pub comfy_url: Option<String>,
    /// #73: ComfyUI の workflows フォルダ（空 = 未設定）。
    pub comfy_workflows_dir: Option<String>,
}

/// 設定を集約して返す。
pub fn get(conn: &Connection, config_path: &Path) -> Result<Settings, String> {
    let app = config::load(config_path);
    let thumb_config = effective_thumb_config(conn, &app)?;
    let limit_bytes = app.thumb_cache_limit_bytes();
    let cache = thumbs::cache_usage(&thumb_config.cache_dir, limit_bytes);
    let ffmpeg = if app.ffmpeg_path.trim().is_empty() {
        probe(None)
    } else {
        probe(Some(&app.ffmpeg_path))
    };

    Ok(Settings {
        config: app,
        config_path: db::display_path(config_path),
        roots: db::list_roots(conn).map_err(|error| error.to_string())?,
        thumbs: thumb_config.settings(),
        cache,
        ffmpeg,
    })
}

/// 差分を保存して、更新後の設定を返す。
pub fn update(
    conn: &Connection,
    config_path: &Path,
    patch: &SettingsPatch,
) -> Result<Settings, String> {
    let mut app = config::load(config_path);

    if let Some(value) = &patch.view_mode {
        app.view_mode = value.clone();
    }
    if let Some(value) = patch.thumbnails_visible {
        app.thumbnails_visible = value;
    }
    if let Some(value) = &patch.shield_hotkey {
        app.shield_hotkey = value.clone();
    }
    if let Some(value) = patch.shield_hold_ms {
        app.shield_hold_ms = value;
    }
    if let Some(value) = patch.shield_start_hidden {
        app.shield_start_hidden = value;
    }
    if let Some(value) = &patch.shield_appearance {
        app.shield_appearance = value.clone();
    }
    if let Some(value) = &patch.exclude_patterns {
        app.exclude_patterns = value.clone();
    }
    if let Some(value) = &patch.ffmpeg_path {
        app.ffmpeg_path = value.clone();
    }
    if let Some(value) = patch.thumb_quality {
        app.thumb_quality = value;
    }
    if let Some(value) = patch.thumb_cache_limit_mb {
        app.thumb_cache_limit_mb = value;
    }
    if let Some(value) = patch.remember_volume {
        app.remember_volume = value;
    }
    if let Some(value) = &patch.comfy_url {
        app.comfy_url = value.clone();
    }
    if let Some(value) = &patch.comfy_workflows_dir {
        app.comfy_workflows_dir = value.clone();
    }

    // サムネイルの既存設定（#3 の `meta`）にも同じ値を書く。空の ffmpeg は
    // 「自動検出」に戻すので、古い設定値を消す。品質は `config.json` が正なので
    // 毎回上書きする（古い `meta` 値に引きずられない）。
    thumbs::update_settings(
        conn,
        &ThumbSettingsUpdate {
            quality: Some(app.thumb_quality),
            ffmpeg_path: patch.ffmpeg_path.clone(),
            ..ThumbSettingsUpdate::default()
        },
    )
    .map_err(|error| error.to_string())?;

    config::save(config_path, &app).map_err(|error| format!("設定を保存できません: {error}"))?;

    // 上限を下げたときは、次の生成を待たずに古いキャッシュから削る。
    // 失敗しても設定の保存自体は成功しているので、ログだけ残す。
    if patch.thumb_cache_limit_mb.is_some() {
        if let Ok(thumb_config) = effective_thumb_config(conn, &app) {
            if let Err(error) =
                thumbs::prune_cache(conn, &thumb_config.cache_dir, app.thumb_cache_limit_bytes())
            {
                eprintln!("サムネイルキャッシュを整理できませんでした: {error}");
            }
        }
    }

    get(conn, config_path)
}

/// `config.json` の値で上書きした実効サムネイル設定。
pub fn effective_thumb_config(conn: &Connection, app: &AppConfig) -> Result<ThumbConfig, String> {
    let mut config = ThumbConfig::load(conn).map_err(|error| error.to_string())?;
    config.quality = app.thumb_quality;

    let configured = if app.ffmpeg_path.trim().is_empty() {
        db::get_meta(conn, thumbs::META_FFMPEG).map_err(|error| error.to_string())?
    } else {
        Some(app.ffmpeg_path.clone())
    };
    let (ffmpeg, source) = video::resolve(configured.as_deref());
    config.ffmpeg = ffmpeg;
    config.ffmpeg_source = source;
    Ok(config)
}

/// ffmpeg を探して `-version` の 1 行目を返す。
///
/// `configured` が指定された場合はそのパスだけを確認する（自動検出に落とさない）。
/// `None` なら設定 → 同梱 sidecar → PATH → 既定候補の順で探す。
pub fn probe(configured: Option<&str>) -> FfmpegProbe {
    let explicit = configured.map(str::trim).filter(|value| !value.is_empty());

    let (path, source) = match explicit {
        Some(value) => {
            let candidate = Path::new(value);
            if !candidate.is_file() {
                return FfmpegProbe {
                    path: None,
                    source: "none".to_string(),
                    version: None,
                    error: Some(format!(
                        "ffmpeg が見つかりません: {}",
                        db::display_path(candidate)
                    )),
                };
            }
            (Some(candidate.to_path_buf()), "setting")
        }
        None => video::resolve(None),
    };

    let Some(path) = path else {
        return FfmpegProbe {
            path: None,
            source: source.to_string(),
            version: None,
            error: Some(
                "ffmpeg が見つかりません（設定 → 同梱 sidecar → PATH → 既定の場所）".to_string(),
            ),
        };
    };

    let mut command = Command::new(&path);
    command.args(["-hide_banner", "-version"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command.output() {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            let version = text
                .lines()
                .next()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_string);
            FfmpegProbe {
                path: Some(db::display_path(&path)),
                source: source.to_string(),
                version,
                error: None,
            }
        }
        Ok(output) => FfmpegProbe {
            path: Some(db::display_path(&path)),
            source: source.to_string(),
            version: None,
            error: Some(format!(
                "ffmpeg を実行できません（終了コード {}）",
                output.status
            )),
        },
        Err(error) => FfmpegProbe {
            path: Some(db::display_path(&path)),
            source: source.to_string(),
            version: None,
            error: Some(format!("ffmpeg を実行できません: {error}")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn get_returns_defaults_for_missing_config() {
        let conn = db::open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        let settings = get(&conn, &path).unwrap();

        assert_eq!(settings.config, AppConfig::default());
        assert!(settings.roots.is_empty());
        assert_eq!(settings.thumbs.quality, 75.0);
        assert_eq!(settings.cache.limit_bytes, 512 * 1024 * 1024);
        assert!(settings.config_path.ends_with("config.json"));
    }

    #[test]
    fn update_persists_and_roundtrips() {
        let conn = db::open_in_memory().unwrap();
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");

        let settings = update(
            &conn,
            &path,
            &SettingsPatch {
                exclude_patterns: Some(vec!["models".to_string(), "*.tmp".to_string()]),
                thumb_quality: Some(83.0),
                thumb_cache_limit_mb: Some(128),
                remember_volume: Some(true),
                shield_start_hidden: Some(true),
                comfy_url: Some("http://127.0.0.1:9000/".to_string()),
                comfy_workflows_dir: Some(r"D:\ComfyUI\user\default\workflows".to_string()),
                ..SettingsPatch::default()
            },
        )
        .unwrap();

        assert_eq!(settings.config.exclude_patterns, vec!["models", "*.tmp"]);
        assert_eq!(settings.config.thumb_quality, 83.0);
        assert_eq!(settings.config.thumb_cache_limit_mb, 128);
        assert!(settings.config.remember_volume);
        assert!(settings.config.shield_start_hidden);
        assert_eq!(settings.config.comfy_url, "http://127.0.0.1:9000");
        assert_eq!(
            settings.config.comfy_workflows_dir,
            r"D:\ComfyUI\user\default\workflows"
        );
        assert_eq!(settings.thumbs.quality, 83.0);
        assert_eq!(settings.cache.limit_bytes, 128 * 1024 * 1024);

        let reloaded = get(&conn, &path).unwrap();
        assert_eq!(reloaded.config, settings.config);
    }

    #[test]
    fn probe_reports_missing_explicit_path() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("no-ffmpeg.exe");
        let probe = probe(Some(&missing.to_string_lossy()));
        assert!(probe.path.is_none());
        assert_eq!(probe.source, "none");
        assert!(probe.error.unwrap().contains("見つかりません"));
    }
}
