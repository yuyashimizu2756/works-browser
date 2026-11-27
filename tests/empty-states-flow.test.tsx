/**
 * #100: 空状態 4 種を、実際の App（ベンチモード）で確認する。
 *
 * - `?empty=roots` … サイドバーにルートが無い
 * - `?empty=smart` … ルートはあるがスマートフォルダが無い
 * - `?empty=search` … 検索 0 件（条件をクリアで戻る）
 * - `?empty=thumbs&thumbs=shown` … サムネイル未生成
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

function openAt(search: string) {
  window.history.replaceState({}, '', search)
  return render(<App />)
}

describe('#100 空状態 4 種（App）', () => {
  it('ルートが無い', async () => {
    openAt('/?bench=24&empty=roots&thumbs=hidden')
    expect(await screen.findByText('ルートを追加して始める')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ルートを追加' })).toBeInTheDocument()
    // #108: ルートが無いときはスマートフォルダの節ごと出さない。
    expect(screen.queryByText('スマートフォルダはまだありません')).toBeNull()
    expect(screen.queryByText('スマートフォルダ')).toBeNull()
  })

  it('スマートフォルダが無い（ルートは並ぶ）', async () => {
    openAt('/?bench=24&empty=smart&thumbs=hidden')
    expect(await screen.findByText('スマートフォルダはまだありません')).toBeInTheDocument()
    expect(screen.queryByText('ルートを追加して始める')).toBeNull()
    expect(screen.getByText('写真')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '条件を絞り込む' })).toBeInTheDocument()
  })

  it('検索 0 件は「条件をクリア」で戻る', async () => {
    openAt('/?bench=24&empty=search&thumbs=hidden')
    expect(await screen.findByText('条件に一致する作品がありません')).toBeInTheDocument()

    const clear = screen.getByRole('button', { name: '条件をクリア' })
    fireEvent.click(clear)

    await waitFor(() => expect(document.querySelector('[data-work-id]')).not.toBeNull(), {
      timeout: 5000,
    })
    expect(screen.queryByText('条件に一致する作品がありません')).toBeNull()
  })

  it('サムネイル未生成は説明と「サムネイルを生成」を出す', async () => {
    openAt('/?bench=24&empty=thumbs&thumbs=shown')
    const notice = await waitFor(() => {
      const element = document.querySelector('[data-thumbnails-pending]')
      expect(element).not.toBeNull()
      return element as HTMLElement
    })

    expect(notice).toHaveTextContent('サムネイルはまだ生成されていません')
    expect(notice).toHaveTextContent('サムネイルを生成')
  })
})
