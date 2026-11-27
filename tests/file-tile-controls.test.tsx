/**
 * #112: ファイルカード右上の「目アイコン（個別表示）」と「選択チェック」が
 * 同じ座標に重ならないこと。
 *
 * `?bench=24&thumbs=hidden&mode=files` で App を描画し、右上クラスタの
 * 2 つの当たり判定が別々に押せることを確認する（headless = jsdom）。
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
  window.history.replaceState({}, '', '/?bench=24&thumbs=hidden&mode=files')
  // jsdom にはレイアウトが無いため、スクロール領域の幅・高さを固定する
  // （1280 幅相当 = 4 列）。
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

async function firstCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-file-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-file-id]')!
}

describe('#112 カード右上の目アイコンと選択チェック', () => {
  it('目アイコンは右上 38px、チェックは右端 6px に分かれて置かれる', async () => {
    render(<App />)
    const card = await firstCard()

    const reveal = card.querySelector<HTMLElement>('[data-file-reveal]')
    const checkboxWrapper = card.querySelector<HTMLElement>('[data-file-checkbox-wrapper]')
    expect(reveal).not.toBeNull()
    expect(checkboxWrapper).not.toBeNull()

    // 右上はチェックボックス専用（右端 6px / 24×24）
    expect(checkboxWrapper).toHaveClass('top-1.5')
    expect(checkboxWrapper).toHaveClass('right-1.5')
    expect(checkboxWrapper).toHaveClass('size-6')
    expect(checkboxWrapper).toHaveClass('z-10')

    // 目アイコンはその左隣（右端から 38px = 6 + 24 + 8）で、同じ 24×24
    expect(reveal).toHaveClass('top-1.5')
    expect(reveal).toHaveClass('right-[38px]')
    expect(reveal).toHaveClass('size-6')
    expect(reveal).toHaveClass('z-10')

    // 座標が同じでない（重なりの再発防止）
    expect(reveal?.className).not.toBe(checkboxWrapper?.className)
  })

  it('目アイコンのクリックは個別表示だけを切り替え、選択はしない', async () => {
    render(<App />)
    const card = await firstCard()
    const reveal = card.querySelector<HTMLElement>('[data-file-reveal]')!

    expect(reveal).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(reveal)
    expect(reveal).toHaveAttribute('aria-pressed', 'true')
    expect(card).not.toHaveAttribute('data-selected')
    // カード本体の「開く」へ伝播していない（詳細画面に遷移しない）
    expect(document.querySelector('[data-work-detail]')).toBeNull()
  })

  it('チェックボックスのクリックは選択だけを切り替え、個別表示は変えない', async () => {
    render(<App />)
    const card = await firstCard()
    const reveal = card.querySelector<HTMLElement>('[data-file-reveal]')!
    const checkbox = screen.getAllByRole('checkbox')[0]!

    fireEvent.click(checkbox)
    expect(card).toHaveAttribute('data-selected', 'true')
    expect(reveal).toHaveAttribute('aria-pressed', 'false')
    expect(document.querySelector('[data-work-detail]')).toBeNull()
  })
})
