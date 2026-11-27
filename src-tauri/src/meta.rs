//! 生成メタデータの抽出（#60）。
//!
//! 画像・動画に埋め込まれた「生成に使った情報」を読む。
//! - PNG の `tEXt` / `iTXt`（A1111 の `parameters`、ComfyUI の `prompt` / `workflow`）
//! - JPEG / WebP の EXIF `UserComment`（A1111）
//! - 同じフォルダのサイドカー（`<name>.json` / `<name>.txt` / `<name>.civitai.json`）
//!
//! 走査時ではなく表示時に呼ばれる想定。失敗しても `None` を返すだけで落とさない。

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

/// 正規化した生成情報。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GenerationMeta {
    pub prompt: Option<String>,
    pub negative_prompt: Option<String>,
    pub model: Option<String>,
    pub loras: Vec<String>,
    pub steps: Option<String>,
    pub sampler: Option<String>,
    pub cfg: Option<String>,
    pub seed: Option<String>,
    pub size: Option<String>,
    /// 元の文字列（JSON / parameters 全文）。UI の「生データ」表示に使う。
    pub raw: Option<String>,
    /// どこから取れたか（`png` / `exif` / `sidecar` / `video`）。
    pub source: String,
    /// #73: ComfyUI の `workflow`（UI 形式）の全文。
    /// 設定の workflows フォルダへ `<name>.json` として保存し、`?workflow=<name>` で開く。
    /// 壊れた JSON は `None`（そのまま UI に流さない）。
    #[serde(default)]
    pub workflow_json: Option<String>,
    /// #73: ComfyUI の `prompt`（API 形式）の全文。`POST /prompt` にそのまま送る。
    /// API 形式（各ノードが `class_type` と `inputs` を持つ）と確認できたものだけ入る。
    #[serde(default)]
    pub api_prompt: Option<String>,
}

fn clean(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// A1111 形式（`parameters`）の文字列を分解する。
///
/// 例:
/// ```text
/// masterpiece, best quality
/// Negative prompt: worst quality
/// Steps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 123, Size: 832x1216, Model: foo
/// ```
pub fn parse_a1111(text: &str) -> GenerationMeta {
    let mut meta = GenerationMeta {
        raw: Some(text.to_string()),
        source: "parameters".to_string(),
        ..Default::default()
    };

    let mut prompt_lines: Vec<&str> = Vec::new();
    let mut negative_lines: Vec<&str> = Vec::new();
    let mut in_negative = false;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Negative prompt:") {
            in_negative = true;
            if let Some(value) = clean(rest) {
                negative_lines.push(Box::leak(value.into_boxed_str()));
            }
            continue;
        }
        // パラメータ行（`Steps: ...`）に当たったら以降は設定として扱う
        if line.starts_with("Steps:") {
            for pair in line.split(',') {
                let Some((key, value)) = pair.split_once(':') else {
                    continue;
                };
                let value = value.trim();
                match key.trim() {
                    "Steps" => meta.steps = clean(value),
                    "Sampler" => meta.sampler = clean(value),
                    "CFG scale" => meta.cfg = clean(value),
                    "Seed" => meta.seed = clean(value),
                    "Size" => meta.size = clean(value),
                    "Model" => meta.model = clean(value),
                    _ => {}
                }
            }
            continue;
        }
        if in_negative {
            negative_lines.push(Box::leak(line.to_string().into_boxed_str()));
        } else {
            prompt_lines.push(Box::leak(line.to_string().into_boxed_str()));
        }
    }

    let prompt = prompt_lines.join("\n").trim().to_string();
    let negative = negative_lines.join("\n").trim().to_string();
    meta.prompt = clean(&prompt);
    meta.negative_prompt = clean(&negative);
    meta
}

/// ComfyUI の API 形式（`prompt`）らしいか。
///
/// 各ノードが `class_type`（文字列）と `inputs`（オブジェクト）を持つ
/// `{ "3": {...}, "4": {...} }` の形だけを API 形式とみなす。UI 形式の
/// `workflow` を誤って `POST /prompt` に送らないための判定。
pub fn looks_like_api_prompt(value: &serde_json::Value) -> bool {
    let Some(nodes) = value.as_object() else {
        return false;
    };
    if nodes.is_empty() {
        return false;
    }
    nodes.values().all(|node| {
        node.get("class_type")
            .and_then(|v| v.as_str())
            .is_some_and(|class| !class.is_empty())
            && node.get("inputs").is_some_and(|v| v.is_object())
    })
}

/// ComfyUI の `prompt`（API形式）から代表値を拾う。
pub fn parse_comfy_prompt(text: &str) -> Option<GenerationMeta> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let nodes = value.as_object()?;
    let mut meta = GenerationMeta {
        raw: Some(text.to_string()),
        source: "comfy".to_string(),
        ..Default::default()
    };
    if looks_like_api_prompt(&value) {
        meta.api_prompt = Some(text.to_string());
    }

    for node in nodes.values() {
        let class = node
            .get("class_type")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let inputs = node.get("inputs");
        let Some(inputs) = inputs.and_then(|v| v.as_object()) else {
            continue;
        };
        match class {
            "CLIPTextEncode" => {
                if let Some(text) = inputs.get("text").and_then(|v| v.as_str()) {
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    // ネガティブは慣例的に negative を含むノード名か、空でない方の2番目
                    if text.to_ascii_lowercase().contains("worst quality")
                        || text.to_ascii_lowercase().contains("negative")
                    {
                        meta.negative_prompt.get_or_insert_with(|| text.to_string());
                    } else {
                        meta.prompt.get_or_insert_with(|| text.to_string());
                    }
                }
            }
            "KSampler" | "KSamplerAdvanced" => {
                for (key, target) in [
                    ("steps", &mut meta.steps),
                    ("sampler_name", &mut meta.sampler),
                    ("cfg", &mut meta.cfg),
                    ("seed", &mut meta.seed),
                ] {
                    if target.is_none() {
                        if let Some(value) = inputs.get(key) {
                            *target = Some(match value {
                                serde_json::Value::String(s) => s.clone(),
                                other => other.to_string(),
                            });
                        }
                    }
                }
            }
            "CheckpointLoaderSimple" => {
                if meta.model.is_none() {
                    if let Some(name) = inputs.get("ckpt_name").and_then(|v| v.as_str()) {
                        meta.model = clean(name);
                    }
                }
            }
            "LoraLoader" => {
                if let Some(name) = inputs.get("lora_name").and_then(|v| v.as_str()) {
                    let weight = inputs
                        .get("strength_model")
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "1".to_string());
                    meta.loras.push(format!("{name}: {weight}"));
                }
            }
            _ => {}
        }
    }

    if meta.prompt.is_none() && meta.raw.is_none() {
        return None;
    }
    Some(meta)
}

/// ComfyUI の `workflow`（UI形式）から、表示用の代表値だけを拾う。
///
/// workflow はノードの配列（`nodes[].type` / `widgets_values`）なので、
/// API 形式ほど確実には読めない。ここではプロンプトとモデル名だけを拾い、
/// 読めなくても `workflow_json` は保持する（「ComfyUI へ」で開くため）。
pub fn parse_comfy_workflow(text: &str, value: &serde_json::Value) -> GenerationMeta {
    let mut meta = GenerationMeta {
        raw: Some(text.to_string()),
        source: "comfy".to_string(),
        workflow_json: Some(text.to_string()),
        ..Default::default()
    };

    let Some(nodes) = value.get("nodes").and_then(|v| v.as_array()) else {
        return meta;
    };
    for node in nodes {
        let class = node.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let widgets = node.get("widgets_values").and_then(|v| v.as_array());
        match class {
            "CLIPTextEncode" => {
                if let Some(text) = widgets
                    .and_then(|values| values.first())
                    .and_then(|v| v.as_str())
                {
                    let text = text.trim();
                    if text.is_empty() {
                        continue;
                    }
                    let lower = text.to_ascii_lowercase();
                    if lower.contains("worst quality") || lower.contains("negative") {
                        meta.negative_prompt.get_or_insert_with(|| text.to_string());
                    } else {
                        meta.prompt.get_or_insert_with(|| text.to_string());
                    }
                }
            }
            "CheckpointLoaderSimple" => {
                if let Some(name) = widgets
                    .and_then(|values| values.first())
                    .and_then(|v| v.as_str())
                {
                    if meta.model.is_none() {
                        meta.model = clean(name);
                    }
                }
            }
            _ => {}
        }
    }
    meta
}

/// PNG のテキストチャンクを読む。
fn read_png_text(path: &Path) -> Option<Vec<(String, String)>> {
    let file = std::fs::File::open(path).ok()?;
    let decoder = png::Decoder::new(std::io::BufReader::new(file));
    let reader = decoder.read_info().ok()?;
    let info = reader.info();
    let mut out = Vec::new();
    for chunk in &info.uncompressed_latin1_text {
        out.push((chunk.keyword.clone(), chunk.text.clone()));
    }
    for chunk in &info.compressed_latin1_text {
        if let Ok(text) = chunk.get_text() {
            out.push((chunk.keyword.clone(), text));
        }
    }
    for chunk in &info.utf8_text {
        if let Ok(text) = chunk.get_text() {
            out.push((chunk.keyword.clone(), text));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// JPEG / WebP の EXIF `UserComment` を読む。
fn read_exif_comment(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut buf = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut buf).ok()?;
    let field = exif.get_field(exif::Tag::UserComment, exif::In::PRIMARY)?;
    let text = field.display_value().with_unit(&exif).to_string();
    clean(&text)
}

/// ffmetadata（`ffmpeg -f ffmetadata -`）から生成情報らしい値を取り出す（#60）。
///
/// `comment` / `prompt` / `description` の順に見る。A1111 は `comment` に
/// `parameters` 相当の文字列を書くことがある。値の `\n` などは最低限戻す。
fn parse_ffmetadata(text: &str) -> Option<String> {
    let mut comment = None;
    let mut prompt = None;
    let mut description = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().replace("\\n", "\n").replace("\\r", "");
        if value.trim().is_empty() {
            continue;
        }
        match key.trim().to_ascii_lowercase().as_str() {
            "comment" => comment.get_or_insert(value),
            "prompt" => prompt.get_or_insert(value),
            "description" => description.get_or_insert(value),
            _ => continue,
        };
    }
    prompt.or(comment).or(description)
}

/// 動画から ffmpeg の `ffmetadata` を読む。ffmpeg が無ければ `None`。
fn read_video_metadata(path: &Path) -> Option<String> {
    let (ffmpeg, _) = crate::thumbs::video::resolve(None);
    let ffmpeg = ffmpeg?;
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-f", "ffmetadata", "-"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_ffmetadata(&text)
}

fn is_video(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "mkv" | "webm" | "mov" | "m4v" | "avi" | "wmv" | "flv")
    )
}

/// サイドカー（`<name>.worksmeta.json` / `<name>.json` / `<name>.txt` / manifest）を探す。
fn read_sidecar(path: &Path) -> Option<String> {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let dir = path.parent()?;

    // 1) 明示的な規約: `<name>.worksmeta.json`
    let worksmeta = dir.join(format!("{stem}.worksmeta.json"));
    if worksmeta != path {
        if let Ok(text) = std::fs::read_to_string(&worksmeta) {
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }

    // 2) manifest.jsonl（同ディレクトリ）から自分の行を探す
    if let Ok(manifest) = std::fs::read_to_string(dir.join("manifest.jsonl")) {
        for line in manifest.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if !line.contains(stem) {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                let matches_file = value
                    .get("file")
                    .or_else(|| value.get("path"))
                    .or_else(|| value.get("output"))
                    .and_then(|v| v.as_str())
                    .map(|name| name.contains(stem))
                    .unwrap_or(false);
                if matches_file {
                    return Some(line.to_string());
                }
            }
        }
    }

    let candidates = [
        path.with_extension("json"),
        path.with_extension("txt"),
        path.with_extension("civitai.json"),
    ];
    for candidate in candidates {
        if candidate == path {
            continue; // 自分自身（.txt ファイル）はサイドカーにしない
        }
        if let Ok(text) = std::fs::read_to_string(&candidate) {
            if text.trim().is_empty() {
                continue;
            }
            return Some(text);
        }
    }
    None
}

/// 1ファイル分の生成情報を抽出する。
pub fn extract(path: &Path) -> Option<GenerationMeta> {
    // 1) PNG のテキストチャンク
    if let Some(chunks) = read_png_text(path) {
        // A1111 の `parameters` を優先（既存の挙動を保つ）
        if let Some((_, text)) = chunks.iter().find(|(key, _)| key == "parameters") {
            return Some(parse_a1111(text));
        }

        // #73: ComfyUI は API 形式の `prompt` と UI 形式の `workflow` を別々に持つ。
        // 実データ（D:\ComfyUI\output）は `prompt` だけなので、API 形式を主経路にする。
        // 壊れた JSON は無いものとして扱い、次の抽出元へ落とす。
        let workflow = chunks
            .iter()
            .find(|(key, _)| key == "workflow")
            .and_then(|(_, text)| {
                serde_json::from_str::<serde_json::Value>(text)
                    .ok()
                    .filter(|value| value.is_object())
                    .map(|value| (text.clone(), value))
            });
        let api_prompt = chunks
            .iter()
            .find(|(key, _)| key == "prompt")
            .and_then(|(_, text)| {
                serde_json::from_str::<serde_json::Value>(text)
                    .ok()
                    .filter(|value| value.is_object())
                    .map(|_| text.clone())
            });

        if let Some(api_prompt) = &api_prompt {
            let mut meta = parse_comfy_prompt(api_prompt).unwrap_or_else(|| GenerationMeta {
                raw: Some(api_prompt.clone()),
                source: "comfy".to_string(),
                ..Default::default()
            });
            // API 形式と確認できたものだけが `api_prompt` に入る
            // （UI 形式を誤って再実行しないため）。
            if let Some((text, _)) = &workflow {
                meta.workflow_json = Some(text.clone());
            }
            return Some(meta);
        }
        if let Some((text, value)) = &workflow {
            return Some(parse_comfy_workflow(text, value));
        }

        if let Some((_, text)) = chunks.iter().find(|(key, _)| key == "Comment") {
            return Some(parse_a1111(text));
        }
    }

    // 2) EXIF
    if let Some(comment) = read_exif_comment(path) {
        let mut meta = parse_a1111(&comment);
        meta.source = "exif".to_string();
        return Some(meta);
    }

    // 3) 動画の ffmetadata（comment / prompt）
    if is_video(path) {
        if let Some(text) = read_video_metadata(path) {
            if let Some(mut meta) = parse_comfy_prompt(&text) {
                meta.source = "video".to_string();
                return Some(meta);
            }
            let mut meta = parse_a1111(&text);
            meta.source = "video".to_string();
            return Some(meta);
        }
    }

    // 4) サイドカー
    if let Some(text) = read_sidecar(path) {
        if let Some(mut meta) = parse_comfy_prompt(&text) {
            meta.source = "sidecar".to_string();
            meta.raw = Some(text);
            return Some(meta);
        }
        let mut meta = parse_a1111(&text);
        meta.source = "sidecar".to_string();
        return Some(meta);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parse_a1111_extracts_fields() {
        let text = "masterpiece, girl\nNegative prompt: worst quality, low quality\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 42, Size: 832x1216, Model: fooMix";
        let meta = parse_a1111(text);
        assert_eq!(meta.prompt.as_deref(), Some("masterpiece, girl"));
        assert_eq!(
            meta.negative_prompt.as_deref(),
            Some("worst quality, low quality")
        );
        assert_eq!(meta.steps.as_deref(), Some("30"));
        assert_eq!(meta.cfg.as_deref(), Some("7"));
        assert_eq!(meta.seed.as_deref(), Some("42"));
        assert_eq!(meta.model.as_deref(), Some("fooMix"));
    }

    #[test]
    fn parse_comfy_prompt_reads_nodes() {
        let json = r#"{
          "3": {"class_type": "KSampler", "inputs": {"steps": 25, "sampler_name": "euler", "cfg": 6.5, "seed": 7}},
          "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}},
          "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}}
        }"#;
        let meta = parse_comfy_prompt(json).expect("parsed");
        assert_eq!(meta.steps.as_deref(), Some("25"));
        assert_eq!(meta.sampler.as_deref(), Some("euler"));
        assert_eq!(meta.cfg.as_deref(), Some("6.5"));
        assert_eq!(meta.model.as_deref(), Some("model.safetensors"));
        assert_eq!(meta.prompt.as_deref(), Some("a cat"));
        assert_eq!(
            meta.api_prompt.as_deref(),
            Some(json),
            "API 形式は再実行用にそのまま保持する"
        );
        assert!(meta.workflow_json.is_none());
    }

    #[test]
    fn parse_ffmetadata_prefers_prompt_then_comment() {
        let text = ";FFMETADATA1\ncomment=Steps: 20, Sampler: euler, Seed: 9\nprompt=a cat\n";
        assert_eq!(parse_ffmetadata(text).as_deref(), Some("a cat"));
        let text = ";FFMETADATA1\ncomment=masterpiece\\nNegative prompt: worst\n";
        assert_eq!(
            parse_ffmetadata(text).as_deref(),
            Some("masterpiece\nNegative prompt: worst")
        );
        assert!(parse_ffmetadata(";FFMETADATA1\n").is_none());
    }

    #[test]
    fn extract_returns_none_for_plain_file() {
        let dir = std::env::temp_dir().join(format!("wb-meta-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plain.txt");
        std::fs::write(&path, "hello").unwrap();
        assert!(extract(&path).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // #73: ComfyUI の workflow（UI 形式）/ prompt（API 形式）
    // -----------------------------------------------------------------------

    const API_PROMPT: &str = r#"{
      "3": {"class_type": "KSampler", "inputs": {"steps": 25, "sampler_name": "euler", "cfg": 6.5, "seed": 7}},
      "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "model.safetensors"}},
      "5": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}}
    }"#;

    const UI_WORKFLOW: &str = r#"{
      "nodes": [
        {"id": 4, "type": "CheckpointLoaderSimple", "widgets_values": ["ui-model.safetensors"]},
        {"id": 5, "type": "CLIPTextEncode", "widgets_values": ["a dog"]}
      ],
      "links": []
    }"#;

    /// 1×1 の PNG にテキストチャンクを書く（実際の ComfyUI 出力と同じ形）。
    fn write_png_with_text(dir: &Path, name: &str, chunks: &[(&str, &str)]) -> PathBuf {
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), 1, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        for (keyword, text) in chunks {
            encoder
                .add_text_chunk((*keyword).to_string(), (*text).to_string())
                .unwrap();
        }
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0, 0, 0, 0]).unwrap();
        writer.finish().unwrap();
        path
    }

    #[test]
    fn extract_png_reads_workflow_and_api_prompt_together() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = write_png_with_text(
            dir.path(),
            "both.png",
            &[("prompt", API_PROMPT), ("workflow", UI_WORKFLOW)],
        );

        let meta = extract(&path).expect("both chunks");
        assert_eq!(meta.source, "comfy");
        assert_eq!(meta.api_prompt.as_deref(), Some(API_PROMPT));
        assert_eq!(meta.workflow_json.as_deref(), Some(UI_WORKFLOW));
        assert_eq!(meta.prompt.as_deref(), Some("a cat"));
        assert_eq!(meta.model.as_deref(), Some("model.safetensors"));
        // 既存の raw（API JSON 全文）は壊さない
        assert_eq!(meta.raw.as_deref(), Some(API_PROMPT));
    }

    #[test]
    fn extract_png_api_prompt_only_is_the_main_path() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = write_png_with_text(dir.path(), "api.png", &[("prompt", API_PROMPT)]);

        let meta = extract(&path).expect("api prompt");
        assert_eq!(meta.api_prompt.as_deref(), Some(API_PROMPT));
        assert!(meta.workflow_json.is_none());
        assert_eq!(meta.prompt.as_deref(), Some("a cat"));
    }

    #[test]
    fn extract_png_workflow_only_keeps_ui_graph() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = write_png_with_text(dir.path(), "workflow.png", &[("workflow", UI_WORKFLOW)]);

        let meta = extract(&path).expect("workflow");
        assert!(meta.api_prompt.is_none(), "UI 形式は再実行に使わない");
        assert_eq!(meta.workflow_json.as_deref(), Some(UI_WORKFLOW));
        assert_eq!(meta.prompt.as_deref(), Some("a dog"));
        assert_eq!(meta.model.as_deref(), Some("ui-model.safetensors"));
    }

    #[test]
    fn extract_png_ignores_broken_json() {
        let dir = tempfile::TempDir::new().unwrap();

        // 両方壊れている → 生成情報なし
        let broken = write_png_with_text(
            dir.path(),
            "broken.png",
            &[("prompt", "{ not json"), ("workflow", "{ nodes: [")],
        );
        assert!(extract(&broken).is_none());

        // prompt だけ壊れている → workflow は使える
        let mixed = write_png_with_text(
            dir.path(),
            "mixed.png",
            &[("prompt", "{ broken"), ("workflow", UI_WORKFLOW)],
        );
        let meta = extract(&mixed).expect("workflow survives");
        assert!(meta.api_prompt.is_none());
        assert_eq!(meta.workflow_json.as_deref(), Some(UI_WORKFLOW));

        // どちらも無い（関係ないチャンクだけ） → 生成情報なし
        let none = write_png_with_text(dir.path(), "none.png", &[("Software", "comfyui")]);
        assert!(extract(&none).is_none());
    }

    #[test]
    fn generation_meta_roundtrips_comfy_fields_and_reads_old_cache() {
        let meta = GenerationMeta {
            prompt: Some("a cat".to_string()),
            workflow_json: Some(r#"{"nodes":[]}"#.to_string()),
            api_prompt: Some(API_PROMPT.to_string()),
            source: "comfy".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&meta).unwrap();
        let back: GenerationMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back.workflow_json, meta.workflow_json);
        assert_eq!(back.api_prompt, meta.api_prompt);

        // #73 より前のキャッシュ（新しいキーが無い）も読める
        let old = r#"{"prompt":"a cat","negative_prompt":null,"model":null,"loras":[],
            "steps":null,"sampler":null,"cfg":null,"seed":null,"size":null,
            "raw":"{}","source":"comfy"}"#;
        let parsed: GenerationMeta = serde_json::from_str(old).unwrap();
        assert_eq!(parsed.prompt.as_deref(), Some("a cat"));
        assert!(parsed.workflow_json.is_none());
        assert!(parsed.api_prompt.is_none());
    }

    #[test]
    fn looks_like_api_prompt_rejects_ui_workflow() {
        let api: serde_json::Value = serde_json::from_str(API_PROMPT).unwrap();
        let ui: serde_json::Value = serde_json::from_str(UI_WORKFLOW).unwrap();
        assert!(looks_like_api_prompt(&api));
        assert!(!looks_like_api_prompt(&ui));
        assert!(!looks_like_api_prompt(&serde_json::json!({})));
        assert!(!looks_like_api_prompt(
            &serde_json::json!({"3": {"class_type": "KSampler"}})
        ));
    }
}
