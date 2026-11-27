/**
 * #30: 開いて一覧へ戻ったときに、開いたファイルのサムネイルが表示されたままにならない。
 *
 * - カードを開くことによる自動の個別表示（`reveal`）はしない
 * - 手動の目アイコン（#52）は従来どおりトグルできる
 */
import { fireEvent, render, waitFor } from '@testing-library/react'
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

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState({}, '', '/?bench=24&thumbs=hidden&mode=files')
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

async function firstFileCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-file-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-file-id]')!
}

/** 詳細 →（ライトボックスが開いていれば閉じて）一覧へ戻る。 */
async function backToLibrary() {
  if (document.querySelector('[data-lightbox]')) {
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull(), {
      timeout: 5000,
    })
  }
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
    timeout: 5000,
  })
}

describe('#30 開いて戻ってもサムネイルは自動表示しない', () => {
  it('ファイルを開いて一覧へ戻ると、そのファイルの個別表示は解除されたまま', async () => {
    render(<App />)
    const card = await firstFileCard()
    const fileId = card.dataset.fileId
    const reveal = card.querySelector<HTMLElement>('[data-file-reveal]')!
    expect(reveal).toHaveAttribute('aria-pressed', 'false')

    // カード本体をクリックして開く（目アイコンは押さない）
    fireEvent.click(card)
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
      timeout: 5000,
    })

    await backToLibrary()

    const backCard = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(`[data-file-id="${fileId}"]`)
      expect(element).not.toBeNull()
      return element!
    })
    expect(backCard.querySelector<HTMLElement>('[data-file-reveal]')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('手動の目アイコンは開いて戻っても維持される（従来どおり）', async () => {
    render(<App />)
    const card = await firstFileCard()
    const fileId = card.dataset.fileId
    const reveal = card.querySelector<HTMLElement>('[data-file-reveal]')!

    fireEvent.click(reveal)
    expect(reveal).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(card)
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
      timeout: 5000,
    })
    await backToLibrary()

    const backCard = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(`[data-file-id="${fileId}"]`)
      expect(element).not.toBeNull()
      return element!
    })
    expect(backCard.querySelector<HTMLElement>('[data-file-reveal]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
