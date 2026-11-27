/**
 * #5: 個別サムネ表示ボタン（目アイコン）の表示条件。
 *
 * - サムネ非表示の既定状態では `opacity-0` + `pointer-events-none`
 * - カードの hover / focus-within、ボタン自身の focus-visible で出る
 * - タッチ環境（`@media (hover: none)`）は CSS で常時表示に戻す
 * - チェックボックスの既存の hover 表示は変えない
 */
import { readFileSync } from 'node:fs'
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

async function firstFileCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-file-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-file-id]')!
}

describe('#5 作品カードの目アイコンは hover / focus のときだけ', () => {
  it('既定は透明 + pointer-events-none、hover / focus 用のクラスを持つ', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    const card = await firstWorkCard()
    const reveal = card.querySelector<HTMLElement>('[data-work-reveal]')!

    expect(card).toHaveClass('group/card')
    expect(reveal).toHaveAttribute('aria-pressed', 'false')
    expect(reveal).toHaveAccessibleName('この作品のサムネイルを表示')

    // 非表示時はクリックを受けない（hover でだけ戻す）
    expect(reveal).toHaveClass('opacity-0')
    expect(reveal).toHaveClass('pointer-events-none')
    expect(reveal).toHaveClass('group-hover/card:opacity-100')
    expect(reveal).toHaveClass('group-hover/card:pointer-events-auto')
    expect(reveal).toHaveClass('group-focus-within/card:opacity-100')
    expect(reveal).toHaveClass('focus-visible:opacity-100')

    // tab 移動でフォーカスできる（pointer-events はキーボード操作を妨げない）
    reveal.focus()
    expect(reveal).toHaveFocus()
  })

  it('個別表示中は常時表示（hover 条件から外れる）', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    const card = await firstWorkCard()
    const reveal = card.querySelector<HTMLElement>('[data-work-reveal]')!

    fireEvent.click(reveal)
    expect(reveal).toHaveAttribute('aria-pressed', 'true')
    expect(reveal).toHaveClass('opacity-100')
    expect(reveal).not.toHaveClass('opacity-0')
    expect(reveal).not.toHaveClass('pointer-events-none')
  })

  it('チェックボックスの hover 表示は変えない', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden')
    render(<App />)
    const card = await firstWorkCard()
    const checkbox = card.querySelector<HTMLElement>('[role="checkbox"]')!

    expect(checkbox).toHaveClass('opacity-0')
    expect(checkbox).toHaveClass('group-hover/card:opacity-100')
    expect(checkbox).toHaveClass('group-focus-within/card:opacity-100')
    expect(checkbox).not.toHaveClass('pointer-events-none')
  })
})

describe('#5 ファイルカードの目アイコンも同じ規則', () => {
  it('既定は透明 + pointer-events-none、hover / focus 用のクラスを持つ', async () => {
    window.history.replaceState({}, '', '/?bench=24&thumbs=hidden&mode=files')
    render(<App />)
    const card = await firstFileCard()
    const reveal = card.querySelector<HTMLElement>('[data-file-reveal]')!

    expect(card).toHaveClass('group/file')
    expect(reveal).toHaveAttribute('aria-pressed', 'false')
    expect(reveal).toHaveClass('opacity-0')
    expect(reveal).toHaveClass('pointer-events-none')
    expect(reveal).toHaveClass('group-hover/file:opacity-100')
    expect(reveal).toHaveClass('group-hover/file:pointer-events-auto')
    expect(reveal).toHaveClass('group-focus-within/file:opacity-100')
    expect(reveal).toHaveClass('focus-visible:opacity-100')
  })
})

describe('#5 タッチ環境では常時表示（CSS）', () => {
  it('index.css の @media (hover: none) が両方の目アイコンを表示に戻す', () => {
    const css = readFileSync('src/index.css', 'utf8')
    const block = /@media \(hover: none\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''

    expect(css).toContain('@media (hover: none)')
    expect(block).toContain('[data-work-reveal]')
    expect(block).toContain('[data-file-reveal]')
    expect(block).toMatch(/opacity:\s*1\s*!important/)
    expect(block).toMatch(/pointer-events:\s*auto\s*!important/)
  })
})
