import { describe, expect, it } from 'vitest'
import {
  describeError,
  formatBytes,
  formatCount,
  formatDate,
  formatDuration,
  formatShortDate,
} from '../src/lib/format'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [-1, '0 B'],
    [Number.NaN, '0 B'],
    [Number.POSITIVE_INFINITY, '0 B'],
    [1, '1 B'],
    [512, '512 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [5.5 * 1024 * 1024 * 1024, '5.5 GB'],
    [2 * 1024 ** 4, '2.0 TB'],
  ])('%s バイト → %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('formatDuration', () => {
  it('null / 0 はダッシュ', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(-5)).toBe('—')
  })

  it('分:秒 と 時:分:秒', () => {
    expect(formatDuration(83_000)).toBe('1:23')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })

  it('秒は四捨五入する', () => {
    expect(formatDuration(59_600)).toBe('1:00')
  })
})

describe('日付と件数', () => {
  it('未走査は null で表す', () => {
    expect(formatDate(null)).toBe('未走査')
    expect(formatShortDate(null)).toBe('—')
  })

  it('日時を ja-JP で整形する', () => {
    const text = formatDate(Date.UTC(2026, 10, 25, 12, 0, 0))
    expect(text).toContain('2026')
    expect(text).not.toBe('未走査')
  })

  it('件数は桁区切りする', () => {
    expect(formatCount(12_345)).toBe('12,345')
  })
})

describe('describeError', () => {
  it('文字列・Error・その他を文字列にする', () => {
    expect(describeError('失敗')).toBe('失敗')
    expect(describeError(new Error('壊れた'))).toBe('壊れた')
    expect(describeError(42)).toBe('42')
  })
})
