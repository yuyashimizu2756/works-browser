/**
 * #5: ライトボックス（作品詳細のプレビュー）表示中でも `?` で
 * ショートカット一覧を開き、`Esc` を 1 段ずつ閉じる。
 *
 * 優先順位は「ヘルプ → ライトボックス → 作品詳細」。
 * ヘルプを閉じたあとに元の画面の選択・スクロールが壊れないことも確認する。
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const HELP_EVENT = { key: '?', code: 'Slash', shiftKey: true } as const

beforeEach(() => {
  window.localStorage.clear()
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

async function firstWorkCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-work-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-work-id]')!
}

function helpDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-shortcuts-dialog]')
}

async function openLightboxFromLibrary() {
  render(<App />)
  const card = await firstWorkCard()
  card.focus()
  fireEvent.keyDown(card, { key: 'Enter' })
  await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
    timeout: 5000,
  })

  await waitFor(() => expect(document.querySelector('[data-file-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  const tile = document.querySelector<HTMLElement>('[data-file-id]')!
  tile.focus()
  fireEvent.keyDown(tile, { key: 'Enter' })
  await waitFor(() => expect(document.querySelector('[data-lightbox]')).not.toBeNull(), {
    timeout: 5000,
  })
}

describe('#5 ライトボックス中の ? ヘルプ', () => {
  it('? で最前面に開き、Esc はヘルプ → ライトボックス → 詳細の順に閉じる', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    await openLightboxFromLibrary()

    fireEvent.keyDown(window, HELP_EVENT)

    await waitFor(() => expect(helpDialog()).not.toBeNull(), { timeout: 5000 })
    const dialog = helpDialog()!
    // ライトボックス（z-80）より上に出す
    expect(dialog.className).toContain('z-[121]')
    expect(document.body.textContent).toContain('キーボードショートカット')
    expect(document.querySelector('[data-lightbox]')).not.toBeNull()

    // 1 回目の Esc: ヘルプだけを閉じる
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(helpDialog()).toBeNull(), { timeout: 5000 })
    expect(document.querySelector('[data-lightbox]')).not.toBeNull()
    expect(document.querySelector('[data-work-detail]')).not.toBeNull()

    // 2 回目の Esc: ライトボックスを閉じる（詳細は残る）
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull(), {
      timeout: 5000,
    })
    expect(document.querySelector('[data-work-detail]')).not.toBeNull()

    // 3 回目の Esc: 詳細を閉じて一覧へ戻る
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
      timeout: 5000,
    })
    expect(await firstWorkCard()).toBeInTheDocument()
  })

  it('ヘルプを閉じても一覧の選択とスクロールは元のまま', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    const card = await firstWorkCard()

    const checkbox = within(card).getAllByRole('checkbox')[0]!
    fireEvent.click(checkbox)
    expect(card).toHaveAttribute('data-selected', 'true')

    const scroll = document.querySelector<HTMLElement>('[data-scroll-region]')!
    scroll.scrollTop = 240

    fireEvent.keyDown(window, HELP_EVENT)
    await waitFor(() => expect(helpDialog()).not.toBeNull(), { timeout: 5000 })

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(helpDialog()).toBeNull(), { timeout: 5000 })

    expect(await firstWorkCard()).toHaveAttribute('data-selected', 'true')
    expect(scroll.scrollTop).toBe(240)
    expect(document.querySelector('[data-work-detail]')).toBeNull()
  })
})
