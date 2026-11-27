//! #73: ComfyUI 連携。
//!
//! 画像の生成情報（PNG の `workflow` / `prompt`）を使って、次の 2 つを行う。
//!
//! 1. **ComfyUI へ**: `workflow`（UI 形式）を設定の workflows フォルダへ
//!    `<name>.json` として保存し、`http://<設定URL>/?workflow=<name>` を既定の
//!    ブラウザで開く。`workflow` が無ければ API 形式の JSON を返し、UI が
//!    クリップボードへコピーする（ComfyUI に貼り付けて読み込む）。
//! 2. **この設定で再実行**: API 形式の `prompt` を `POST {url}/prompt` に送る。
//!
//! 接続先は `config.json` の `comfy_url` だけを使い、UI から任意の URL は受け取らない。
//! ローカルの ComfyUI（`http://127.0.0.1:8188`）を想定するので TLS は使わない。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::commands::AppState;
use crate::config::{self, AppConfig};
use crate::index::db;
use crate::meta::GenerationMeta;

/// HTTP のタイムアウト。プロンプトの送信は少し待つ。
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
/// エラー本文を UI に出す長さの上限。
const MAX_DETAIL_CHARS: usize = 400;
/// workflow ファイル名の上限（拡張子を除く）。
const MAX_WORKFLOW_STEM_CHARS: usize = 120;

/// 「ComfyUI へ」の結果。
#[derive(Debug, Clone, Serialize)]
pub struct ComfyExport {
    /// `workflow`（保存してブラウザで開いた）| `api`（コピー用の JSON を返す）。
    pub mode: String,
    /// 保存した workflow のフルパス（`mode = workflow`）。
    pub path: Option<String>,
    /// 開いた / 開く URL。
    pub url: Option<String>,
    /// `mode = api` のとき、クリップボードへコピーする API JSON。
    pub api_prompt: Option<String>,
    /// 元のファイル名。
    pub file_name: String,
    /// UI に表示する案内。
    pub message: String,
}

/// 「この設定で再実行」の結果。
#[derive(Debug, Clone, Serialize)]
pub struct ComfyQueueResult {
    /// ComfyUI の `prompt_id`（履歴 / キューの識別子）。
    pub prompt_id: String,
    /// キュー番号（返らない版もある）。
    pub number: Option<i64>,
    /// 送信先（`POST /prompt`）。
    pub url: String,
}

/// 接続確認（`GET /system_stats`）の結果。
#[derive(Debug, Clone, Serialize)]
pub struct ComfyStatus {
    pub ok: bool,
    /// 確認した URL。
    pub url: String,
    /// `system.comfyui_version`（取れれば）。
    pub version: Option<String>,
    /// 日本語の結果メッセージ。
    pub message: String,
}

/// 「ComfyUI へ」で行う操作。
#[derive(Debug, Clone, PartialEq)]
pub enum ExportAction {
    /// workflow を保存してブラウザで開く。
    Workflow { path: PathBuf, url: String },
    /// API 形式を UI に返してコピーしてもらう。
    Api { prompt: String },
}

/// 設定の URL を検証して、末尾 `/` の無いベース URL にする。
pub fn normalize_base(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(
            "ComfyUI の URL が設定されていません（設定 → ComfyUI で指定してください）".to_string(),
        );
    }
    if trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(
            "ComfyUI の URL に空白や制御文字が含まれています（例: http://127.0.0.1:8188）"
                .to_string(),
        );
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Err(
            "https の ComfyUI には未対応です。http:// の URL を設定してください".to_string(),
        );
    }
    let Some(rest) = lower.strip_prefix("http://") else {
        return Err(
            "ComfyUI の URL は http:// で始まるアドレスを設定してください（例: http://127.0.0.1:8188）"
                .to_string(),
        );
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return Err(
            "ComfyUI の URL にホスト名がありません（例: http://127.0.0.1:8188）".to_string(),
        );
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

/// `GET /system_stats` の URL。
pub fn system_stats_url(base: &str) -> String {
    format!("{base}/system_stats")
}

/// `POST /prompt` の URL。
pub fn prompt_url(base: &str) -> String {
    format!("{base}/prompt")
}

/// workflow を開く URL（`?workflow=<name>`）。
pub fn workflow_url(base: &str, name: &str) -> String {
    format!("{base}/?workflow={}", encode_query(name))
}

/// workflow のファイル名（拡張子なし）。Windows の禁止文字を `_` に置き換える。
pub fn workflow_stem(file_name: &str) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let mut out = String::new();
    for ch in stem.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
        if out.chars().count() >= MAX_WORKFLOW_STEM_CHARS {
            break;
        }
    }
    let out = out.trim().trim_end_matches('.').trim().to_string();
    if out.is_empty() {
        "workflow".to_string()
    } else {
        out
    }
}

/// 設定と生成情報から「ComfyUI へ」の操作を決める（ファイル書き込みはしない）。
pub fn export_action(
    config: &AppConfig,
    file_name: &str,
    meta: &GenerationMeta,
) -> Result<ExportAction, String> {
    let base = normalize_base(&config.comfy_url)?;

    if let Some(workflow) = meta.workflow_json.as_deref() {
        let dir = config.comfy_workflows_dir.trim();
        if dir.is_empty() {
            return Err(
                "workflow の保存先が未設定です（設定 → ComfyUI の「workflows フォルダ」に ComfyUI の user/default/workflows を指定してください）"
                    .to_string(),
            );
        }
        if serde_json::from_str::<Value>(workflow)
            .ok()
            .is_none_or(|value| !value.is_object())
        {
            return Err("workflow の JSON が壊れているため保存できません".to_string());
        }
        let stem = workflow_stem(file_name);
        return Ok(ExportAction::Workflow {
            path: Path::new(dir).join(format!("{stem}.json")),
            url: workflow_url(&base, &stem),
        });
    }

    if let Some(prompt) = meta.api_prompt.as_deref() {
        return Ok(ExportAction::Api {
            prompt: prompt.to_string(),
        });
    }

    Err("この画像には ComfyUI で開ける workflow / API プロンプトがありません".to_string())
}

/// workflow の JSON を `<name>.json` として書く（一時ファイル経由）。
pub fn write_workflow_file(path: &Path, json: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "workflow の保存先を作成できません（{}）: {error}",
                parent.display()
            )
        })?;
    }
    let temp = path.with_extension("json.tmp");
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|error| format!("workflow を保存できません（{}）: {error}", temp.display()))?;
        file.write_all(json.as_bytes())
            .map_err(|error| format!("workflow を保存できません（{}）: {error}", temp.display()))?;
    }
    // Windows の rename は既存ファイルを置き換えられない
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|error| format!("古い workflow を置き換えられません: {error}"))?;
    }
    std::fs::rename(&temp, path)
        .map_err(|error| format!("workflow を保存できません（{}）: {error}", path.display()))
}

/// `GET /system_stats` で接続を確認する。
pub fn check(config: &AppConfig) -> ComfyStatus {
    let shown = config.comfy_url.clone();
    let base = match normalize_base(&config.comfy_url) {
        Ok(base) => base,
        Err(message) => {
            return ComfyStatus {
                ok: false,
                url: shown,
                version: None,
                message,
            }
        }
    };
    let endpoint = system_stats_url(&base);

    match agent().get(&endpoint).call() {
        Ok(response) => {
            let body = response.into_string().unwrap_or_default();
            let version = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/system/comfyui_version")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                });
            let message = match &version {
                Some(version) => format!("接続できました（ComfyUI {version}）"),
                None => "接続できました（/system_stats が応答しました）".to_string(),
            };
            ComfyStatus {
                ok: true,
                url: endpoint,
                version,
                message,
            }
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            ComfyStatus {
                ok: false,
                url: endpoint,
                version: None,
                message: format!(
                    "ComfyUI が応答しましたがエラーです（HTTP {code}）: {}",
                    error_detail(&body)
                ),
            }
        }
        Err(ureq::Error::Transport(error)) => ComfyStatus {
            ok: false,
            url: endpoint.clone(),
            version: None,
            message: format!(
                "ComfyUI に接続できません（{endpoint}）。ComfyUI が起動しているか、URL が正しいか確認してください: {error}"
            ),
        },
    }
}

/// API 形式のプロンプトを `POST /prompt` に送る。
pub fn queue(config: &AppConfig, api_prompt: &str) -> Result<ComfyQueueResult, String> {
    let base = normalize_base(&config.comfy_url)?;
    let prompt: Value = serde_json::from_str(api_prompt)
        .map_err(|_| "API 形式のプロンプトが壊れているため送信できません".to_string())?;
    if !crate::meta::looks_like_api_prompt(&prompt) {
        return Err(
            "ComfyUI の API 形式ではないため送信できません（workflow は「ComfyUI へ」で開いてください）"
                .to_string(),
        );
    }

    let endpoint = prompt_url(&base);
    let body = serde_json::json!({
        "prompt": prompt,
        "client_id": new_client_id(),
    })
    .to_string();

    let result = agent()
        .post(&endpoint)
        .set("Content-Type", "application/json")
        .send_string(&body);

    match result {
        Ok(response) => {
            let text = response.into_string().unwrap_or_default();
            parse_prompt_response(&endpoint, &text)
        }
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(status_message(code, &text))
        }
        Err(ureq::Error::Transport(error)) => Err(format!(
            "ComfyUI に接続できません（{endpoint}）。ComfyUI が起動しているか、URL が正しいか確認してください: {error}"
        )),
    }
}

/// `/prompt` の 200 応答から `prompt_id` を取り出す。
fn parse_prompt_response(endpoint: &str, body: &str) -> Result<ComfyQueueResult, String> {
    let value: Value = serde_json::from_str(body).map_err(|_| {
        format!(
            "ComfyUI の応答を読み取れませんでした（JSON ではありません）: {}",
            summarize(body)
        )
    })?;
    let prompt_id = value
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "ComfyUI から prompt_id が返りませんでした: {}",
                error_detail(body)
            )
        })?;
    Ok(ComfyQueueResult {
        prompt_id: prompt_id.to_string(),
        number: value.get("number").and_then(|v| v.as_i64()),
        url: endpoint.to_string(),
    })
}

/// HTTP ステータスごとの日本語メッセージ。
fn status_message(code: u16, body: &str) -> String {
    let detail = error_detail(body);
    match code {
        400 => format!(
            "ComfyUI がリクエストを拒否しました（HTTP 400）。プロンプトの形式やモデル名を確認してください: {detail}"
        ),
        401 | 403 => format!(
            "ComfyUI に拒否されました（HTTP {code}）。認証が必要な設定になっていないか確認してください: {detail}"
        ),
        404 => format!(
            "ComfyUI の API が見つかりません（HTTP 404）。設定の URL（例: http://127.0.0.1:8188）を確認してください: {detail}"
        ),
        500..=599 => format!(
            "ComfyUI 側でエラーが発生しました（HTTP {code}）。ComfyUI のログを確認してください: {detail}"
        ),
        _ => format!("ComfyUI がリクエストを処理できませんでした（HTTP {code}）: {detail}"),
    }
}

/// ComfyUI のエラー応答から、読める理由だけを取り出す。
fn error_detail(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(error) = value.get("error") {
            if let Some(message) = error.get("message").and_then(|v| v.as_str()) {
                let details = error.get("details").and_then(|v| v.as_str()).unwrap_or("");
                return if details.is_empty() {
                    message.to_string()
                } else {
                    format!("{message}（{details}）")
                };
            }
            if let Some(message) = error.as_str() {
                return message.to_string();
            }
        }
        if let Some(errors) = value
            .get("node_errors")
            .filter(|v| v.as_object().is_some_and(|map| !map.is_empty()))
        {
            return summarize(&errors.to_string());
        }
    }
    summarize(body)
}

fn summarize(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "（応答なし）".to_string();
    }
    let mut out: String = trimmed.chars().take(MAX_DETAIL_CHARS).collect();
    if trimmed.chars().count() > MAX_DETAIL_CHARS {
        out.push('…');
    }
    out
}

/// クエリ用のパーセントエンコード（RFC 3986 の unreserved 以外を %XX に）。
fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// ComfyUI の `client_id`（UUID v4 形式）。WS の振り分けに使うだけなので
/// 暗号学的な乱数は要らず、時刻 + プロセス + プロセス内の乱数から作る。
pub fn new_client_id() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hash, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut first = RandomState::new().build_hasher();
    nanos.hash(&mut first);
    std::process::id().hash(&mut first);
    let a = first.finish();
    let mut second = RandomState::new().build_hasher();
    a.hash(&mut second);
    nanos.rotate_left(17).hash(&mut second);
    let b = second.finish();

    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_le_bytes());
    bytes[8..].copy_from_slice(&b.to_le_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build()
}

// ---------------------------------------------------------------------------
// Tauri コマンド
// ---------------------------------------------------------------------------

/// 設定の URL に `GET /system_stats` して接続を確認する（設定画面）。
///
/// ネットワークで最大 20 秒待つので、UI を止めないよう別スレッドで実行する。
#[tauri::command]
pub async fn comfy_check(state: State<'_, AppState>) -> Result<ComfyStatus, String> {
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = config::load(&config_path);
        check(&config)
    })
    .await
    .map_err(|error| format!("接続確認が異常終了しました: {error}"))
}

/// 「ComfyUI へ」。workflow があれば保存してブラウザで開き、無ければ API 形式を返す。
#[tauri::command]
pub async fn comfy_open(state: State<'_, AppState>, file_id: i64) -> Result<ComfyExport, String> {
    let db_path = state.db_path.clone();
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open(&db_path).map_err(|error| error.to_string())?;
        let meta = crate::commands::meta::load_meta(&conn, file_id)?
            .ok_or_else(|| "このファイルに生成情報が見つかりません".to_string())?;
        let path = db::file_absolute_path(&conn, file_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("ファイル {file_id} が見つかりません"))?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workflow")
            .to_string();
        let config = config::load(&config_path);

        match export_action(&config, &file_name, &meta)? {
            ExportAction::Workflow { path, url } => {
                let workflow = meta.workflow_json.as_deref().unwrap_or_default();
                write_workflow_file(&path, workflow)?;
                crate::commands::reveal::open_url(&url)?;
                Ok(ComfyExport {
                    mode: "workflow".to_string(),
                    path: Some(path.display().to_string()),
                    url: Some(url),
                    api_prompt: None,
                    file_name,
                    message: "workflow を保存して ComfyUI をブラウザで開きました".to_string(),
                })
            }
            ExportAction::Api { prompt } => Ok(ComfyExport {
                mode: "api".to_string(),
                path: None,
                url: Some(normalize_base(&config.comfy_url)?),
                api_prompt: Some(prompt),
                file_name,
                message:
                    "API 形式のプロンプトをクリップボードにコピーしました。ComfyUI に貼り付けて読み込んでください"
                        .to_string(),
            }),
        }
    })
    .await
    .map_err(|error| format!("ComfyUI の準備が異常終了しました: {error}"))?
}

/// 「この設定で再実行」。保存済みの API 形式プロンプトを ComfyUI のキューへ送る。
///
/// UI から JSON や URL は受け取らず、ファイル ID だけを受け取る。
#[tauri::command]
pub async fn comfy_queue_prompt(
    state: State<'_, AppState>,
    file_id: i64,
) -> Result<ComfyQueueResult, String> {
    let db_path = state.db_path.clone();
    let config_path = state.config_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open(&db_path).map_err(|error| error.to_string())?;
        let meta = crate::commands::meta::load_meta(&conn, file_id)?
            .ok_or_else(|| "このファイルに生成情報が見つかりません".to_string())?;
        let prompt = meta.api_prompt.ok_or_else(|| {
            "この画像には API 形式のプロンプトがありません（workflow は「ComfyUI へ」で開いてください）"
                .to_string()
        })?;
        let config = config::load(&config_path);
        queue(&config, &prompt)
    })
    .await
    .map_err(|error| format!("再実行が異常終了しました: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> AppConfig {
        AppConfig::default()
    }

    #[test]
    fn normalize_base_accepts_http_and_trims_slash() {
        assert_eq!(
            normalize_base("  http://127.0.0.1:8188/  ").unwrap(),
            "http://127.0.0.1:8188"
        );
        assert_eq!(
            normalize_base("http://comfy.local:8188").unwrap(),
            "http://comfy.local:8188"
        );
        assert_eq!(
            normalize_base("http://192.168.0.5:8188").unwrap(),
            "http://192.168.0.5:8188"
        );
    }

    #[test]
    fn normalize_base_rejects_invalid_urls_in_japanese() {
        assert!(normalize_base("")
            .unwrap_err()
            .contains("URL が設定されていません"));
        assert!(normalize_base("   ")
            .unwrap_err()
            .contains("URL が設定されていません"));
        assert!(normalize_base("127.0.0.1:8188")
            .unwrap_err()
            .contains("http:// で始まる"));
        assert!(normalize_base("https://comfy.example.com")
            .unwrap_err()
            .contains("https"));
        assert!(normalize_base("http://").unwrap_err().contains("ホスト名"));
        assert!(normalize_base("http://127.0.0.1:8188 /")
            .unwrap_err()
            .contains("空白"));
    }

    #[test]
    fn builds_endpoints_and_workflow_url() {
        let base = "http://127.0.0.1:8188";
        assert_eq!(system_stats_url(base), "http://127.0.0.1:8188/system_stats");
        assert_eq!(prompt_url(base), "http://127.0.0.1:8188/prompt");
        assert_eq!(
            workflow_url(base, "ComfyUI_00001_"),
            "http://127.0.0.1:8188/?workflow=ComfyUI_00001_"
        );
        // 日本語や空白はパーセントエンコードする
        assert_eq!(
            workflow_url(base, "絵 01"),
            "http://127.0.0.1:8188/?workflow=%E7%B5%B5%2001"
        );
    }

    #[test]
    fn workflow_stem_sanitizes_windows_characters() {
        assert_eq!(workflow_stem("ComfyUI_00001_.png"), "ComfyUI_00001_");
        assert_eq!(workflow_stem("x y:z*w?e\"f|g<h>i.png"), "x y_z_w_e_f_g_h_i");
        assert_eq!(workflow_stem("..."), "workflow");
        assert_eq!(workflow_stem(""), "workflow");
        // 末尾のドットは Windows で作れないので落とす
        assert_eq!(workflow_stem("name..png"), "name");
    }

    #[test]
    fn export_action_prefers_workflow_and_builds_file_path() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut app = config();
        app.comfy_workflows_dir = dir.path().display().to_string();
        let meta = GenerationMeta {
            workflow_json: Some(r#"{"nodes":[]}"#.to_string()),
            api_prompt: Some(r#"{"3":{"class_type":"KSampler","inputs":{}}}"#.to_string()),
            ..Default::default()
        };

        let action = export_action(&app, "ComfyUI_00007_.png", &meta).unwrap();
        assert_eq!(
            action,
            ExportAction::Workflow {
                path: dir.path().join("ComfyUI_00007_.json"),
                url: "http://127.0.0.1:8188/?workflow=ComfyUI_00007_".to_string(),
            }
        );
    }

    #[test]
    fn export_action_falls_back_to_api_prompt() {
        let meta = GenerationMeta {
            api_prompt: Some(r#"{"3":{"class_type":"KSampler","inputs":{}}}"#.to_string()),
            ..Default::default()
        };
        assert_eq!(
            export_action(&config(), "a.png", &meta).unwrap(),
            ExportAction::Api {
                prompt: r#"{"3":{"class_type":"KSampler","inputs":{}}}"#.to_string()
            }
        );
    }

    #[test]
    fn export_action_reports_missing_settings_and_data() {
        let mut app = config();
        app.comfy_workflows_dir.clear();
        let workflow_only = GenerationMeta {
            workflow_json: Some(r#"{"nodes":[]}"#.to_string()),
            ..Default::default()
        };
        let error = export_action(&app, "a.png", &workflow_only).unwrap_err();
        assert!(error.contains("workflows フォルダ"), "{error}");

        let mut with_dir = config();
        with_dir.comfy_workflows_dir = tempfile::TempDir::new()
            .unwrap()
            .path()
            .display()
            .to_string();
        let broken = GenerationMeta {
            workflow_json: Some("{ not json".to_string()),
            ..Default::default()
        };
        let error = export_action(&with_dir, "a.png", &broken).unwrap_err();
        assert!(error.contains("壊れている"), "{error}");

        let error = export_action(&config(), "a.png", &GenerationMeta::default()).unwrap_err();
        assert!(error.contains("ありません"), "{error}");
    }

    #[test]
    fn write_workflow_file_replaces_existing_json() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nested").join("ComfyUI_00001_.json");
        write_workflow_file(&path, r#"{"nodes":[]}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"nodes":[]}"#);
        write_workflow_file(&path, r#"{"nodes":[1]}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"nodes":[1]}"#);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn prompt_response_requires_prompt_id() {
        let result = parse_prompt_response(
            "http://127.0.0.1:8188/prompt",
            r#"{"prompt_id":"abc","number":3}"#,
        )
        .unwrap();
        assert_eq!(result.prompt_id, "abc");
        assert_eq!(result.number, Some(3));
        assert_eq!(result.url, "http://127.0.0.1:8188/prompt");

        let error = parse_prompt_response("http://x/prompt", r#"{"number":1}"#).unwrap_err();
        assert!(error.contains("prompt_id"), "{error}");
        let error = parse_prompt_response("http://x/prompt", "not json").unwrap_err();
        assert!(error.contains("JSON ではありません"), "{error}");
    }

    #[test]
    fn status_messages_are_japanese_and_include_reason() {
        let body = r#"{"error":{"message":"Prompt outputs failed validation","details":"missing model"},"node_errors":{"4":{"errors":[{"message":"Value not in list"}]}}}"#;

        let message = status_message(400, body);
        assert!(message.contains("拒否しました"), "{message}");
        assert!(message.contains("HTTP 400"), "{message}");
        assert!(
            message.contains("Prompt outputs failed validation"),
            "{message}"
        );
        assert!(message.contains("missing model"), "{message}");

        assert!(status_message(404, "{}").contains("見つかりません"));
        assert!(status_message(500, "{}").contains("ComfyUI 側でエラー"));
        assert!(status_message(418, "{}").contains("HTTP 418"));

        // error が無い JSON は node_errors を出す
        let detail = error_detail(r#"{"node_errors":{"3":{"errors":[]}}}"#);
        assert!(
            detail.contains("node_errors") || detail.contains("\"3\""),
            "{detail}"
        );
        assert_eq!(error_detail(""), "（応答なし）");
    }

    #[test]
    fn client_id_is_uuid_v4_shape_and_unique() {
        let first = new_client_id();
        let second = new_client_id();
        assert_eq!(first.len(), 36);
        let groups: Vec<&str> = first.split('-').collect();
        assert_eq!(
            groups.iter().map(|group| group.len()).collect::<Vec<_>>(),
            vec![8, 4, 4, 4, 12]
        );
        assert_eq!(&first[14..15], "4", "UUID v4 のバージョン");
        assert!(
            matches!(&first[19..20], "8" | "9" | "a" | "b"),
            "UUID の variant"
        );
        assert!(first.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
        assert_ne!(first, second);
    }
}
