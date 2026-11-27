//! 走査の除外パターン（#8）。
//!
//! `config.json` の `exclude_patterns` は 1 行 1 件の glob。`*` は任意の文字列
//! （区切り文字も含む）、`?` は任意の 1 文字。大文字小文字は区別しない。
//! パターンは「ファイル / フォルダ名」と「ルートからの相対パス」の両方に当てる。
//!
//! 例:
//! - `node_modules` … どこにある `node_modules` フォルダも除外
//! - `*.tmp` … 拡張子 `.tmp` のファイルを除外
//! - `work_*/cache` … 相対パスが `work_1/cache` のようなフォルダを除外
//!
//! 既定値（[`crate::config::DEFAULT_EXCLUDE_PATTERNS`]）は `node_modules`、
//! `__pycache__`、`.*`（ドット始まり）。

/// パターンを比較しやすい形にそろえる（`/` 区切り、末尾の `/` は落とす）。
pub fn normalize_pattern(pattern: &str) -> String {
    pattern
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// glob 1 件と文字列の一致（大文字小文字を無視）。
///
/// `*` は 0 文字以上、`?` は 1 文字に一致する。バックスラッシュも `/` として扱う。
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern = normalize_pattern(pattern);
    if pattern.is_empty() {
        return false;
    }
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.replace('\\', "/").to_lowercase().chars().collect();

    // 古典的なワイルドカード照合（`*` の位置を覚えて戻る）。
    let (mut p, mut t) = (0_usize, 0_usize);
    let (mut star, mut mark) = (None, 0_usize);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

/// 相対パス（`\` / `/`）と名前が、どれかのパターンに一致するか。
///
/// 空行と `#` 始まりの行は無視する。
pub fn is_excluded(rel_path: &str, name: &str, patterns: &[String]) -> bool {
    let rel_path = rel_path.replace('\\', "/");
    patterns.iter().any(|pattern| {
        let pattern = normalize_pattern(pattern);
        if pattern.is_empty() || pattern.starts_with('#') {
            return false;
        }
        glob_match(&pattern, name) || glob_match(&pattern, &rel_path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patterns(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn glob_handles_star_and_question() {
        assert!(glob_match("*.tmp", "cache.tmp"));
        assert!(glob_match("*.tmp", "CACHE.TMP"));
        assert!(!glob_match("*.tmp", "cache.webp"));
        assert!(glob_match("work_?", "work_1"));
        assert!(!glob_match("work_?", "work_12"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("a*b*c", "a-X-b-Y-c"));
        assert!(!glob_match("a*b*c", "a-X-b"));
        assert!(glob_match("models/", "models"));
    }

    #[test]
    fn patterns_match_names_and_relative_paths() {
        let list = patterns(&["node_modules", "*.tmp", "work_*/cache"]);
        assert!(is_excluded("a/node_modules/b.jpg", "node_modules", &list));
        assert!(is_excluded("a/b/note.tmp", "note.tmp", &list));
        // フォルダ自身の相対パスで判定する（配下は walkdir が降りない）
        assert!(is_excluded("work_1/cache", "cache", &list));
        assert!(!is_excluded("work_1/output/001.jpg", "001.jpg", &list));
    }

    #[test]
    fn blank_and_comment_patterns_are_ignored() {
        let list = patterns(&["", "  ", "# comment"]);
        assert!(!is_excluded("a/b.jpg", "b.jpg", &list));
    }

    #[test]
    fn dot_pattern_matches_hidden_names() {
        let list = patterns(&[".*"]);
        assert!(is_excluded(".hidden", ".hidden", &list));
        assert!(is_excluded("a/.git/config", ".git", &list));
        assert!(!is_excluded("a/b.jpg", "b.jpg", &list));
    }
}
