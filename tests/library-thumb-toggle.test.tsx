/**
 * #120: ライブラリのツールバーにもラベル付きサムネトグルを出す。
 *
 * - `aria-pressed` は「表示中か」で、作品詳細のトグルと揃える
 * - ラベル（Eye / EyeOff + 「サムネ」）とアクセシブル名が切り替わる
 * - ヘッダーの目アイコン / 作品詳細と状態を共有する
 * - 作品 / ファイル / タイムラインの全モードに同じトグルがある
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  // `loadPreferences()` は非同期に localStorage / config を読み直す。保存が済む前に
  // 操作すると表示モードが巻き戻るため、各テストは保存完了を待ってから触る。
  window.localStorage.clear()
})

function toolbarToggle(container: HTMLElement = document.body) {
  const toggle = container.querySelector<HTMLElement>('[data-thumb-toggle="labeled"]')
  if (!toggle) throw new Error('サムネトグルが見つかりません')
  return toggle
}

/** App の設定読み込み → 保存（localStorage への写し）が終わるまで待つ。 */
async function preferencesSettled() {
  await waitFor(
    () => expect(window.localStorage.getItem('works-browser.library-prefs')).not.toBeNull(),
    { timeout: 5000 },
  )
}

async function firstCard() {
  await waitFor(() => expect(document.querySelector('[data-work-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-work-id]')!
}

describe('#120 ライブラリのサムネトグル', () => {
  it('aria-pressed とラベルが切り替わり、ヘッダー・詳細と状態を共有する', async () => {
    render(<App />)
    await preferencesSettled()
    const toggle = toolbarToggle()
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAccessibleName('サムネイルを表示する')
    expect(toggle).toHaveTextContent('サムネ')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAccessibleName('サムネイルを非表示にする')

    // ヘッダーの目アイコンも同じ状態（残したまま）
    const header = document.querySelector('header')!
    expect(
      within(header).getByRole('button', { name: 'サムネイルを非表示にする' }),
    ).toHaveAttribute('aria-pressed', 'true')

    // 詳細の「サムネ」トグルも表示中で開く
    const card = await firstCard()
    card.focus()
    fireEvent.keyDown(card, { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
      timeout: 5000,
    })
    const detailToggle = document.querySelector<HTMLElement>('[data-work-thumb-toggle]')!
    expect(detailToggle).toHaveAttribute('aria-pressed', 'true')

    // 詳細で消して戻ると、ライブラリのトグルも消えている
    fireEvent.click(detailToggle)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-work-detail]')).toBeNull(), {
      timeout: 5000,
    })
    expect(toolbarToggle()).toHaveAttribute('aria-pressed', 'false')
  })

  it('ファイル / タイムラインのツールバーにも同じトグルが出る', async () => {
    render(<App />)
    await preferencesSettled()
    const worksToolbar = screen.getByLabelText('ライブラリのツールバー')
    expect(toolbarToggle(worksToolbar)).toBeInTheDocument()

    const modeGroup = screen.getByRole('group', { name: '表示モード' })
    fireEvent.click(within(modeGroup).getByRole('button', { name: 'ファイル' }))
    const filesToolbar = await screen.findByLabelText('ファイルのツールバー', undefined, {
      timeout: 5000,
    })
    expect(toolbarToggle(filesToolbar)).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toolbarToggle(filesToolbar))
    expect(toolbarToggle(filesToolbar)).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(
      within(screen.getByRole('group', { name: '表示モード' })).getByRole('button', {
        name: 'タイムライン',
      }),
    )
    const timelineToolbar = await screen.findByLabelText('タイムラインのツールバー', undefined, {
      timeout: 5000,
    })
    expect(toolbarToggle(timelineToolbar)).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toolbarToggle(timelineToolbar))
    expect(toolbarToggle(timelineToolbar)).toHaveAttribute('aria-pressed', 'false')
  }, 15000)
})
