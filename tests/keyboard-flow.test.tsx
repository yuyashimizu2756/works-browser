/**
 * #100: 一覧 → 詳細 → 戻る をキーボードだけで完結する統合テスト。
 *
 * `?bench=24` の合成データで App を描画し、カードの Enter → 詳細の Esc、
 * 詳細の Alt+← を実際のキーイベントで確認する（headless = jsdom）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../src/App'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 300,
      })),
    getTotalSize: () => options.count * 300,
    measure: () => {},
  }),
}))

beforeAll(() => {
  window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
  // jsdom にはレイアウトが無いため、スクロール領域の幅・高さを固定する。
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return 1040
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 800
    },
  })
  // WorkGrid は ResizeObserver の初回通知で列数を決める。
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

async function firstCard() {
  await waitFor(() => expect(document.querySelector('[data-work-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-work-id]')!
}

describe('#100 一覧 → 詳細 → 戻る', () => {
  it('Enter で詳細を開き、Esc で一覧へ戻る', async () => {
    render(<App />)
    const card = await firstCard()
    card.focus()
    expect(card).toHaveFocus()

    fireEvent.keyDown(card, { key: 'Enter' })

    await waitFor(
      () => expect(document.querySelector('[data-work-detail]')).not.toBeNull(),
      { timeout: 5000 },
    )

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
      timeout: 5000,
    })
    expect(await firstCard()).toBeInTheDocument()
  })

  it('詳細では Alt+← でも一覧へ戻る', async () => {
    render(<App />)
    const card = await firstCard()
    card.focus()
    fireEvent.keyDown(card, { key: 'Enter' })

    await waitFor(
      () => expect(document.querySelector('[data-work-detail]')).not.toBeNull(),
      { timeout: 5000 },
    )

    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })

    await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
      timeout: 5000,
    })
  })
})
