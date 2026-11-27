/**
 * #24: ファイルモードのカードからフルパスをコピーする。
 *
 * カードのコピーアイコンは目アイコン（非表示中のみ）の隣に出る。
 * UI はパスを組み立てず、Rust の `file_path`（`api.filePath`）を呼ぶこと、
 * 結果が既存のトーストで通知されることを確認する。
 */
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../src/App'
import { api } from '../src/api'

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

beforeEach(() => {
  window.history.replaceState({}, '', '/?bench=24&thumbs=shown&mode=files')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

async function firstCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-file-id]')).not.toBeNull(), {
    timeout: 5000,
  })
  return document.querySelector<HTMLElement>('[data-file-id]')!
}

describe('#24 カードのパスコピー', () => {
  it('コピーアイコンが目アイコンの位置にあり、api.filePath の結果をコピーする', async () => {
    const filePath = vi
      .spyOn(api, 'filePath')
      .mockResolvedValue('D:\\Works\\root-1\\work-1\\001.png')
    render(<App />)
    const card = await firstCard()
    const copy = card.querySelector<HTMLElement>('[data-file-copy]')

    expect(copy).not.toBeNull()
    // サムネ表示中は目アイコンのスロット（右から 38px）を使う
    expect(copy).toHaveClass('right-[38px]')
    expect(copy).toHaveClass('size-6')

    fireEvent.click(copy!)
    await waitFor(() =>
      expect(filePath).toHaveBeenCalledWith(Number(card.dataset.fileId)),
    )
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        'D:\\Works\\root-1\\work-1\\001.png',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-toast-stack]')?.textContent).toContain(
        'パスをコピーしました',
      ),
    )
    // カードの「開く」へ伝播しない
    expect(document.querySelector('[data-work-detail]')).toBeNull()
  })

  it('サムネ非表示中は目アイコンの左隣（右から 70px）に並ぶ', async () => {
    window.history.replaceState({}, '', '/?bench=24&detail=3&thumbs=hidden')
    render(<App />)
    const card = await firstCard()

    expect(card.querySelector('[data-file-reveal]')).not.toBeNull()
    const copy = card.querySelector<HTMLElement>('[data-file-copy]')
    expect(copy).not.toBeNull()
    expect(copy).toHaveClass('right-[70px]')
  })

  it('解決に失敗したらエラーを通知し、コピーしない', async () => {
    vi.spyOn(api, 'filePath').mockRejectedValue(new Error('ファイル 999 が見つかりません'))
    render(<App />)
    const card = await firstCard()

    fireEvent.click(card.querySelector('[data-file-copy]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-toast-stack]')?.textContent).toContain(
        'パスを取得できませんでした',
      ),
    )
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  })
})
