import { describe, expect, it } from 'vitest'
import {
  canCompare,
  canPan,
  clampCompareZoom,
  compareLayout,
  COMPARE_MAX_ZOOM,
  COMPARE_MIN_ZOOM,
  normalizeCompareCount,
  zoomAfterWheel,
} from '../src/lib/compare'

describe('compareLayout', () => {
  it('2 枚は左右 1 行', () => {
    const layout = compareLayout(2)
    expect(layout.columns).toBe(2)
    expect(layout.rows).toBe(1)
    expect(layout.cells).toEqual([
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
    ])
    expect(layout.style.gridTemplateRows).toBe('minmax(0, 1fr)')
  })

  it('3 枚は左 1 + 右 2（左が縦 2 行を占める）', () => {
    const layout = compareLayout(3)
    expect(layout.columns).toBe(2)
    expect(layout.rows).toBe(2)
    expect(layout.cells).toHaveLength(3)
    expect(layout.cells[0]).toEqual({ gridColumn: '1', gridRow: '1 / span 2' })
    expect(layout.cells[1]).toEqual({ gridColumn: '2', gridRow: '1' })
    expect(layout.cells[2]).toEqual({ gridColumn: '2', gridRow: '2' })
  })

  it('4 枚は 2×2', () => {
    const layout = compareLayout(4)
    expect(layout.columns).toBe(2)
    expect(layout.rows).toBe(2)
    expect(layout.cells).toHaveLength(4)
    // すべてのセルが重ならず 2×2 のどこかに入る
    const slots = new Set(layout.cells.map((cell) => `${cell.gridColumn}:${cell.gridRow}`))
    expect(slots.size).toBe(4)
  })

  it('2〜4 の外は範囲に丸める（1 枚でも 2 枚分の枠を返す）', () => {
    expect(normalizeCompareCount(0)).toBe(2)
    expect(normalizeCompareCount(1)).toBe(2)
    expect(normalizeCompareCount(9)).toBe(4)
    expect(normalizeCompareCount(Number.NaN)).toBe(2)
    expect(compareLayout(1).cells).toHaveLength(2)
    expect(compareLayout(6).cells).toHaveLength(4)
  })

  it('2〜4 枚だけ比較できる', () => {
    expect(canCompare(1)).toBe(false)
    expect(canCompare(2)).toBe(true)
    expect(canCompare(3)).toBe(true)
    expect(canCompare(4)).toBe(true)
    expect(canCompare(5)).toBe(false)
  })
})

describe('ズームとパン', () => {
  it('ホイール上方向で拡大、下方向で縮小する', () => {
    expect(zoomAfterWheel(1, -120)).toBeGreaterThan(1)
    expect(zoomAfterWheel(1, 120)).toBeLessThan(1)
  })

  it('20%〜800% に収まる', () => {
    expect(clampCompareZoom(0.01)).toBe(COMPARE_MIN_ZOOM)
    expect(clampCompareZoom(100)).toBe(COMPARE_MAX_ZOOM)
    expect(clampCompareZoom(Number.NaN)).toBe(1)
    expect(zoomAfterWheel(7.9, -10_000)).toBe(COMPARE_MAX_ZOOM)
    expect(zoomAfterWheel(0.3, 10_000)).toBe(COMPARE_MIN_ZOOM)
  })

  it('等倍以下ではパンしない（拡大中だけドラッグで動かす）', () => {
    expect(canPan(1)).toBe(false)
    expect(canPan(0.5)).toBe(false)
    expect(canPan(1.5)).toBe(true)
  })
})
