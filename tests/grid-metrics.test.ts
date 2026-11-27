import { describe, expect, it } from 'vitest'
import {
  CARD_META_HEIGHT,
  GRID_GAP,
  GRID_PADDING,
  gridColumnsFor,
  gridMetricsFor,
  skeletonMetricsFor,
} from '../src/library/gridMetrics'

describe('gridMetricsFor', () => {
  it('1280×800（サイドバー 240px を引いた 1040px）で 4 列', () => {
    const metrics = gridMetricsFor(1040)
    expect(metrics.columns).toBe(4)
    expect(metrics.cardWidth).toBeCloseTo((1040 - GRID_PADDING * 2 - GRID_GAP * 3) / 4)
  })

  it('1920×1080（同 1680px）で 6 列', () => {
    expect(gridMetricsFor(1680).columns).toBe(6)
  })

  it('外側余白 24 / 間隔 16 を使う', () => {
    expect(GRID_PADDING).toBe(24)
    expect(GRID_GAP).toBe(16)
  })

  it('カバーは 4:3、カード高さはカバー + メタ 66px', () => {
    const metrics = gridMetricsFor(1040)
    expect(metrics.coverHeight).toBe(Math.round((metrics.cardWidth * 3) / 4))
    expect(metrics.cardHeight).toBe(metrics.coverHeight + CARD_META_HEIGHT)
    // 幅 236px 前後なら 4:3 のカバーは 177px
    expect(metrics.coverHeight).toBeGreaterThanOrEqual(170)
    expect(metrics.coverHeight).toBeLessThanOrEqual(180)
  })

  it('3〜6 列に収める', () => {
    expect(gridColumnsFor(200)).toBe(3)
    expect(gridColumnsFor(700)).toBe(3)
    expect(gridColumnsFor(927)).toBe(3) // 927 - 48 = 879 < 880
    expect(gridColumnsFor(928)).toBe(4) // 880
    expect(gridColumnsFor(1288)).toBe(5) // 1240
    expect(gridColumnsFor(1608)).toBe(6) // 1560
    expect(gridColumnsFor(4000)).toBe(6)
  })

  it('測定前（幅 0）でも破綻せず 3 列を返す', () => {
    const metrics = gridMetricsFor(0)
    expect(metrics.columns).toBe(3)
    expect(metrics.cardWidth).toBe(0)
    expect(metrics.cardHeight).toBe(CARD_META_HEIGHT)
  })
})

describe('skeletonMetricsFor（#100）', () => {
  it('スケルトンは常に 3 列で、カバーは 4:3', () => {
    for (const width of [1040, 1680]) {
      const metrics = skeletonMetricsFor(width)
      expect(metrics.columns).toBe(3)
      expect(metrics.coverHeight).toBe(Math.round((metrics.cardWidth * 3) / 4))
      expect(metrics.cardHeight).toBe(metrics.coverHeight + CARD_META_HEIGHT)
    }
  })

  it('幅 0 でも破綻しない', () => {
    const metrics = skeletonMetricsFor(0)
    expect(metrics.columns).toBe(3)
    expect(metrics.cardWidth).toBe(0)
    expect(metrics.cardHeight).toBe(CARD_META_HEIGHT)
  })
})
