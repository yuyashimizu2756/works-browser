import { expect, test } from 'vitest'
import {
  cacheUsagePercent,
  DEFAULT_EXCLUDE_PATTERNS,
  excludePatternsToText,
  normalizeCacheLimitMb,
  normalizeQuality,
  openSettingsFromUrl,
  parseExcludePatterns,
  requiresRescan,
} from '../src/settings/model.ts'

// ---------------------------------------------------------------------------
// 除外パターン（#8）
// ---------------------------------------------------------------------------

test('除外パターンは空行・コメント・重複を落として 1 行 1 件にする', () => {
  const patterns = parseExcludePatterns(
    ['  node_modules  ', '', '# comment', 'NODE_MODULES', '*.tmp', 'cache\\'].join('\n'),
  )
  expect(patterns).toEqual(['node_modules', '*.tmp', 'cache/'])
})

test('除外パターンをテキストエリアに戻すと往復できる', () => {
  const text = excludePatternsToText(DEFAULT_EXCLUDE_PATTERNS)
  expect(text).toBe('node_modules\n__pycache__\n.*')
  expect(parseExcludePatterns(text)).toEqual(DEFAULT_EXCLUDE_PATTERNS)
})

test('除外を空にすると「何も除外しない」になる', () => {
  expect(parseExcludePatterns('   \n\n')).toEqual([])
  expect(excludePatternsToText([])).toBe('')
})

// ---------------------------------------------------------------------------
// サムネイル（#8）
// ---------------------------------------------------------------------------

test('品質は 1–100 の整数に丸める', () => {
  expect(normalizeQuality(0)).toBe(1)
  expect(normalizeQuality(1000)).toBe(100)
  expect(normalizeQuality(82.6)).toBe(83)
  expect(normalizeQuality(Number.NaN)).toBe(75)
})

test('キャッシュ上限は 0–102400 MB に丸める（0 は無制限）', () => {
  expect(normalizeCacheLimitMb(-10)).toBe(0)
  expect(normalizeCacheLimitMb(1_000_000)).toBe(102_400)
  expect(normalizeCacheLimitMb(128.4)).toBe(128)
  expect(normalizeCacheLimitMb(Number.NaN)).toBe(512)
})

test('使用量の割合は上限 0 なら 0%', () => {
  expect(cacheUsagePercent(512, 1024)).toBe(50)
  expect(cacheUsagePercent(2048, 1024)).toBe(100)
  expect(cacheUsagePercent(512, 0)).toBe(0)
})

// ---------------------------------------------------------------------------
// 再走査が必要かの判定
// ---------------------------------------------------------------------------

test('除外パターンの変更は再走査が必要', () => {
  expect(
    requiresRescan(
      { excludePatterns: ['*.tmp'], depthByRoot: {} },
      { excludePatterns: [], depthByRoot: {} },
    ),
  ).toBe(true)
})

test('深さの変更は再走査が必要、有効 / 無効は不要', () => {
  expect(
    requiresRescan(
      { excludePatterns: [], depthByRoot: { 1: 2 } },
      { excludePatterns: [], depthByRoot: { 1: 1 } },
    ),
  ).toBe(true)
  expect(
    requiresRescan(
      { excludePatterns: ['node_modules'], depthByRoot: { 1: 1 } },
      { excludePatterns: ['node_modules'], depthByRoot: { 1: 1 } },
    ),
  ).toBe(false)
})

// ---------------------------------------------------------------------------
// headless 表示用の URL
// ---------------------------------------------------------------------------

test('?settings=1 で設定画面を開く', () => {
  expect(openSettingsFromUrl('?settings=1')).toBe(true)
  expect(openSettingsFromUrl('?settings=true')).toBe(true)
  expect(openSettingsFromUrl('?settings=0')).toBe(false)
  expect(openSettingsFromUrl('')).toBe(false)
})
