/**
 * 設定画面（#8）の純粋なヘルパー。
 *
 * Rust 側の丸め（`config.rs` の `normalized`）と同じ規則を UI でも先に当てて、
 * 保存前のプレビューと保存後の値がずれないようにする。
 */

/** 除外パターンの既定値（Rust の `DEFAULT_EXCLUDE_PATTERNS` と対応）。 */
export const DEFAULT_EXCLUDE_PATTERNS = ['node_modules', '__pycache__', '.*']

/** キャッシュ上限の既定値（MB）。 */
export const DEFAULT_CACHE_LIMIT_MB = 512

/** 品質の範囲。 */
export const QUALITY_MIN = 1
export const QUALITY_MAX = 100

/**
 * テキストエリア（1 行 1 パターン）を配列にする。
 *
 * 空行と `#` 始まりのコメント行を落とし、大文字小文字を無視して重複を畳む。
 * `\` は `/` に寄せる（Rust 側と同じ）。
 */
export function parseExcludePatterns(text: string): string[] {
  const seen = new Set<string>()
  const patterns: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const normalized = trimmed.replace(/\\/g, '/')
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    patterns.push(normalized)
  }
  return patterns
}

/** 配列をテキストエリアの初期値にする（1 行 1 件）。 */
export function excludePatternsToText(patterns: string[]): string {
  return patterns.join('\n')
}

/** 品質を 1–100 の整数に丸める（NaN は既定値）。 */
export function normalizeQuality(value: number, fallback = 75): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Math.round(value)))
}

/** キャッシュ上限（MB）を 0–102400 の整数に丸める（0 = 無制限）。 */
export function normalizeCacheLimitMb(value: number, fallback = DEFAULT_CACHE_LIMIT_MB): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(102_400, Math.max(0, Math.round(value)))
}

/** 使用量と上限から「何 % 使っているか」を返す（上限 0 は 0%）。 */
export function cacheUsagePercent(bytes: number, limitBytes: number): number {
  if (limitBytes <= 0) return 0
  return Math.min(100, Math.round((bytes / limitBytes) * 100))
}

/**
 * 走査の再実行が必要な変更か（#8 の「即時反映 / 次回走査」の出し分け）。
 *
 * 除外パターンと深さは索引の作り直しが要る。品質はサムネイルの作り直し、
 * 表示・シールド・音量は即時。
 */
export function requiresRescan(next: {
  excludePatterns: string[]
  depthByRoot: Record<number, number>
}, previous: {
  excludePatterns: string[]
  depthByRoot: Record<number, number>
}): boolean {
  if (excludePatternsToText(next.excludePatterns) !== excludePatternsToText(previous.excludePatterns)) {
    return true
  }
  const ids = new Set([
    ...Object.keys(next.depthByRoot),
    ...Object.keys(previous.depthByRoot),
  ])
  for (const id of ids) {
    const key = Number(id)
    if (next.depthByRoot[key] !== previous.depthByRoot[key]) return true
  }
  return false
}

/** `?settings=1` で設定画面を開いた状態にする（headless 検証・ベンチ用）。 */
export function openSettingsFromUrl(search = window.location.search): boolean {
  try {
    const params = new URLSearchParams(search)
    const value = params.get('settings')
    return value === '1' || value === 'true' || value === 'open'
  } catch {
    return false
  }
}
