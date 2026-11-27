import { describe, expect, it } from 'vitest'
import {
  hueForTitle,
  initialsForTitle,
  placeholderFontSize,
  titleHash,
} from '../src/library/placeholder'

describe('placeholder（#98 タイポグラフィック・カバー）', () => {
  it('同じタイトルは常に同じ色相 / ハッシュになる', () => {
    expect(titleHash('静かな海')).toBe(titleHash('静かな海'))
    expect(hueForTitle('静かな海')).toBe(hueForTitle('静かな海'))
  })

  it('色相は 0〜359 に収まり、タイトルで変わる', () => {
    const hues = new Set(
      ['静かな海', 'Bench Work 00001', '夜のプール', 'morning paper'].map(hueForTitle),
    )
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
    expect(hues.size).toBeGreaterThan(1)
  })

  it('日本語は 1 文字、英数字は 2 文字（大文字）', () => {
    expect(initialsForTitle('静かな海')).toBe('静')
    expect(initialsForTitle('ベンチ作品 00001')).toBe('ベ')
    expect(initialsForTitle('夜のプール')).toBe('夜')
    expect(initialsForTitle('Bench Work 00001')).toBe('BE')
    expect(initialsForTitle('morning paper')).toBe('MO')
    expect(initialsForTitle('2026 summer')).toBe('20')
  })

  it('先頭の記号・空白は読み飛ばし、空なら `·`', () => {
    expect(initialsForTitle('「夜」の記憶')).toBe('夜')
    expect(initialsForTitle('  深海  ')).toBe('深')
    expect(initialsForTitle('')).toBe('·')
    expect(initialsForTitle('!!!')).toBe('!')
  })

  it('文字サイズはカバー高さに追従し 56〜72px に収める', () => {
    expect(placeholderFontSize(undefined)).toBe(64)
    expect(placeholderFontSize(100)).toBe(56)
    expect(placeholderFontSize(177)).toBe(64)
    expect(placeholderFontSize(260)).toBe(72)
  })
})
