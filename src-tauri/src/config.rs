//! アプリ設定（`config.json`）。
//!
//! #21 / #81 で追加した表示モード（作品 / ファイル / タイムライン）とサムネイル表示トグル、
//! #22 で追加したプライバシーシールド、#8 の除外パターン・サムネイル・再生音量の
//! 設定を保存する。保存先は `%APPDATA%\works-browser\config.json`。
//! 開発・検証では `WORKS_BROWSER_CONFIG` で上書きできる。
//!
//! 壊れた JSON は `config.json.bak` に退避してから既定値で起動する。
//! 未知の値は既定値（作品 / サムネ表示 / Ctrl+Shift+P / 1 秒 / 512MB）に丸める。
//! 設定は「次回起動時に復元できればよい」ので、読み込みでアプリを止めない。

use std::fs;
use std::io;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 作品カードグリッド。
pub const VIEW_MODE_WORKS: &str = "works";
/// `files` を直接並べるファイルモード。
pub const VIEW_MODE_FILES: &str = "files";
/// #81: 更新日のローカル日付ごとにまとめるタイムライン。
pub const VIEW_MODE_TIMELINE: &str = "timeline";

/// #22: シールド解除の長押し時間（ミリ秒）。
pub const SHIELD_HOLD_MS: [u32; 3] = [500, 1_000, 2_000];
/// #22: シールド中の見た目（ファイル名リスト）。
pub const SHIELD_APPEARANCE_FILES: &str = "files";
/// #22: シールド中の見た目（無地）。
pub const SHIELD_APPEARANCE_PLAIN: &str = "plain";
/// #22: 既定のグローバルホットキー。
pub const DEFAULT_SHIELD_HOTKEY: &str = "Ctrl+Shift+P";
/// #73: ComfyUI の既定 URL（ローカルの ComfyUI）。
pub const DEFAULT_COMFY_URL: &str = "http://127.0.0.1:8188";

/// #8: 除外パターンの既定値（1 行 1 glob）。`.*` はドットで始まる名前すべて。
pub const DEFAULT_EXCLUDE_PATTERNS: [&str; 3] = ["node_modules", "__pycache__", ".*"];
/// #8: 除外パターンの最大件数。
pub const MAX_EXCLUDE_PATTERNS: usize = 200;
/// #8: 除外パターン 1 件の最大長。
pub const MAX_EXCLUDE_PATTERN_LEN: usize = 200;

/// #8: WebP の既定品質（#3 と同じ）。
pub const DEFAULT_THUMB_QUALITY: f32 = 75.0;
/// #8: サムネイルキャッシュの既定上限（MB）。
pub const DEFAULT_THUMB_CACHE_LIMIT_MB: u32 = 512;
/// #8: キャッシュ上限の範囲（0 は無制限）。
pub const THUMB_CACHE_LIMIT_RANGE_MB: RangeInclusive<u32> = 0..=102_400;
/// #8: 品質の範囲。
pub const THUMB_QUALITY_RANGE: RangeInclusive<f32> = 1.0..=100.0;

/// `config.json` の中身。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// `works` | `files` | `timeline`。
    pub view_mode: String,
    /// false のときサムネイルを一切読まない（#21 のコンパクト表示）。
    pub thumbnails_visible: bool,
    /// #22: グローバルホットキー（例 `Ctrl+Shift+P`）。
    pub shield_hotkey: String,
    /// #22: 解除に必要な長押し時間（500 / 1000 / 2000）。
    pub shield_hold_ms: u32,
    /// #22: 起動直後からシールドするか。
    pub shield_start_hidden: bool,
    /// #22: シールド中の見た目（`files` | `plain`）。
    pub shield_appearance: String,
    /// #8: 走査から除外する glob パターン（1 行 1 件）。
    pub exclude_patterns: Vec<String>,
    /// #8: 動画サムネイルに使う ffmpeg のパス。空なら自動検出。
    pub ffmpeg_path: String,
    /// #8: サムネイルの WebP 品質（1–100）。
    pub thumb_quality: f32,
    /// #8: サムネイルキャッシュの上限（MB、0 は無制限）。
    pub thumb_cache_limit_mb: u32,
    /// #8: 動画の音量を次回起動時に復元するか（既定 false = 毎回ミュート）。
    pub remember_volume: bool,
    /// #7: フォルダ監視を有効にするか（既定で有効）。
    pub watch_enabled: bool,
    /// #7: 監視から除外するパスの glob（ファイル名 / ルート相対パスに一致）。
    pub watch_exclude: Vec<String>,
    /// #7: ネットワークドライブ（`L:\` や UNC）も監視するか。既定は監視しない。
    pub watch_network_drives: bool,
    /// #39: `.ts` を MPEG-TS として索引するか。既定は `false`
    /// （TypeScript のソースを動画として拾わないため）。
    pub index_mpeg_ts: bool,
    /// #73: ComfyUI の URL（`GET /system_stats` / `POST /prompt` の接続先）。
    pub comfy_url: String,
    /// #73: ComfyUI の workflows フォルダ（`ComfyUI/user/default/workflows`）。
    /// 空なら「ComfyUI へ」で workflow を保存できない。
    pub comfy_workflows_dir: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            view_mode: VIEW_MODE_WORKS.to_string(),
            // 既定はサムネ非表示（グリッド＋プレースホルダ）
            thumbnails_visible: false,
            shield_hotkey: DEFAULT_SHIELD_HOTKEY.to_string(),
            shield_hold_ms: 1_000,
            shield_start_hidden: false,
            shield_appearance: SHIELD_APPEARANCE_FILES.to_string(),
            exclude_patterns: DEFAULT_EXCLUDE_PATTERNS
                .iter()
                .map(|pattern| (*pattern).to_string())
                .collect(),
            ffmpeg_path: String::new(),
            thumb_quality: DEFAULT_THUMB_QUALITY,
            thumb_cache_limit_mb: DEFAULT_THUMB_CACHE_LIMIT_MB,
            remember_volume: false,
            watch_enabled: true,
            watch_exclude: Vec::new(),
            watch_network_drives: false,
            index_mpeg_ts: false,
            comfy_url: DEFAULT_COMFY_URL.to_string(),
            comfy_workflows_dir: String::new(),
        }
    }
}

impl AppConfig {
    /// 未知の値を既定値に寄せる（古い設定を読んだとき用）。
    pub fn normalized(mut self) -> Self {
        if self.view_mode != VIEW_MODE_FILES && self.view_mode != VIEW_MODE_TIMELINE {
            self.view_mode = VIEW_MODE_WORKS.to_string();
        }
        self.shield_hotkey = self.shield_hotkey.trim().to_string();
        if self.shield_hotkey.is_empty() {
            self.shield_hotkey = DEFAULT_SHIELD_HOTKEY.to_string();
        }
        if !SHIELD_HOLD_MS.contains(&self.shield_hold_ms) {
            self.shield_hold_ms = 1_000;
        }
        if self.shield_appearance != SHIELD_APPEARANCE_PLAIN {
            self.shield_appearance = SHIELD_APPEARANCE_FILES.to_string();
        }

        // #8: 除外パターンは前後の空白を落とし、空行・重複（大文字小文字無視）を畳む。
        let mut patterns: Vec<String> = Vec::new();
        for pattern in self.exclude_patterns {
            let trimmed = pattern.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if patterns
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(trimmed))
            {
                continue;
            }
            let mut value = trimmed.replace('\\', "/");
            if value.chars().count() > MAX_EXCLUDE_PATTERN_LEN {
                value = value.chars().take(MAX_EXCLUDE_PATTERN_LEN).collect();
            }
            patterns.push(value);
            if patterns.len() >= MAX_EXCLUDE_PATTERNS {
                break;
            }
        }
        self.exclude_patterns = patterns;

        self.ffmpeg_path = self.ffmpeg_path.trim().to_string();
        if !self.thumb_quality.is_finite() {
            self.thumb_quality = DEFAULT_THUMB_QUALITY;
        }
        self.thumb_quality = self
            .thumb_quality
            .clamp(*THUMB_QUALITY_RANGE.start(), *THUMB_QUALITY_RANGE.end());
        self.thumb_cache_limit_mb = self.thumb_cache_limit_mb.clamp(
            *THUMB_CACHE_LIMIT_RANGE_MB.start(),
            *THUMB_CACHE_LIMIT_RANGE_MB.end(),
        );
        // 除外 glob は空要素を落とし、数が増えすぎないようにする（誤った設定で
        // 監視スレッドが極端に遅くならないための上限）。
        self.watch_exclude = self
            .watch_exclude
            .into_iter()
            .map(|pattern| pattern.trim().to_string())
            .filter(|pattern| !pattern.is_empty())
            .take(200)
            .collect();
        // #73: ComfyUI の URL は前後の空白と末尾の `/` を落とす。
        // 空にされたら既定（ローカルの ComfyUI）に戻す。URL の妥当性は
        // 送信時に検証し、設定はユーザーの入力を勝手に書き換えない。
        self.comfy_url = self.comfy_url.trim().trim_end_matches('/').to_string();
        if self.comfy_url.is_empty() {
            self.comfy_url = DEFAULT_COMFY_URL.to_string();
        }
        self.comfy_workflows_dir = self.comfy_workflows_dir.trim().to_string();
        self
    }

    /// #8: キャッシュ上限をバイトで返す（0 は無制限）。
    pub fn thumb_cache_limit_bytes(&self) -> u64 {
        u64::from(self.thumb_cache_limit_mb) * 1024 * 1024
    }
}

/// 設定ファイルの場所。`WORKS_BROWSER_CONFIG` があればそれを使う。
pub fn default_config_path() -> PathBuf {
    if let Ok(custom) = std::env::var("WORKS_BROWSER_CONFIG") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("works-browser").join("config.json")
}

/// 設定を読む。存在しない・読めない場合は既定値を返す。
///
/// 壊れた JSON は `config.json.bak` に退避してから既定値にする（#8）。
/// ユーザーが手で直せるよう、壊れた内容は消さずに残す。
pub fn load(path: &Path) -> AppConfig {
    let Ok(text) = fs::read_to_string(path) else {
        return AppConfig::default();
    };
    match serde_json::from_str::<AppConfig>(&text) {
        Ok(config) => config.normalized(),
        Err(error) => {
            eprintln!("設定ファイルが壊れているため既定値を使います: {error}");
            quarantine(path);
            AppConfig::default()
        }
    }
}

/// 壊れた設定を `config.json.bak` に退避する。失敗しても起動は止めない。
fn quarantine(path: &Path) {
    let backup = path.with_extension("json.bak");
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    let _ = fs::rename(path, &backup);
}

/// 部分的な設定 JSON を既存の設定へ重ねる。
///
/// UI（`save_config`）は表示・シールドの項目だけを送る。送られてこなかった
/// 項目は既存の値を保つ（`index_mpeg_ts` のように設定画面が無い項目が、
/// 表示設定の保存で既定値に戻らないようにするため）。#39
pub fn merge(previous: &AppConfig, partial: &serde_json::Value) -> AppConfig {
    let Ok(mut merged) = serde_json::to_value(previous) else {
        return previous.clone().normalized();
    };
    if let (Some(destination), Some(source)) = (merged.as_object_mut(), partial.as_object()) {
        for (key, value) in source {
            // 未知のキーは増やさない（設定ファイルを汚さない）
            if destination.contains_key(key) {
                destination.insert(key.clone(), value.clone());
            }
        }
    }
    serde_json::from_value::<AppConfig>(merged)
        .map(AppConfig::normalized)
        .unwrap_or_else(|_| previous.clone().normalized())
}

/// 設定を書く。同じディレクトリの一時ファイルを経由して置き換える。
pub fn save(path: &Path, config: &AppConfig) -> io::Result<()> {
    let config = config.clone().normalized();
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| io::Error::other(format!("設定を JSON にできません: {error}")))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json)?;
    // Windows の rename は既存ファイルを置き換えられない
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let config = load(&dir.path().join("config.json"));
        assert_eq!(config, AppConfig::default());
        assert_eq!(config.view_mode, "works");
        // 既定はサムネ非表示（グリッド＋プレースホルダ）
        assert!(!config.thumbnails_visible);
        assert_eq!(config.shield_hotkey, "Ctrl+Shift+P");
        assert_eq!(config.shield_hold_ms, 1_000);
        assert!(!config.shield_start_hidden);
        assert_eq!(config.shield_appearance, "files");
        assert_eq!(
            config.exclude_patterns,
            vec!["node_modules", "__pycache__", ".*"]
        );
        assert_eq!(config.ffmpeg_path, "");
        assert_eq!(config.thumb_quality, 75.0);
        assert_eq!(config.thumb_cache_limit_mb, 512);
        assert!(!config.remember_volume);
        assert_eq!(config.comfy_url, DEFAULT_COMFY_URL);
        assert_eq!(config.comfy_workflows_dir, "");
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("config.json");
        let config = AppConfig {
            view_mode: "files".to_string(),
            thumbnails_visible: false,
            shield_hotkey: "Ctrl+Alt+S".to_string(),
            shield_hold_ms: 2_000,
            shield_start_hidden: true,
            shield_appearance: "plain".to_string(),
            exclude_patterns: vec!["models".to_string(), "*.tmp".to_string()],
            ffmpeg_path: r"C:\tools\ffmpeg.exe".to_string(),
            thumb_quality: 82.0,
            thumb_cache_limit_mb: 256,
            remember_volume: true,
            watch_enabled: false,
            watch_exclude: vec!["*.tmp".to_string(), "cache/**".to_string()],
            watch_network_drives: true,
            index_mpeg_ts: true,
            comfy_url: "http://127.0.0.1:9000".to_string(),
            comfy_workflows_dir: r"D:\ComfyUI\user\default\workflows".to_string(),
        };
        save(&path, &config).unwrap();
        assert_eq!(load(&path), config);
    }

    #[test]
    fn corrupt_json_falls_back_to_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(load(&path), AppConfig::default());
    }

    #[test]
    fn corrupt_json_is_quarantined_to_bak() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, b"{ broken").unwrap();

        assert_eq!(load(&path), AppConfig::default());
        assert!(!path.exists(), "壊れた設定はその場に残さない");
        let backup = path.with_extension("json.bak");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "{ broken");
    }

    #[test]
    fn unknown_view_mode_is_normalized() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, br#"{"view_mode":"grid","thumbnails_visible":false}"#).unwrap();
        let config = load(&path);
        assert_eq!(config.view_mode, "works");
        assert!(!config.thumbnails_visible);
    }

    #[test]
    fn timeline_view_mode_is_kept() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, br#"{"view_mode":"timeline"}"#).unwrap();
        assert_eq!(load(&path).view_mode, VIEW_MODE_TIMELINE);

        save(
            &path,
            &AppConfig {
                view_mode: VIEW_MODE_TIMELINE.to_string(),
                ..AppConfig::default()
            },
        )
        .unwrap();
        assert_eq!(load(&path).view_mode, VIEW_MODE_TIMELINE);
    }

    #[test]
    fn save_normalizes_view_mode() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        save(
            &path,
            &AppConfig {
                view_mode: "unknown".to_string(),
                thumbnails_visible: true,
                ..AppConfig::default()
            },
        )
        .unwrap();
        assert_eq!(load(&path).view_mode, "works");
    }

    #[test]
    fn shield_values_are_normalized() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            br#"{"shield_hotkey":"  ","shield_hold_ms":730,"shield_appearance":"video"}"#,
        )
        .unwrap();
        let config = load(&path);
        assert_eq!(config.shield_hotkey, "Ctrl+Shift+P");
        assert_eq!(config.shield_hold_ms, 1_000);
        assert_eq!(config.shield_appearance, "files");
    }

    #[test]
    fn exclude_patterns_are_trimmed_deduped_and_capped() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            br##"{"exclude_patterns":["  models  ","","#comment","MODELS","*.tmp","cache\\"]}"##,
        )
        .unwrap();
        let config = load(&path);
        assert_eq!(
            config.exclude_patterns,
            vec!["models", "*.tmp", "cache/"],
            "空白と重複とコメント行を落とし、区切りは / に寄せる"
        );
    }

    #[test]
    fn thumbnail_values_are_clamped() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            br#"{"thumb_quality":999,"thumb_cache_limit_mb":99999999}"#,
        )
        .unwrap();
        let config = load(&path);
        assert_eq!(config.thumb_quality, 100.0);
        assert_eq!(
            config.thumb_cache_limit_mb,
            *THUMB_CACHE_LIMIT_RANGE_MB.end()
        );

        let negative = AppConfig {
            thumb_quality: -5.0,
            ..AppConfig::default()
        }
        .normalized();
        assert_eq!(negative.thumb_quality, 1.0);
        assert_eq!(
            AppConfig::default().thumb_cache_limit_bytes(),
            512 * 1024 * 1024
        );
    }

    #[test]
    fn shield_hold_ms_accepts_settings_options() {
        for hold in SHIELD_HOLD_MS {
            let config = AppConfig {
                shield_hold_ms: hold,
                ..AppConfig::default()
            };
            assert_eq!(config.normalized().shield_hold_ms, hold);
        }
    }

    #[test]
    fn watch_settings_default_and_normalize() {
        let defaults = AppConfig::default();
        assert!(defaults.watch_enabled, "監視は既定で有効");
        assert!(defaults.watch_exclude.is_empty());
        assert!(
            !defaults.watch_network_drives,
            "ネットワークは既定で監視しない"
        );
        assert!(!defaults.index_mpeg_ts, "`.ts` は既定で索引しない");

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            br#"{"watch_enabled":false,"watch_exclude":["  *.tmp  ","", "  ","cache/**"],"watch_network_drives":true}"#,
        )
        .unwrap();
        let config = load(&path);
        assert!(!config.watch_enabled);
        assert_eq!(config.watch_exclude, vec!["*.tmp", "cache/**"]);
        assert!(config.watch_network_drives);
    }

    #[test]
    fn index_mpeg_ts_is_opt_in() {
        assert!(!AppConfig::default().index_mpeg_ts);

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        // 既存の設定（項目なし）は false に丸まる
        fs::write(&path, br#"{"watch_enabled":true}"#).unwrap();
        assert!(!load(&path).index_mpeg_ts);

        fs::write(&path, br#"{"index_mpeg_ts":true}"#).unwrap();
        assert!(load(&path).index_mpeg_ts);
    }

    #[test]
    fn comfy_url_defaults_and_normalizes_without_breaking_old_config() {
        assert_eq!(AppConfig::default().comfy_url, DEFAULT_COMFY_URL);
        assert!(AppConfig::default().comfy_workflows_dir.is_empty());

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        // 項目の無い古い設定は既定値に丸まる（マイグレーション不要）
        fs::write(&path, br#"{"view_mode":"files"}"#).unwrap();
        assert_eq!(load(&path).comfy_url, DEFAULT_COMFY_URL);

        fs::write(
            &path,
            br#"{"comfy_url":"  http://192.168.0.5:8188/  ","comfy_workflows_dir":"  D:\\ComfyUI\\workflows  "}"#,
        )
        .unwrap();
        let config = load(&path);
        assert_eq!(config.comfy_url, "http://192.168.0.5:8188");
        assert_eq!(config.comfy_workflows_dir, r"D:\ComfyUI\workflows");

        fs::write(&path, br#"{"comfy_url":"   "}"#).unwrap();
        assert_eq!(load(&path).comfy_url, DEFAULT_COMFY_URL);
    }

    #[test]
    fn partial_save_keeps_unmentioned_settings() {
        // UI は表示・シールド項目だけを送る（#21 / #22）。`index_mpeg_ts` は
        // 送られてこなければ既存の値を保つ（#39）。
        let previous = AppConfig {
            index_mpeg_ts: true,
            watch_enabled: false,
            ..AppConfig::default()
        };

        let merged = merge(
            &previous,
            &serde_json::json!({"view_mode": "files", "thumbnails_visible": false}),
        );
        assert_eq!(merged.view_mode, "files");
        assert!(!merged.thumbnails_visible);
        assert!(merged.index_mpeg_ts, "指定の無い項目は既存の値を保つ");
        assert!(!merged.watch_enabled);

        // 明示された値はそのまま反映する
        let merged = merge(&previous, &serde_json::json!({"index_mpeg_ts": false}));
        assert!(!merged.index_mpeg_ts);
    }
}
