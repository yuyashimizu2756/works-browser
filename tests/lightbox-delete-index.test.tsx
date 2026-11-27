/**
 * #16: ライトボックスから削除したとき、表示だけでなく履歴の index も直ること。
 *
 * レビュー指摘: `Math.min` で表示を丸めるだけだったため、`fileIndex`（履歴）が
 * 古いまま残っていた。ここでは「最後の 1 枚を削除 → 前のファイル」「空なら閉じる」を
 * WorkDetail の実配線で確認する。
 */
import { useState } from 'react'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileSummary } from '../src/api'
import { WorkDetail } from '../src/library/WorkDetail'
import { makeFile, makeWork } from './fixtures'

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

function Host({
  initial,
  changes,
}: {
  initial: FileSummary[]
  changes: (number | null)[]
}) {
  const [files, setFiles] = useState(initial)
  const [refreshToken, setRefreshToken] = useState(0)
  const [index, setIndex] = useState<number | null>(initial.length - 1)

  return (
    <WorkDetail
      work={makeWork({ id: 1, file_count: files.length })}
      rootLabel="ルート"
      accent="#22d3ee"
      thumbnailVisible={false}
      onToggleThumbnails={() => {}}
      shielded={false}
      bench
      source={async () => ({ files, total: files.length })}
      refreshToken={refreshToken}
      lightboxIndex={index}
      onLightboxIndexChange={(next) => {
        changes.push(next)
        setIndex(next)
      }}
      onBack={() => {}}
      onDeleteSelected={(items) => {
        const ids = new Set(items.map((item) => item.id))
        setFiles((previous) => previous.filter((file) => !ids.has(file.id)))
        setRefreshToken((value) => value + 1)
      }}
    />
  )
}

function positionText() {
  return document.querySelector('[data-lightbox-position]')?.textContent ?? ''
}

async function deleteFromLightboxMenu() {
  fireEvent.click(
    await waitFor(() => {
      const trigger = document.querySelector<HTMLElement>('[data-lightbox-menu-trigger]')
      expect(trigger).not.toBeNull()
      return trigger!
    }),
  )
  fireEvent.click(
    await waitFor(() => {
      const trash = document.querySelector<HTMLElement>('[data-lightbox-trash]')
      expect(trash).not.toBeNull()
      return trash!
    }),
  )
}

describe('#16 削除後のライトボックス index', () => {
  it('最後の 1 枚を削除すると前のファイルを表示し、履歴の index も 1 つ前へ', async () => {
    const changes: (number | null)[] = []
    const files = [
      makeFile({ id: 11, name: 'a.png' }),
      makeFile({ id: 12, name: 'b.png' }),
      makeFile({ id: 13, name: 'c.png' }),
    ]
    render(<Host initial={files} changes={changes} />)

    await waitFor(() => expect(document.querySelector('[data-lightbox]')).not.toBeNull())
    await waitFor(() => expect(positionText()).toContain('3 / 3'))

    await deleteFromLightboxMenu()

    // 13 が消え、12 が添字 1（末尾）になる
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox]')?.getAttribute('data-file-id')).toBe('12'),
    )
    expect(positionText()).toContain('2 / 2')
    expect(changes.at(-1)).toBe(1)
    expect(document.querySelector('[data-lightbox]')).not.toBeNull()
  })

  it('残りが 0 件ならライトボックスを閉じる（履歴は null）', async () => {
    const changes: (number | null)[] = []
    render(<Host initial={[makeFile({ id: 21, name: 'only.png' })]} changes={changes} />)

    await waitFor(() => expect(document.querySelector('[data-lightbox]')).not.toBeNull())
    await waitFor(() => expect(positionText()).toContain('1 / 1'))

    await deleteFromLightboxMenu()

    await waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull())
    expect(changes.at(-1)).toBeNull()
    // ライトボックスが消えても作品詳細は残る
    expect(document.querySelector('[data-work-detail]')).not.toBeNull()
  })
})
