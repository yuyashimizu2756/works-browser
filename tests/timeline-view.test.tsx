/**
 * #90: `TimelineView`（#81）のコンポーネントテスト。
 *
 * 純関数（`src/lib/timeline.ts`）側は `timeline.test.ts` が見ているので、ここでは
 * 「ページが届くとセクションが増える」「同じ日付は 1 セクション」「サムネ非表示では
 * 画像を要求しない」「空データ」「sticky 見出し」という画面の振る舞いだけを確かめる。
 *
 * jsdom にはレイアウトが無いため、仮想スクロールは「全行が可視」として扱う。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkPage, WorkQuery, WorkSummary } from '../src/api'
import { TimelineView } from '../src/library/TimelineView'
import { makeWork } from './fixtures'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: options.count }, (_, index) => ({ index })),
    measure: () => {},
  }),
}))

const { thumbSrcMock } = vi.hoisted(() => ({
  thumbSrcMock: vi.fn((path: string | null | undefined) =>
    path ? `thumb://${path}` : null,
  ),
}))

vi.mock('../src/library/thumbSrc', () => ({
  thumbSrc: thumbSrcMock,
}))

/** ローカル時刻で日時を作る（UTC に落とすと日付がずれる）。 */
function local(year: number, monthIndex: number, day: number, hour = 12): number {
  return new Date(year, monthIndex, day, hour).getTime()
}

/** 1 ページ目だけを返し、以降は空（= 追加読み込みなし）にする供給元。 */
function singlePage(works: WorkSummary[]): (query: WorkQuery) => Promise<WorkPage> {
  return async (query) => ({
    works: query.offset === 0 ? works : [],
    total: works.length,
  })
}

function renderTimeline(options: {
  source: (query: WorkQuery) => Promise<WorkPage>
  thumbnailsVisible?: boolean
}) {
  const view = render(
    <TimelineView
      rootLabels={new Map([[1, 'ルート 1']])}
      rootAccents={new Map([[1, 'var(--accent-cyan)']])}
      source={options.source}
      refreshToken={0}
      thumbnailsVisible={options.thumbnailsVisible ?? false}
      onToggleThumbnails={() => {}}
      bench
      selectedIds={new Set<number>()}
      onOpenWork={() => {}}
      onToggle={() => {}}
    />,
  )
  const scroller = view.container.querySelector('[data-timeline]') as HTMLDivElement
  return { ...view, scroller }
}

beforeEach(() => {
  thumbSrcMock.mockClear()
  // jsdom は幅 0 なので、仮想グリッドが 1 列以上になるよう幅を持たせる。
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 1200,
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  // プロトタイプに足した独自 getter を消して、jsdom 元の clientWidth に戻す。
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

describe('TimelineView', () => {
  it('ページが届くとその日付のセクションが増える', async () => {
    const firstPage = [
      makeWork({ id: 1, mtime: local(2026, 10, 26, 9) }),
      makeWork({ id: 2, mtime: local(2026, 10, 26, 18) }),
    ]
    const secondPage = [makeWork({ id: 3, mtime: local(2026, 10, 25, 10) })]

    // 2 ページ目は手動で解放するまで返さない（1 セクションの状態を確実に観測する）。
    let releaseSecondPage = () => {}
    const secondPageReady = new Promise<void>((resolve) => {
      releaseSecondPage = resolve
    })
    const source = vi.fn(async (query: WorkQuery): Promise<WorkPage> => {
      if (query.offset === 0) return { works: firstPage, total: 3 }
      await secondPageReady
      return { works: secondPage, total: 3 }
    })

    const { scroller } = renderTimeline({ source })

    await waitFor(() => expect(scroller).toHaveAttribute('data-sections', '1'))
    expect(screen.getByText('2026-11-26（木）・2 件')).toBeInTheDocument()
    // 末尾に近づいて次のページを要求済みだが、まだ届いていない。
    await waitFor(() => expect(source).toHaveBeenCalledTimes(2))
    expect(scroller).toHaveAttribute('data-sections', '1')
    expect(screen.queryByText('2026-11-25（水）・1 件')).toBeNull()

    releaseSecondPage()

    await waitFor(() => expect(scroller).toHaveAttribute('data-sections', '2'))
    expect(screen.getByText('2026-11-25（水）・1 件')).toBeInTheDocument()
  })

  it('同じ日付の作品は 1 セクションにまとめる', async () => {
    const works = [
      makeWork({ id: 1, mtime: local(2026, 10, 26, 9) }),
      makeWork({ id: 2, mtime: local(2026, 10, 26, 12) }),
      makeWork({ id: 3, mtime: local(2026, 10, 26, 18) }),
    ]
    const { scroller } = renderTimeline({ source: singlePage(works) })

    await waitFor(() => expect(scroller).toHaveAttribute('data-sections', '1'))
    expect(screen.getByText('2026-11-26（木）・3 件')).toBeInTheDocument()
    expect(screen.getAllByText(/2026-11-26（木）/)).toHaveLength(1)
    expect(screen.getByText('作品 1')).toBeInTheDocument()
    expect(screen.getByText('作品 2')).toBeInTheDocument()
    expect(screen.getByText('作品 3')).toBeInTheDocument()
  })

  it('サムネイル非表示（既定 OFF）では画像を要求しない', async () => {
    const works = [
      makeWork({
        id: 1,
        mtime: local(2026, 10, 26),
        cover_thumb: 'covers/cover-1.webp',
        preview_thumbs: ['covers/a.webp', 'covers/b.webp'],
      }),
    ]
    const { scroller } = renderTimeline({ source: singlePage(works) })

    await waitFor(() => expect(scroller).toHaveAttribute('data-sections', '1'))
    expect(screen.getByText('作品 1')).toBeInTheDocument()

    expect(thumbSrcMock).not.toHaveBeenCalled()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it('サムネイル表示 ON のときだけ表紙画像を出す（非表示テストの対照）', async () => {
    const works = [
      makeWork({
        id: 1,
        mtime: local(2026, 10, 26),
        cover_thumb: 'covers/cover-1.webp',
      }),
    ]
    const { scroller } = renderTimeline({
      source: singlePage(works),
      thumbnailsVisible: true,
    })

    await waitFor(() => expect(scroller).toHaveAttribute('data-sections', '1'))
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(1))
    expect(thumbSrcMock).toHaveBeenCalledWith('covers/cover-1.webp')
    expect(document.querySelector('img')).toHaveAttribute('src', 'thumb://covers/cover-1.webp')
  })

  it('空データでは「まだ作品がありません」を出し、画像も出さない', async () => {
    const { scroller } = renderTimeline({ source: singlePage([]) })

    expect(await screen.findByText('まだ作品がありません')).toBeInTheDocument()
    expect(scroller).toHaveAttribute('data-sections', '0')
    expect(scroller).toHaveAttribute('data-total', '0')
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })

  it('スクロールすると現在の日付見出しを上端に固定表示する', async () => {
    const works = [
      makeWork({ id: 1, mtime: local(2026, 10, 26, 18) }),
      makeWork({ id: 2, mtime: local(2026, 10, 25, 10) }),
    ]
    const { container, scroller } = renderTimeline({ source: singlePage(works) })

    await waitFor(() => expect(scroller).toHaveAttribute('data-sections', '2'))
    expect(screen.getByText('2026-11-26（木）・1 件')).toBeInTheDocument()
    expect(screen.getByText('2026-11-25（水）・1 件')).toBeInTheDocument()
    expect(container.querySelector('[aria-hidden="true"] h2')).toBeNull()

    // #98: 見出し 46px + カード行 291px（1200px 幅 / 4 列 / 4:3）= 337px が 2 日目の
    // 先頭。400px まで送ると 1 日目の見出しは上に隠れ、2 日目が固定表示になる。
    await act(async () => {
      scroller.scrollTop = 400
      fireEvent.scroll(scroller)
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    })

    const sticky = container.querySelector('[aria-hidden="true"] h2')
    expect(sticky).not.toBeNull()
    expect(sticky).toHaveTextContent('2026-11-25（水）・1 件')
  })
})
