/**
 * #100: キーボードだけで「一覧 → 詳細 → 戻る」を完結できることの回帰テスト。
 *
 * - 一覧: カードにフォーカスして Enter で開く（WorkCard）
 * - 詳細: Esc で閉じる（useListShortcuts の close。WorkDetail は onClose=onBack）
 * - 共通: Alt+← で戻る（useMouseNavButtons）
 */
import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkCard } from '../src/library/WorkCard'
import { useListShortcuts } from '../src/library/useListShortcuts'
import { useMouseNavButtons } from '../src/lib/useMouseNavButtons'
import { makeWork } from './fixtures'

function dispatchKey(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  window.dispatchEvent(event)
  return event
}

describe('#100 キーボード操作', () => {
  it('一覧: カードの Enter で詳細を開く', () => {
    const onOpen = vi.fn()
    render(
      <WorkCard
        work={makeWork({ id: 1, title: '開く作品' })}
        rootLabel="ルート A"
        accent="#7c6cff"
        selected={false}
        thumbnailVisible={false}
        bench={false}
        onToggle={() => undefined}
        onOpen={onOpen}
      />,
    )

    const card = screen.getByRole('option')
    card.focus()
    expect(card).toHaveFocus()
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('詳細: Esc で戻る（WorkDetail は onClose に onBack を渡す）', () => {
    const onBack = vi.fn()
    renderHook(() => useListShortcuts({ onClose: onBack }))

    const event = dispatchKey({ key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('共通: Alt+← で戻る（Alt+→ で進む）', () => {
    const onBack = vi.fn()
    const onForward = vi.fn()
    renderHook(() => useMouseNavButtons({ onBack, onForward }))

    dispatchKey({ key: 'ArrowLeft', altKey: true })
    expect(onBack).toHaveBeenCalledTimes(1)

    dispatchKey({ key: 'ArrowRight', altKey: true })
    expect(onForward).toHaveBeenCalledTimes(1)
  })

  it('入力欄では Esc / Alt+← を奪わない', () => {
    const onBack = vi.fn()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    renderHook(() => useListShortcuts({ onClose: onBack }))

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onBack).not.toHaveBeenCalled()
    input.remove()
  })
})
