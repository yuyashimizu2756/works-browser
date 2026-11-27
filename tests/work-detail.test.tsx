/**
 * #99 作品詳細（Gallery minimal）のヘッダ / ツールバー / カード規則。
 *
 * - ヘッダは 3 層（題名 32px / メタ 1 行 / 評価の独立行）で、「未評価」は 1 箇所だけ
 * - 右上は「開く」「フォルダ」の 2 つ。削除は `⋯` メニューの中（開閉・Escape・外側クリック）
 * - ツールバーは 1 段（種類セグメント / 並びメニュー / 昇降トグル / 右端に件数とサムネトグル）
 * - ファイルカードは 4:3・角丸 12・名前 1 行・メタ 2 行（#98 のカード規則）
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilePage, FileQuery, FileSummary, Tag, WorkMark } from '../src/api'
import { WorkDetail } from '../src/library/WorkDetail'
import type { TagData } from '../src/library/tagData'
import { emptyMark, setTagData } from '../src/library/tagData'
import { makeFile, makeWork } from './fixtures'

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

const WORK = makeWork({
  id: 3,
  title: 'ベンチ作品 0003',
  file_count: 24,
  total_bytes: 105_591_194,
  mtime: new Date(2026, 10, 25, 12).getTime(),
})

const FILES: FileSummary[] = [
  makeFile({ id: 1, name: '00001.png', work_id: 3, bytes: 5_348_966, width: 2048, height: 1152 }),
  makeFile({
    id: 2,
    name: '00002.mp4',
    work_id: 3,
    kind: 'video',
    duration_ms: 42_000,
    width: 1920,
    height: 1080,
  }),
]

/** 1 ページ目だけを返す供給元。 */
const source = async (query: FileQuery): Promise<FilePage> => ({
  files: query.offset === 0 ? FILES : [],
  total: FILES.length,
})

/** 作品 1 件ぶんのメモリ実装（Tauri の代わり）。 */
function memoryTagData(): TagData {
  const marks = new Map<number, WorkMark>()
  return {
    listTags: async () => [],
    createTag: async (name: string, color: string): Promise<Tag> => ({
      id: 1,
      name,
      color,
      created_at: 0,
    }),
    deleteTag: async () => undefined,
    getWorkTags: async () => [],
    setWorkTags: async () => [],
    tagSuggestions: async () => [],
    getWorkMark: async (workId: number) => marks.get(workId) ?? emptyMark(workId),
    setWorkMark: async (workId, mark) => {
      const next: WorkMark = {
        ...(marks.get(workId) ?? emptyMark(workId)),
        favorite: mark.favorite,
        rating: mark.rating,
        note: mark.note ?? null,
      }
      marks.set(workId, next)
      return next
    },
    recordOpen: async (workId: number) => {
      const current = marks.get(workId) ?? emptyMark(workId)
      const next: WorkMark = {
        ...current,
        open_count: current.open_count + 1,
        last_opened_at: Date.now(),
      }
      marks.set(workId, next)
      return next
    },
  }
}

function renderDetail(overrides: {
  onBack?: () => void
  onDeleteWork?: (work: typeof WORK, intent: { permanent: boolean }) => void
  thumbnailVisible?: boolean
} = {}) {
  const onBack = overrides.onBack ?? vi.fn()
  const onDeleteWork = overrides.onDeleteWork ?? vi.fn()
  const view = render(
    <WorkDetail
      work={WORK}
      rootLabel="ベンチ"
      accent="var(--brand)"
      thumbnailVisible={overrides.thumbnailVisible ?? false}
      onToggleThumbnails={vi.fn()}
      shielded={false}
      source={source}
      bench
      refreshToken={0}
      onDeleteWork={onDeleteWork}
      onBack={onBack}
    />,
  )
  return { ...view, onBack, onDeleteWork }
}

beforeEach(() => {
  setTagData(memoryTagData())
  // jsdom は幅 0 なので、グリッドが 5 列になる幅を持たせる。
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

describe('#99 作品詳細', () => {
  it('ヘッダは題名 32px / メタ 1 行 / 評価の独立行で、未評価は 1 箇所だけ', async () => {
    renderDetail()

    const title = screen.getByRole('heading', { name: 'ベンチ作品 0003' })
    expect(title.className).toContain('type-display')
    expect(title.className).toContain('text-[length:var(--font-size-32)]')
    expect(title.className).toContain('font-[650]')

    const meta = document.querySelector('[data-work-meta]')
    expect(meta?.textContent).toContain('24 ファイル')
    expect(meta?.textContent).toContain('100.7 MB')
    expect(meta?.textContent).toContain('2026/11/25')
    // #108: お気に入り / 開封 / ルートも同じメタ行に統合する
    expect(meta?.textContent).toContain('お気に入り')
    expect(meta?.textContent).toContain('ベンチ')
    await waitFor(() => expect(meta?.textContent).toContain('開封 1 回'))

    // 星（操作）と「未評価」（値）は独立した行にあり、重複しない
    const ratingRow = document.querySelector('[data-rating-row]')
    expect(ratingRow).not.toBeNull()
    expect(within(ratingRow as HTMLElement).getAllByText('未評価')).toHaveLength(1)
    expect(screen.getAllByText('未評価')).toHaveLength(1)
    expect(within(ratingRow as HTMLElement).getAllByRole('button')).toHaveLength(5)

    // 星を押すと値のテキストだけが変わる
    fireEvent.click(screen.getByRole('button', { name: '3 段階で評価' }))
    await waitFor(() => expect(screen.getByText('3 / 5')).toBeInTheDocument())
    expect(screen.queryAllByText('未評価')).toHaveLength(0)
  })

  it('右上は「開く」「フォルダ」の 2 つで、削除は ⋯ メニューの中', async () => {
    const { onDeleteWork, onBack } = renderDetail()

    expect(screen.getByRole('button', { name: '開く' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'フォルダ' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'ゴミ箱へ' })).toBeNull()

    const trigger = screen.getByRole('button', { name: 'その他の操作' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'その他の操作' })
    expect(within(menu).getByRole('menuitem', { name: 'この作品をゴミ箱へ' })).toBeEnabled()

    // Escape はメニューだけを閉じ、詳細（Esc = 戻る）には流れない
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'その他の操作' })).toBeNull()
    expect(trigger).toHaveFocus()
    expect(onBack).not.toHaveBeenCalled()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'この作品をゴミ箱へ' }))
    expect(onDeleteWork).toHaveBeenCalledTimes(1)
    expect(onDeleteWork).toHaveBeenCalledWith(WORK, { permanent: false })
    expect(screen.queryByRole('menu', { name: 'その他の操作' })).toBeNull()
  })

  it('メニューは外側クリックでも閉じる', () => {
    renderDetail()
    fireEvent.click(screen.getByRole('button', { name: 'その他の操作' }))
    expect(screen.getByRole('menu', { name: 'その他の操作' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu', { name: 'その他の操作' })).toBeNull()
  })

  it('ツールバーは 1 段で、種類セグメント・並びメニュー・昇降・右端の件数', async () => {
    renderDetail()

    const toolbar = screen.getByRole('toolbar', { name: 'ファイルのツールバー' })
    const kinds = within(toolbar).getByRole('group', { name: '種類で絞り込み' })
    const kindButtons = within(kinds).getAllByRole('button')
    expect(kindButtons).toHaveLength(3)
    expect(kindButtons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(
      1,
    )

    // 並びはメニュー、昇降はアイコントグル 1 つ
    fireEvent.click(within(toolbar).getByRole('button', { name: '並び替え（現在: 名前）' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '更新日' }))
    expect(
      within(toolbar).getByRole('button', { name: '並び替え（現在: 更新日）' }),
    ).toBeInTheDocument()
    expect(
      within(toolbar).getByRole('button', { name: '降順（クリックで昇順）' }),
    ).toBeInTheDocument()

    await waitFor(() => expect(within(toolbar).getByText('2 ファイル')).toBeInTheDocument())
    expect(within(toolbar).getByRole('button', { name: 'サムネイルを表示する' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('ファイルカードは 4:3・角丸 12・名前 1 行・メタ 2 行', async () => {
    renderDetail()

    await waitFor(() => expect(screen.getByText('00002.mp4')).toBeInTheDocument())
    const tile = document.querySelector('[data-file-id="2"]') as HTMLElement
    const thumb = tile.querySelector('[data-thumb-ratio="4:3"]') as HTMLElement

    expect(tile.className).toContain('rounded-[var(--radius-card)]')
    // 1200px 幅 - 左右 24px → 5 列。列幅 217.6px の 4:3 は 163px、カードは +77px。
    expect(thumb).toHaveStyle({ height: '163px' })
    expect(tile).toHaveStyle({ height: '240px' })
    expect(Math.round((Number.parseFloat(thumb.style.height) * 4) / 3)).toBe(217)

    const name = screen.getByText('00002.mp4')
    expect(name.className).toContain('truncate')
    expect(name.className).not.toContain('line-clamp')
    // 2 行目はサイズ · 更新日、3 行目は種類 · 長さ
    expect(tile.textContent).toContain('動画 · 0:42')
  })

  it('戻る（←）は左上に固定され、Esc はツールチップで案内する', () => {
    const { onBack } = renderDetail()

    const back = screen.getByRole('button', { name: 'ライブラリへ戻る' })
    expect(back).toHaveAttribute('title', 'ライブラリへ戻る（Esc）')
    expect(back.closest('[data-work-header]')).not.toBeNull()

    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})
