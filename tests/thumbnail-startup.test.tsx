/**
 * #22: 起動時のサムネイル表示。
 *
 * - localStorage / `config.json` に表示状態が残っていても、起動は必ず非表示
 * - セッション内のトグルは従来どおり動くが、再マウント（再起動相当）で非表示へ戻る
 * - `?thumbs=visible` / デモモード / `?thumbs=hidden` は明示の例外
 */
import { fireEvent, render, waitFor } from '@testing-library/react'
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

const STORAGE_KEY = 'works-browser.library-prefs'

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

beforeEach(() => {
  window.localStorage.clear()
})

async function openAt(search: string) {
  window.history.replaceState({}, '', `/${search}`)
  const view = render(<App />)
  await waitFor(
    () => expect(document.querySelector('[data-thumb-toggle="labeled"]')).not.toBeNull(),
    { timeout: 5000 },
  )
  return {
    ...view,
    toggle: () => document.querySelector<HTMLElement>('[data-thumb-toggle="labeled"]')!,
  }
}

function storedPreferences(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
    string,
    unknown
  >
}

describe('#22 起動時のサムネイル表示', () => {
  it('保存値が true でも起動は必ず非表示', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        viewMode: 'works',
        thumbnailsVisible: true,
        shield: {},
      }),
    )

    const { toggle } = await openAt('?bench=24')

    await waitFor(() => expect(storedPreferences()).not.toHaveProperty('thumbnailsVisible'), {
      timeout: 5000,
    })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(toggle()).toHaveAccessibleName('サムネイルを表示する')
  })

  it('セッション内で ON にしても、再マウント（再起動相当）では非表示へ戻る', async () => {
    const first = await openAt('?bench=24')
    expect(first.toggle()).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(first.toggle())
    expect(first.toggle()).toHaveAttribute('aria-pressed', 'true')
    first.unmount()

    const second = await openAt('?bench=24')
    expect(second.toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(storedPreferences()).not.toHaveProperty('thumbnailsVisible')
  })

  it('?thumbs=visible / デモ / ?thumbs=hidden は明示の例外として扱う', async () => {
    const cases: { search: string; pressed: string }[] = [
      { search: '?bench=24&thumbs=visible', pressed: 'true' },
      { search: '?bench=24&demo=1', pressed: 'true' },
      { search: '?bench=24&thumbs=hidden', pressed: 'false' },
    ]

    for (const { search, pressed } of cases) {
      const view = await openAt(search)
      expect(view.toggle()).toHaveAttribute('aria-pressed', pressed)
      view.unmount()
    }
  })
})
