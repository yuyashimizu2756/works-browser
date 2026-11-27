/**
 * #14: ベンチ / デモモード（`?bench=N&demo=1`）では実 DB に書き込まない。
 *
 * `WorkDetail` は `bench` のとき `Lightbox` に作品 ID を渡さず、ヘッダの
 * お気に入り・評価・タグは固定表示 + disabled にする。ここでは `../src/api` を
 * `vi.mock` して、ベンチで押しても保存系のコマンドが呼ばれないこと、
 * 通常モードでは従来どおり `setWorkMark` が呼ばれることを確認する。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilePage, FileQuery, FileSummary } from '../src/api'
import { api } from '../src/api'
import { emptyMark, setTagData } from '../src/library/tagData'
import { WorkDetail } from '../src/library/WorkDetail'
import { BENCH_SAVE_HINT } from '../src/library/WorkMarksBar'
import { makeFile, makeWork } from './fixtures'

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getWorkSummary: vi.fn(),
      getWorkMark: vi.fn(),
      setWorkMark: vi.fn(),
      getWorkTags: vi.fn(),
      setWorkTags: vi.fn(),
      listTags: vi.fn(),
      recordOpen: vi.fn(),
    },
  }
})

// jsdom にはレイアウトが無いため、仮想スクロールは「全行が可視」として扱う。
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

const WORK = makeWork({ id: 3, title: 'ベンチ作品 0003' })

const FILES: FileSummary[] = [makeFile({ id: 1, work_id: 3, name: '00001.png' })]

const source = async (query: FileQuery): Promise<FilePage> => ({
  files: query.offset === 0 ? FILES : [],
  total: FILES.length,
})

function renderDetail(bench: boolean) {
  return render(
    <WorkDetail
      work={WORK}
      rootLabel="ベンチ"
      accent="var(--brand)"
      thumbnailVisible={false}
      onToggleThumbnails={vi.fn()}
      shielded={false}
      source={source}
      bench={bench}
      refreshToken={0}
      onBack={vi.fn()}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // ベンチで override が無い状態 = 書き込み先が実 DB（Tauri）になる状態を再現する
  setTagData(null)
  vi.mocked(api.getWorkSummary).mockResolvedValue({
    work: WORK,
    root_label: 'ベンチ',
    root_real_path: 'D:\\Works\\root-1',
  })
  vi.mocked(api.getWorkMark).mockImplementation(async (workId) => emptyMark(workId))
  vi.mocked(api.recordOpen).mockImplementation(async (workId) => emptyMark(workId))
  vi.mocked(api.getWorkTags).mockResolvedValue([])
  vi.mocked(api.listTags).mockResolvedValue([])
  vi.mocked(api.setWorkMark).mockImplementation(async (workId, mark) => ({
    ...emptyMark(workId),
    favorite: mark.favorite,
    rating: mark.rating,
    note: mark.note ?? null,
  }))

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
  setTagData(null)
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
})

describe('#14 ベンチ / デモは実 DB に書き込まない', () => {
  it('ハート・星・タグは固定表示で disabled になり、保存系を呼ばない', () => {
    renderDetail(true)

    const marks = document.querySelector('[data-work-marks]') as HTMLElement
    expect(marks).toHaveAttribute('data-bench-locked', 'true')
    expect(marks).toHaveAttribute('title', BENCH_SAVE_HINT)
    // 固定値（BENCH_MARK）を表示する: お気に入り / ★4 / 開封 3 回
    expect(marks).toHaveAttribute('data-open-count', '3')
    expect(screen.getByText('4 / 5')).toBeInTheDocument()
    expect(screen.getByText('開封 3 回')).toBeInTheDocument()

    const favorite = screen.getByRole('button', { name: 'お気に入りから外す' })
    const star = screen.getByRole('button', { name: '3 段階で評価' })
    const tag = document.querySelector('[data-tag-open]') as HTMLElement
    expect(favorite).toBeDisabled()
    expect(star).toBeDisabled()
    expect(tag).toBeDisabled()
    expect(favorite).toHaveAttribute('title', BENCH_SAVE_HINT)
    expect(tag).toHaveAttribute('title', BENCH_SAVE_HINT)

    fireEvent.click(favorite)
    fireEvent.click(star)
    fireEvent.click(tag)
    // キーボード（F / 1〜5）でも保存しない
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF' })
    fireEvent.keyDown(window, { key: '3', code: 'Digit3' })

    expect(api.setWorkMark).not.toHaveBeenCalled()
    expect(api.getWorkMark).not.toHaveBeenCalled()
    expect(api.recordOpen).not.toHaveBeenCalled()
    expect(api.setWorkTags).not.toHaveBeenCalled()
  })

  it('ライトボックスにも作品 ID を渡さない（操作自体が出ない）', async () => {
    renderDetail(true)
    const open = screen.getByRole('button', { name: '開く' })
    await waitFor(() => expect(open).toBeEnabled())
    fireEvent.click(open)

    await waitFor(() => expect(document.querySelector('[data-lightbox]')).not.toBeNull())
    expect(document.querySelector('[data-lightbox-marks]')).toBeNull()
    expect(screen.getByRole('button', { name: 'タグを編集（T）' })).toBeDisabled()
    expect(api.setWorkMark).not.toHaveBeenCalled()
    expect(api.recordOpen).not.toHaveBeenCalled()
  })

  it('通常モードでは従来どおり星を押すと setWorkMark が呼ばれる', async () => {
    renderDetail(false)

    const star = screen.getByRole('button', { name: '3 段階で評価' })
    await waitFor(() => expect(star).toBeEnabled())
    fireEvent.click(star)

    await waitFor(() =>
      expect(api.setWorkMark).toHaveBeenCalledWith(
        WORK.id,
        expect.objectContaining({ rating: 3, favorite: false }),
      ),
    )
    await waitFor(() => expect(screen.getByText('3 / 5')).toBeInTheDocument())
  })
})
