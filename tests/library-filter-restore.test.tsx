/**
 * #120: 作品詳細から戻ったときにライブラリの絞り込みが復元されること。
 *
 * ベンチの合成データで App を描画し、実際にサイドバーでルートを選ぶ / 検索語を
 * 入れる → カードから詳細へ → Esc で戻る、を通す。画面ローカルの `useState` が
 * 初期化されても、履歴（`LibrarySnapshot.filters`）から初期値が戻る。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  window.history.replaceState({}, '', '/?bench=24&empty=thumbs&thumbs=hidden')
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

async function openDetail() {
  const card = await firstCard()
  card.focus()
  fireEvent.keyDown(card, { key: 'Enter' })
  await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
    timeout: 5000,
  })
}

async function backToLibrary() {
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
    timeout: 5000,
  })
}

function sidebarRoot(label: string) {
  const sidebar = screen.getByLabelText('ルート一覧')
  const text = within(sidebar).getByText(label)
  const button = text.closest('button')
  if (!button) throw new Error(`ルート ${label} のボタンが見つかりません`)
  return button
}

describe('#120 詳細から戻ったときの絞り込み復元', () => {
  it('選んでいたルートが「すべて」に戻らず、チップとサイドバーに残る', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText('ルート一覧')).toBeInTheDocument())

    fireEvent.click(sidebarRoot('写真'))
    await waitFor(() => expect(sidebarRoot('写真')).toHaveAttribute('aria-current', 'true'))
    expect(await screen.findByText('ルート: 写真')).toBeInTheDocument()

    await openDetail()
    await backToLibrary()

    // 再マウント後もルートが「すべて」へ戻っていない
    expect(await screen.findByText('ルート: 写真')).toBeInTheDocument()
    expect(sidebarRoot('写真')).toHaveAttribute('aria-current', 'true')
    expect(sidebarRoot('すべて')).not.toHaveAttribute('aria-current')
  })

  it('検索語も復元され、空に戻したあとは古い語が復活しない', async () => {
    render(<App />)
    const search = await screen.findByRole('searchbox', { name: '作品を検索' })

    fireEvent.change(search, { target: { value: 'ベンチ作品 0001' } })
    await waitFor(
      () => {
        const cards = document.querySelectorAll('[data-work-id]')
        expect(cards.length).toBeGreaterThan(0)
        expect(cards.length).toBeLessThan(24)
      },
      { timeout: 5000 },
    )

    await openDetail()
    await backToLibrary()

    const restored = await screen.findByRole('searchbox', { name: '作品を検索' })
    expect(restored).toHaveValue('ベンチ作品 0001')

    fireEvent.change(restored, { target: { value: '' } })
    await waitFor(
      () => expect(document.querySelectorAll('[data-work-id]').length).toBeGreaterThan(1),
      { timeout: 5000 },
    )

    await openDetail()
    await backToLibrary()

    // 「空検索」で離れたのだから、以前の検索語は戻らない
    expect(await screen.findByRole('searchbox', { name: '作品を検索' })).toHaveValue('')
  })
})
