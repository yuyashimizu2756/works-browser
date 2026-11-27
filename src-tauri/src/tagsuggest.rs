//! 生成情報の頻出語からタグ候補を出す（#79）。
//!
//! `files.meta_json` にキャッシュ済みの [`GenerationMeta`] だけを使い、実ファイルは
//! 読み直さない。集計は Rust 側で 1 リクエスト内に完結させる（UI から全作品を走査しない）。
//!
//! 抽出の流れ:
//! 1. prompt / negative_prompt / model / loras を**正規化**する
//!    （小文字化・全角→半角・`_` / `-` → 空白・連続空白の圧縮）
//! 2. 空白・カンマ・改行で**トークン化**する（`(word:1.2)` の重みは語だけ取る）
//! 3. **除外**する（品質系の定型語 / 短すぎる語 / 長すぎる語 / 数字だけ / 既存タグ）
//! 4. 語ごとに「何ファイルで出たか」を数え、頻度順に返す
//!
//! 正規化・トークン化・除外はすべて純関数にしてテストする。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::meta::GenerationMeta;

/// タグ候補 1 件。`count` は、その語を含むファイル数（同じファイル内の重複は 1）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagSuggestion {
    pub name: String,
    pub count: i64,
}

/// タグ候補の長さ上限（文字数）。
///
/// タグ名は `db.rs` の `create_tag` で **40 文字まで**に制限されている。
/// 日本語のプロンプトは空白区切りが無いため、句読点の無い長文が 1 トークンに
/// なり、40 文字を超える候補ができて付与時にエラーになる。タグの上限より
/// 十分小さい **24 文字**で切る（長い候補はタグとしても読みづらい）。
pub const MAX_CANDIDATE_CHARS: usize = 24;

/// 品質系の定型句（複数語）。トークン化のあとにまとめて取り除く。
///
/// 例: `best quality` は `best` / `quality` の 2 語になるため、語単位の除外だけでは
/// 片方が残ってしまう。句として先に消す。
const QUALITY_PHRASES: &[&[&str]] = &[
    &["best", "quality"],
    &["worst", "quality"],
    &["high", "quality"],
    &["normal", "quality"],
    &["low", "quality"],
    &["highest", "quality"],
    &["simple", "background"],
    &["white", "background"],
    &["transparent", "background"],
    &["highly", "detailed"],
    &["ultra", "detailed"],
    &["extremely", "detailed"],
    &["very", "detailed"],
    &["intricate", "details"],
    &["jpeg", "artifacts"],
    &["bad", "anatomy"],
    &["bad", "hands"],
    &["extra", "digits"],
    &["fewer", "digits"],
    &["missing", "fingers"],
    &["extra", "limbs"],
    &["extra", "feet"],
    &["malformed", "limbs"],
    &["artist", "name"],
    &["skin", "spots"],
];

/// 品質系・ネガティブの定型語（1 語）。タグとして意味を持たないので候補にしない。
const QUALITY_WORDS: &[&str] = &[
    "masterpiece",
    "quality",
    "highres",
    "lowres",
    "hires",
    "absurdres",
    "detailed",
    "intricate",
    "ultra",
    "extremely",
    "perfect",
    "blurry",
    "blur",
    "watermark",
    "signature",
    "username",
    "text",
    "logo",
    "censored",
    "uncensored",
    "mosaic",
    "ugly",
    "deformed",
    "disfigured",
    "mutation",
    "mutated",
    "malformed",
    "cropped",
    "grayscale",
    "monochrome",
    "artifacts",
    "bad",
    "worst",
    "best",
];

/// 全角→半角・小文字化・`_` / `-` → 空白・連続空白の圧縮。
///
/// 全角は ASCII の範囲（`！`〜`～`）と全角スペースだけを半角にする。
/// カタカナなどはそのまま（タグとして使えるため）。
pub fn normalize_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        // 全角 ASCII（U+FF01..=U+FF5E）→ 半角、全角スペース → 半角スペース
        let mapped = match ch {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch),
            other => other,
        };
        let mapped = if mapped == '_' || mapped == '-' {
            ' '
        } else {
            mapped
        };
        for lower in mapped.to_lowercase() {
            out.push(if lower.is_whitespace() { ' ' } else { lower });
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// タグ名を比較するときのキー。
///
/// 候補・既存タグの両方で [`normalize_text`] と同じ正規化（小文字化・全角→半角・
/// `_` / `-` → 空白・連続空白の圧縮）を通す。既存タグ `red_dress` と候補
/// `red dress` を別物として扱わないために、比較は必ずこのキーで行う。
pub fn tag_key(name: &str) -> String {
    normalize_text(name)
}

/// 1 トークンを整える。周囲の記号（`(` `)` `,` など）を落とし、
/// A1111 の重み `(word:1.2)` は語だけを取り出す。
fn clean_word(raw: &str) -> Option<String> {
    let trimmed = raw.trim_matches(|ch: char| !ch.is_alphanumeric());
    if trimmed.is_empty() {
        return None;
    }
    let mut word = trimmed;
    if let Some((head, weight)) = word.rsplit_once(':') {
        if !head.is_empty() && weight.parse::<f32>().is_ok() {
            word = head.trim_matches(|ch: char| !ch.is_alphanumeric());
        }
    }
    if word.is_empty() {
        None
    } else {
        Some(word.to_string())
    }
}

/// 空白・カンマ・改行で分割する（正規化込み）。重複は残す。
///
/// 品質系の句・語の除外はここでは行わない（[`candidate_terms`] が行う）。
pub fn tokenize(text: &str) -> Vec<String> {
    normalize_text(text)
        .split(|ch: char| ch.is_whitespace() || ch == ',' || ch == '、')
        .filter_map(clean_word)
        .collect()
}

/// 品質系の句（`best quality` など）をまとめて取り除く。
fn strip_phrases(tokens: Vec<String>) -> Vec<String> {
    let mut out = Vec::with_capacity(tokens.len());
    let mut index = 0;
    'outer: while index < tokens.len() {
        for phrase in QUALITY_PHRASES {
            if tokens.len() - index >= phrase.len()
                && phrase
                    .iter()
                    .enumerate()
                    .all(|(offset, expected)| tokens[index + offset].as_str() == *expected)
            {
                index += phrase.len();
                continue 'outer;
            }
        }
        out.push(tokens[index].clone());
        index += 1;
    }
    out
}

/// タグ候補として使える語か。
///
/// - 3 文字以上（1〜2 文字は情報量が少ない）
/// - [`MAX_CANDIDATE_CHARS`] 文字以下（タグの 40 文字制限より十分小さい）
/// - 数字だけ（`1.0` のような小数を含む）は除外
/// - 品質系の定型語は除外
pub fn is_candidate(word: &str) -> bool {
    let length = word.chars().count();
    if !(3..=MAX_CANDIDATE_CHARS).contains(&length) {
        return false;
    }
    if word.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        return false;
    }
    !QUALITY_WORDS.contains(&word)
}

/// 1 つの文字列から候補語を取り出す（句・語の除外込み。重複は残す）。
pub fn candidate_terms(text: &str) -> Vec<String> {
    strip_phrases(tokenize(text))
        .into_iter()
        .filter(|word| is_candidate(word))
        .collect()
}

/// 1 ファイル分の生成情報から候補語の集合を作る。
///
/// 対象は prompt / negative_prompt / loras / model。同じファイル内で何度出ても 1 語 1 回。
pub fn meta_terms(meta: &GenerationMeta) -> HashSet<String> {
    let mut terms = HashSet::new();
    for text in [
        meta.prompt.as_deref(),
        meta.negative_prompt.as_deref(),
        meta.model.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        terms.extend(candidate_terms(text));
    }
    for lora in &meta.loras {
        terms.extend(candidate_terms(lora));
    }
    terms
}

/// ファイルごとの候補語を数える（`count` = その語を含むファイル数）。
pub fn count_terms<'a>(
    metas: impl IntoIterator<Item = &'a GenerationMeta>,
) -> HashMap<String, i64> {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for meta in metas {
        for term in meta_terms(meta) {
            *counts.entry(term).or_insert(0) += 1;
        }
    }
    counts
}

/// 頻度順（同数は名前順）に並べ、既存タグと上位 N 件で絞る。
///
/// `existing` は既にこの作品に付いているタグ名。呼び出し側が正規化済みでも
/// 未加工でも同じ結果になるよう、比較の直前に [`tag_key`] を通す
/// （`Red_Dress` / `red dress` / 全角表記を同じタグとして扱う）。
pub fn rank(
    counts: &HashMap<String, i64>,
    existing: &HashSet<String>,
    limit: usize,
) -> Vec<TagSuggestion> {
    let existing: HashSet<String> = existing.iter().map(|name| tag_key(name)).collect();
    let mut items: Vec<TagSuggestion> = counts
        .iter()
        .filter(|(name, _)| !existing.contains(&tag_key(name)))
        .map(|(name, count)| TagSuggestion {
            name: name.clone(),
            count: *count,
        })
        .collect();
    items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    items.truncate(limit);
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(prompt: &str) -> GenerationMeta {
        GenerationMeta {
            prompt: Some(prompt.to_string()),
            ..Default::default()
        }
    }

    fn names(items: &[TagSuggestion]) -> Vec<(&str, i64)> {
        items
            .iter()
            .map(|item| (item.name.as_str(), item.count))
            .collect()
    }

    #[test]
    fn normalize_lowercases_and_converts_fullwidth() {
        assert_eq!(normalize_text("  Ｒｅｄ　Dress  "), "red dress");
        // 全角カンマ・全角括弧も半角になる
        assert_eq!(normalize_text("ａ，ｂ"), "a,b");
    }

    #[test]
    fn normalize_replaces_underscore_and_hyphen_with_space() {
        assert_eq!(normalize_text("red_dress"), "red dress");
        assert_eq!(normalize_text("red-dress"), "red dress");
        // 連続空白は 1 つ、前後の空白は落とす
        assert_eq!(normalize_text("  a   b\tc\n"), "a b c");
    }

    #[test]
    fn tokenize_splits_on_space_comma_and_newline() {
        assert_eq!(
            tokenize("red dress, blue eyes\nsunset"),
            vec!["red", "dress", "blue", "eyes", "sunset"]
        );
    }

    #[test]
    fn tokenize_strips_a1111_weights_and_wrappers() {
        assert_eq!(
            tokenize("(masterpiece:1.2), [red_dress], {best quality}"),
            vec!["masterpiece", "red", "dress", "best", "quality"]
        );
    }

    #[test]
    fn candidate_excludes_short_numeric_and_quality_words() {
        assert!(is_candidate("dress"));
        assert!(!is_candidate("a"));
        assert!(!is_candidate("ab"));
        assert!(!is_candidate("12"));
        assert!(!is_candidate("1.0"));
        assert!(!is_candidate("masterpiece"));
        assert!(!is_candidate("highres"));
    }

    #[test]
    fn candidate_rejects_words_longer_than_the_limit() {
        // 日本語の長文（空白なし）・英語の長文のどちらも候補にしない
        let japanese = "あ".repeat(MAX_CANDIDATE_CHARS + 1);
        let english = "a".repeat(MAX_CANDIDATE_CHARS + 1);
        assert!(!is_candidate(&japanese));
        assert!(!is_candidate(&english));
        // 境界（上限ちょうど）は候補に残す
        assert!(is_candidate(&"あ".repeat(MAX_CANDIDATE_CHARS)));
        assert!(is_candidate(&"a".repeat(MAX_CANDIDATE_CHARS)));
    }

    #[test]
    fn candidate_terms_drop_long_japanese_sentence() {
        // 句読点も空白も無い日本語の長文は 1 トークンになる
        let sentence = "桜の花びらが舞い散る美しい夜の街並みを歩く黒猫と少年";
        assert!(sentence.chars().count() > MAX_CANDIDATE_CHARS);
        assert!(candidate_terms(sentence).is_empty());
    }

    #[test]
    fn candidates_never_reach_the_tag_length_limit() {
        let too_long = "桜の花びらが舞い散る美しい夜の街並みを歩く黒猫と少年";
        let prompt =
            format!("夕焼けの屋上で風に揺れる制服の少女, {too_long}, red dress, 50mm photo");
        let terms = candidate_terms(&prompt);
        // 24 文字を超える語は出ず、タグ作成の 40 文字制限にも絶対に達しない
        assert!(terms
            .iter()
            .all(|term| term.chars().count() <= MAX_CANDIDATE_CHARS));
        assert!(terms.iter().all(|term| term.chars().count() <= 40));
        assert!(!terms.iter().any(|term| term == too_long));
        assert!(terms.iter().any(|term| term == "red"));
    }

    #[test]
    fn tag_key_equates_underscore_space_and_fullwidth() {
        assert_eq!(tag_key("Red_Dress"), "red dress");
        assert_eq!(tag_key("red-dress"), tag_key("red dress"));
        assert_eq!(tag_key("ＲＥＤ＿ＤＲＥＳＳ"), tag_key("red dress"));
        assert_eq!(tag_key("  Red   Dress  "), tag_key("red_dress"));
    }

    #[test]
    fn candidate_terms_drops_multiword_boilerplate() {
        assert_eq!(
            candidate_terms("best quality, simple background, red dress, highres"),
            vec!["red", "dress"]
        );
        // 句の一部だけが残らない（`best` / `quality` / `simple` / `background` は消える）
        assert!(candidate_terms("simple background").is_empty());
    }

    #[test]
    fn meta_terms_dedups_within_a_file() {
        let mut value = meta("red dress, red dress, red eyes");
        value.negative_prompt = Some("worst quality, dress".to_string());
        value.model = Some("red_dress_model".to_string());
        value.loras = vec!["red_style: 0.8".to_string()];

        let terms = meta_terms(&value);
        assert!(terms.contains("red"));
        assert!(terms.contains("dress"));
        assert!(terms.contains("eyes"));
        // `red_style: 0.8` は重みではなく LoRA 名と強度。名前は語になり、強度は数字だけなので消える
        assert!(terms.contains("style"));
        assert!(!terms.contains("0.8"));
        assert!(!terms.contains("worst"));
        assert!(!terms.contains("quality"));
    }

    #[test]
    fn count_terms_counts_files_not_repeats() {
        let first = meta("red dress, red dress");
        let second = meta("blue eyes");
        let counts = count_terms([&first, &second]);
        assert_eq!(counts.get("red"), Some(&1));
        assert_eq!(counts.get("dress"), Some(&1));
        assert_eq!(counts.get("blue"), Some(&1));
    }

    #[test]
    fn rank_orders_by_count_then_name_and_excludes_existing() {
        let counts = HashMap::from([
            ("dress".to_string(), 3),
            ("red".to_string(), 3),
            ("sunset".to_string(), 5),
            ("taken".to_string(), 9),
        ]);
        let existing = HashSet::from(["taken".to_string()]);
        let ranked = rank(&counts, &existing, 3);

        assert_eq!(
            names(&ranked),
            vec![("sunset", 5), ("dress", 3), ("red", 3)]
        );
        // 上限を超えない
        assert_eq!(rank(&counts, &existing, 1).len(), 1);
    }

    #[test]
    fn rank_treats_same_normalized_tag_as_the_same() {
        let counts = HashMap::from([("red dress".to_string(), 4), ("red".to_string(), 2)]);
        // `_` / 全角 / 連続空白 / 大文字小文字の違いは同じタグとして除外する
        for existing_name in [
            "red_dress",
            "Red Dress",
            "ＲＥＤ－ＤＲＥＳＳ",
            "  red   dress ",
        ] {
            let existing = HashSet::from([existing_name.to_string()]);
            let ranked = rank(&counts, &existing, 20);
            assert_eq!(names(&ranked), vec![("red", 2)], "existing={existing_name}");
        }
        // 別の語は残る
        let existing = HashSet::from(["red_dress".to_string()]);
        let ranked = rank(&counts, &existing, 20);
        assert!(ranked.iter().any(|item| item.name == "red"));
    }

    #[test]
    fn empty_meta_yields_no_suggestions() {
        let counts = count_terms([&GenerationMeta::default()]);
        assert!(counts.is_empty());
        assert!(rank(&counts, &HashSet::new(), 20).is_empty());
    }
}
