/**
 * #9: ルート選択 → 作品 → ライトボックス → 戻る×2 で「すべて」に戻らないこと。
 *
 * ライトボックスを閉じる「戻る」のあと、ライブラリへ戻る履歴が
 * `LibrarySnapshot`（ルート・検索語・並び順）を復元する回帰テスト。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function sidebarRoot(label: string) {
  const sidebar = screen.getByLabelText('ルート一覧')
  const button = screen.getByText(label).closest('button')
  if (!button) throw new Error(`ルート ${label} のボタンが見つかりません`)
  return { sidebar, button }
}

async function openDetail() {
  await waitFor(() => expect(document.querySelector('[data-work-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  const card = document.querySelector<HTMLElement>('[data-work-id]')!
  card.focus()
  fireEvent.keyDown(card, { key: 'Enter' })
  await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
    timeout: 5000,
  })
}

async function openLightbox() {
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

async function pressEscape() {
  fireEvent.keyDown(document, { key: 'Escape' })
}

describe('#9 ライトボックスから戻ってもルートを保つ', () => {
  it('ライトボックスを閉じて戻っても、選んでいたルートが残る', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByLabelText('ルート一覧')).toBeInTheDocument())

    fireEvent.click(sidebarRoot('写真').button)
    await waitFor(() => expect(sidebarRoot('写真').button).toHaveAttribute('aria-current', 'true'))
    expect(await screen.findByText('ルート: 写真')).toBeInTheDocument()

    await openDetail()
    await openLightbox()

    // 1 回目の Esc: ライトボックスだけを閉じる
    await pressEscape()
    await waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull(), {
      timeout: 5000,
    })
    expect(document.querySelector('[data-work-detail]')).not.toBeNull()

    // 2 回目の Esc: ライブラリへ戻る（ここでスナップショットが復元される）
    await pressEscape()
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
      timeout: 5000,
    })

    expect(await screen.findByText('ルート: 写真')).toBeInTheDocument()
    expect(sidebarRoot('写真').button).toHaveAttribute('aria-current', 'true')
    expect(sidebarRoot('すべて').button).not.toHaveAttribute('aria-current')
  })

  it('検索語と並び順もライトボックス経由の戻るで保持される', async () => {
    render(<App />)
    const search = await screen.findByRole('searchbox', { name: '作品を検索' })

    // 並び順を「サイズ → 昇順」に変える（既定は降順）
    fireEvent.click(screen.getByRole('button', { name: /並び替え/ }))
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'サイズ' }))
    const dirToggle = await screen.findByRole('button', { name: '降順（クリックで昇順）' })
    fireEvent.click(dirToggle)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '昇順（クリックで降順）' })).toBeInTheDocument(),
    )

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
    await openLightbox()

    await pressEscape()
    await waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull(), {
      timeout: 5000,
    })
    await pressEscape()
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
      timeout: 5000,
    })

    expect(await screen.findByRole('searchbox', { name: '作品を検索' })).toHaveValue(
      'ベンチ作品 0001',
    )
    expect(screen.getByRole('button', { name: /並び替え（現在: サイズ）/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '昇順（クリックで降順）' })).toBeInTheDocument()
  })
})
