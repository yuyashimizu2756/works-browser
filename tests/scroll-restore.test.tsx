/**
 * #90: `useScrollRestore`（#81）のテスト。
 *
 * モードを切り替えて戻ったとき、覚えておいた `scrollTop` へ戻す。ただし
 * ユーザーがホイール・タッチ・ポインタ・キーで操作したら復元を止める
 * （勝手にスクロールを奪わない）。ページが届いて高さが伸びる間は再試行する。
 */
import { act, fireEvent, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useScrollRestore } from '../src/library/useScrollRestore'

function setup(target?: number) {
  const node = document.createElement('div')
  const ref = createRef<HTMLDivElement>()
  ref.current = node

  const frames: FrameRequestCallback[] = []
  const raf = vi
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })

  const view = renderHook(() => useScrollRestore(ref, target))
  return {
    node,
    frames,
    raf,
    ...view,
    /** 予約されたフレームを 1 つ実行する（再予約された分は次回に残る）。 */
    runFrame(time = 0) {
      const callback = frames.shift()
      if (!callback) throw new Error('フレームが予約されていない')
      act(() => callback(time))
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useScrollRestore', () => {
  it('マウント後に覚えていた位置へ戻す', () => {
    const { node, frames, raf, runFrame } = setup(480)

    expect(raf).toHaveBeenCalledTimes(1)
    expect(frames).toHaveLength(1)
    expect(node.scrollTop).toBe(0)

    runFrame()

    expect(node.scrollTop).toBe(480)
    // 目標に届いたら再予約しない
    expect(frames).toHaveLength(0)
  })

  it('高さが足りない間は次フレームで再試行し、伸びたら止める', () => {
    const { node, frames, runFrame } = setup(480)

    // jsdom にはレイアウトが無いので、ページ到着前の丸めを手動で再現する。
    let applied = 0
    let limit = 120
    Object.defineProperty(node, 'scrollTop', {
      configurable: true,
      get: () => Math.min(applied, limit),
      set: (value: number) => {
        applied = value
      },
    })

    runFrame()
    expect(node.scrollTop).toBe(120)
    expect(frames).toHaveLength(1)

    limit = 480
    runFrame(16)
    expect(node.scrollTop).toBe(480)
    expect(frames).toHaveLength(0)
  })

  it('ホイール操作で復元を中断する', () => {
    const { node, frames, runFrame } = setup(480)

    fireEvent.wheel(node)
    expect(frames).toHaveLength(1)

    runFrame()

    expect(node.scrollTop).toBe(0)
    expect(frames).toHaveLength(0)
  })

  it.each(['touchstart', 'pointerdown', 'keydown'] as const)(
    '%s 操作でも復元を中断する',
    (type) => {
      const { node, frames, runFrame } = setup(480)

      act(() => {
        node.dispatchEvent(
          type === 'keydown'
            ? new KeyboardEvent('keydown', { key: 'ArrowDown' })
            : new Event(type),
        )
      })
      expect(frames).toHaveLength(1)

      runFrame()

      expect(node.scrollTop).toBe(0)
      expect(frames).toHaveLength(0)
    },
  )

  it('復元位置が無い / 0 のときは何もしない', () => {
    const none = setup(undefined)
    expect(none.raf).not.toHaveBeenCalled()
    expect(none.node.scrollTop).toBe(0)

    const zero = setup(0)
    expect(zero.raf).not.toHaveBeenCalled()
    expect(zero.node.scrollTop).toBe(0)
  })
})
