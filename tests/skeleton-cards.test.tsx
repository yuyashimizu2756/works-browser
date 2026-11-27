/**
 * #100: 読み込み中のスケルトン。
 *
 * - カード形状（4:3 のカバー + 2 行のメタ）を 3 列 × 2 行で保つ
 * - 200ms 未満の読み込みでは出さない（ちらつき防止）
 */
import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkeletonCards } from '../src/library/SkeletonCards'
import { CARD_META_HEIGHT, skeletonMetricsFor } from '../src/library/gridMetrics'
import { useDelayedVisible } from '../src/lib/useDelayedVisible'

describe('skeletonMetricsFor', () => {
  it('読み込み中は幅に関係なく 3 列で計算する', () => {
    expect(skeletonMetricsFor(1040).columns).toBe(3)
    expect(skeletonMetricsFor(1920).columns).toBe(3)
  })

  it('カバーは 4:3、カード高さはカバー + メタ 66px', () => {
    const metrics = skeletonMetricsFor(1040)
    expect(metrics.coverHeight).toBe(Math.round((metrics.cardWidth * 3) / 4))
    expect(metrics.cardHeight).toBe(metrics.coverHeight + CARD_META_HEIGHT)
  })
})

describe('SkeletonCards', () => {
  it('3 列 × 2 行（6 枚）で、各カードにカバー + 2 行のメタを置く', () => {
    const metrics = skeletonMetricsFor(1040)
    render(<SkeletonCards coverHeight={metrics.coverHeight} cardHeight={metrics.cardHeight} />)

    const grid = document.querySelector<HTMLElement>('[data-skeleton-grid]')
    expect(grid).not.toBeNull()
    expect(grid?.style.gridTemplateColumns).toBe('repeat(3, minmax(0px, 1fr))')

    const cards = document.querySelectorAll('[data-skeleton-card]')
    expect(cards).toHaveLength(6)
    for (const card of cards) {
      // カバー 1 + メタ 2 行
      expect(card.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
      expect((card as HTMLElement).style.height).toBe(`${metrics.cardHeight}px`)
    }
  })
})

describe('useDelayedVisible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('200ms 経つまで false、経過後に true', () => {
    const { result } = renderHook(() => useDelayedVisible(true, 200))
    expect(result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(result.current).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe(true)
  })

  it('200ms 未満で読み込みが終わったら一度も出さない', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useDelayedVisible(active, 200),
      { initialProps: { active: true } },
    )

    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(result.current).toBe(false)

    rerender({ active: false })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(false)
  })

  it('表示中に読み込みが終わったら即座に false', () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useDelayedVisible(active, 200),
      { initialProps: { active: true } },
    )
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current).toBe(true)

    rerender({ active: false })
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(result.current).toBe(false)
  })
})
