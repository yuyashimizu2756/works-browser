/**
 * #121: 全体がサムネ非表示のとき、作品カード右上の目アイコンで
 * 「この作品のサムネイルだけ」一時表示する。
 *
 * - 目アイコンはチェックボックスの左隣（8px 間隔）にだけ出る
 * - 全体表示中は出ない
 * - 全体トグルを切り替えると個別状態はリセットされる（非永続）
 * - タイムラインも同じ WorkCard なので同じ挙動になる
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

async function firstCard() {
  await waitFor(() => expect(document.querySelector('[data-work-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-work-id]')!
}

function headerThumbToggle() {
  const toggle = document.querySelector<HTMLElement>(
    'header [data-thumb-toggle="compact"]',
  )
  if (!toggle) throw new Error('ヘッダーのサムネトグルが見つかりません')
  return toggle
}

describe('#121 作品カードの個別サムネ表示', () => {
  it('全体非表示のときだけ、チェックボックスの左隣に目アイコンが出る', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    const card = await firstCard()

    const reveal = card.querySelector<HTMLElement>('[data-work-reveal]')
    const checkbox = card.querySelector<HTMLElement>('[data-work-checkbox-wrapper]')
    expect(reveal).not.toBeNull()
    expect(checkbox).not.toBeNull()
    expect(reveal).toHaveClass('top-1.5')
    expect(reveal).toHaveClass('right-[38px]')
    expect(reveal).toHaveClass('size-6')
    expect(checkbox).toHaveClass('right-1.5')
  })

  it('全体表示中は個別の目アイコンを出さない', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=shown')
    render(<App />)
    const card = await firstCard()
    expect(card.querySelector('[data-work-reveal]')).toBeNull()
  })

  it('押すとその作品だけ表示し、再押下で戻る（選択・詳細遷移はしない）', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    const card = await firstCard()
    const reveal = card.querySelector<HTMLElement>('[data-work-reveal]')!

    expect(reveal).toHaveAttribute('aria-pressed', 'false')
    expect(reveal).toHaveAccessibleName('この作品のサムネイルを表示')

    fireEvent.click(reveal)
    expect(reveal).toHaveAttribute('aria-pressed', 'true')
    expect(reveal).toHaveAccessibleName('この作品のサムネイルを隠す')
    expect(card).not.toHaveAttribute('data-selected')
    expect(document.querySelector('[data-work-detail]')).toBeNull()

    fireEvent.click(reveal)
    expect(reveal).toHaveAttribute('aria-pressed', 'false')
  })

  it('全体トグルを切り替えると作品の個別表示もリセットされる', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    let card = await firstCard()
    fireEvent.click(card.querySelector<HTMLElement>('[data-work-reveal]')!)

    // 全体表示へ → 個別ボタンは消える
    fireEvent.click(headerThumbToggle())
    card = await firstCard()
    expect(card.querySelector('[data-work-reveal]')).toBeNull()

    // 全体非表示へ戻す → 個別状態は空から（古い表示が復活しない）
    fireEvent.click(headerThumbToggle())
    card = await firstCard()
    expect(card.querySelector('[data-work-reveal]')).toHaveAttribute('aria-pressed', 'false')
  })

  it('タイムラインのカードでも同じ個別表示ができる', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden&mode=timeline')
    render(<App />)
    await waitFor(() => expect(document.querySelector('[data-timeline]')).not.toBeNull(), {
      timeout: 5000,
    })
    const card = await firstCard()
    const reveal = card.querySelector<HTMLElement>('[data-work-reveal]')!
    expect(reveal).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(reveal)
    expect(reveal).toHaveAttribute('aria-pressed', 'true')
  })
})
