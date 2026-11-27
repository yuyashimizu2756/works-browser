import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ToastMessage,
  ToastStack,
  clearToasts,
  pushToast,
  removeToast,
} from '@/components/ToastStack'
import { UndoToast } from '@/library/DeleteFlow'
import { MoveUndoToast } from '@/library/MoveFlow'

/** #115: 4 つのトーストが 1 つのスタックに積まれることの確認。 */

afterEach(() => {
  clearToasts()
  vi.useRealTimers()
})

function show(message: string, options: { key?: string; duration?: number; onEvict?: () => void } = {}) {
  return pushToast({
    key: options.key ?? message,
    content: <ToastMessage message={message} />,
    duration: options.duration,
    onEvict: options.onEvict,
  })
}

function toastItems() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-toast-item]'))
}

describe('#115 ToastStack', () => {
  it('画面下中央に固定し、8px 間隔で縦に積む', () => {
    render(<ToastStack />)
    act(() => {
      show('1 件目')
      show('2 件目')
    })

    const stack = document.querySelector<HTMLElement>('[data-toast-stack]')
    expect(stack).not.toBeNull()
    expect(stack!.className).toContain('fixed')
    expect(stack!.className).toContain('bottom-5')
    expect(stack!.className).toContain('items-center')
    expect(stack!.style.gap).toBe('8px')

    const items = toastItems()
    expect(items).toHaveLength(2)
    // 新しいものが下（配列の末尾）
    expect(items.map((item) => item.textContent)).toEqual(['1 件目', '2 件目'])
  })

  it('最大 3 件。4 件目で一番古いものが押し出される', () => {
    render(<ToastStack />)
    const evicted = vi.fn()
    act(() => {
      show('A', { onEvict: evicted })
      show('B')
      show('C')
      show('D')
    })

    expect(toastItems().map((item) => item.textContent)).toEqual(['B', 'C', 'D'])
    expect(evicted).toHaveBeenCalledTimes(1)
  })

  it('同じ key の通知は増やさずに文言を置き換える', () => {
    render(<ToastStack />)
    act(() => {
      show('最初の通知', { key: 'notice' })
      show('次の通知', { key: 'notice' })
    })

    expect(toastItems()).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('次の通知')
  })

  it('自動消滅と手動削除', () => {
    vi.useFakeTimers()
    render(<ToastStack />)

    act(() => {
      show('すぐ消える', { duration: 2800 })
    })
    expect(toastItems()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(2799)
    })
    expect(toastItems()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(toastItems()).toHaveLength(0)

    let id = 0
    act(() => {
      id = show('手動で消す')
    })
    act(() => {
      removeToast(id)
    })
    expect(toastItems()).toHaveLength(0)
  })

  it('削除と移動の Undo を同時に出しても 1 つの列に並ぶ', () => {
    render(<ToastStack />)
    act(() => {
      pushToast({
        key: 'delete-undo',
        content: (
          <UndoToast
            undoId="delete-undo"
            count={3}
            busy={false}
            onUndo={() => {}}
            onExpire={() => {}}
          />
        ),
        width: 'min(92vw,420px)',
      })
      pushToast({
        key: 'move-undo',
        content: (
          <MoveUndoToast
            moveId="move-undo"
            title="サンプル作品 3"
            targetLabel="写真"
            busy={false}
            onUndo={() => {}}
            onExpire={() => {}}
          />
        ),
        width: 'min(92vw,460px)',
      })
    })

    const items = toastItems()
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('3 件をゴミ箱へ移動しました')
    expect(items[1]).toHaveTextContent('「サンプル作品 3」を「写真」へ移動しました')
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })

  it('role="status" と 160ms のアニメーションを維持する', () => {    render(<ToastStack />)
    act(() => {
      show('通知')
    })

    const item = screen.getByRole('status')
    expect(item).toHaveTextContent('通知')
    expect(item.className).toContain(
      'animate-[toast-in_var(--duration-fast)_var(--ease-standard)]',
    )
  })
})
