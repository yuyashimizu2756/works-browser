import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CompareView } from '../src/library/CompareView'
import type { CompareItem } from '../src/library/compareItems'

function item(index: number, kind: 'image' | 'video' = 'image'): CompareItem {
  return {
    key: `file-${index}`,
    title: `サンプル ${index}`,
    subtitle: '作品 1',
    kind,
    fileId: null,
    // 実メディアが無いベンチ相当。data URL なら jsdom でも <img src> を作れる
    thumbPath: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>`,
    )}`,
  }
}

describe('CompareView', () => {
  it('3 枚を 1 + 2 のグリッドで描き、左のセルが縦 2 行を占める', () => {
    render(<CompareView items={[item(1), item(2), item(3)]} bench onClose={() => {}} />)

    const cells = document.querySelectorAll('[data-compare-cell]')
    expect(cells).toHaveLength(3)
    expect((cells[0] as HTMLElement).style.gridRow).toBe('1 / span 2')
    expect((cells[1] as HTMLElement).style.gridColumn).toBe('2')
    expect(screen.getByText('3 枚')).toBeInTheDocument()
  })

  it('4 枚は 2×2 で描く', () => {
    render(
      <CompareView items={[item(1), item(2), item(3), item(4)]} bench onClose={() => {}} />,
    )
    expect(document.querySelectorAll('[data-compare-cell]')).toHaveLength(4)
  })

  it('ホイールズームが全セルに同じ transform として同期する', () => {
    render(<CompareView items={[item(1), item(2), item(3)]} bench onClose={() => {}} />)

    const stage = document.querySelector('[data-compare-stage]') as HTMLElement
    expect(stage).toBeTruthy()
    fireEvent.wheel(stage, { deltaY: -240 })

    const view = document.querySelector('[data-compare-view]') as HTMLElement
    expect(Number(view.dataset.compareZoom)).toBeGreaterThan(1)

    const transforms = Array.from(document.querySelectorAll<HTMLElement>('[data-compare-media]'))
      .map((node) => node.style.transform)
    expect(transforms).toHaveLength(3)
    expect(new Set(transforms).size).toBe(1)
    expect(transforms[0]).toContain('scale(')
  })

  it('Esc で閉じる', () => {
    const onClose = vi.fn()
    render(<CompareView items={[item(1), item(2)]} bench onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('シールド中は中身を描画しない（画像 0 件）', () => {
    render(<CompareView items={[item(1), item(2)]} bench shielded onClose={() => {}} />)
    expect(document.querySelector('[data-compare-view]')).toBeNull()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })
})
