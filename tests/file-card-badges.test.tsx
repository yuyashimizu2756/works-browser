/**
 * #114: ファイルモードのバッジ配置。
 *
 * - 左上: 作品名 / 右上: 目 + チェック / 左下: 再生位置 / 右下: 長さ
 * - meta は右下の長さバッジの上（`bottom-8 right-1.5`）
 * - 作品詳細（作品名なし）は meta を左上のままにする
 *
 * `?bench=24&mode=files&thumbs=hidden` で App を描画して確認する
 * （headless = jsdom。実際のピクセルはスクショ側で測る）。
 */
import { render, waitFor } from '@testing-library/react'
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

/** `top-1.5 left-1.5` のような「角」のクラスを取り出す。 */
function positionOf(element: HTMLElement): string {
  const classes = element.className.split(/\s+/)
  const vertical = classes.find((name) => /^(top|bottom)-/.test(name)) ?? ''
  const horizontal = classes.find((name) => /^(left|right)-/.test(name)) ?? ''
  return `${vertical} ${horizontal}`
}

function badgesOf(card: HTMLElement): HTMLElement[] {
  return ['[data-meta-badge]', '[data-resume-badge]', '[data-duration-badge]'].flatMap(
    (selector) => [...card.querySelectorAll<HTMLElement>(selector)],
  )
}

async function cards(): Promise<HTMLElement[]> {
  await waitFor(() => expect(document.querySelector('[data-file-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return [...document.querySelectorAll<HTMLElement>('[data-file-id]')]
}

describe('#114 ファイルモードのバッジ配置', () => {
  it('meta は右下の長さバッジの上、再生位置は左下に分かれる', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden&mode=files')
    render(<App />)

    const card = (await cards()).find(
      (element) =>
        element.querySelector('[data-meta-badge]') !== null &&
        element.querySelector('[data-resume-badge]') !== null,
    )
    expect(card).toBeDefined()

    const meta = card!.querySelector<HTMLElement>('[data-meta-badge]')!
    const resume = card!.querySelector<HTMLElement>('[data-resume-badge]')!
    const duration = card!.querySelector<HTMLElement>('[data-duration-badge]')!

    expect(positionOf(meta)).toBe('bottom-8 right-1.5')
    expect(positionOf(duration)).toBe('bottom-1.5 right-1.5')
    expect(positionOf(resume)).toBe('bottom-1.5 left-1.5')

    // meta と再生位置が同じ角にいない（今回のバグの再発防止）
    expect(positionOf(meta)).not.toBe(positionOf(resume))
    // meta は長さバッジより上（同じ右端でも縦に離す）
    expect(positionOf(meta)).not.toBe(positionOf(duration))
  })

  it('ファイルモードの全カードで、バッジが同じ角を取り合わない', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden&mode=files')
    render(<App />)

    const all = await cards()
    expect(all.length).toBeGreaterThan(0)
    for (const card of all) {
      const positions = badgesOf(card).map(positionOf)
      expect(new Set(positions).size).toBe(positions.length)
    }
  })

  it('作品詳細（作品名なし）では meta は左上のまま', async () => {
    window.history.replaceState({}, '', '/?bench=24&detail=3&thumbs=shown')
    render(<App />)

    await waitFor(() => expect(document.querySelector('[data-work-detail]')).not.toBeNull(), {
      timeout: 5000,
    })
    await waitFor(
      () => expect(document.querySelector('[data-file-id] [data-meta-badge]')).not.toBeNull(),
      { timeout: 5000 },
    )

    const meta = document.querySelector<HTMLElement>('[data-file-id] [data-meta-badge]')!
    expect(positionOf(meta)).toBe('top-1.5 left-1.5')
  })
})
