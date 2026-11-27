import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { FileKindFilter, FileSortKey, FileSummary, RootInfo } from '../api'
import { canCompare } from '../lib/compare'
import { formatBytes, formatCount } from '../lib/format'
import { selectWorks } from '../lib/selection'
import type { SelectModifiers } from '../lib/selection'
import { FILE_KIND_FILTERS, FILE_SORTS } from '../lib/viewMode'
import type { LibraryViewMode } from '../lib/viewMode'
import type { DeleteIntent } from './DeleteFlow'
import { FileGrid } from './FileGrid'
import type { SortDir } from './sortPrefs'
import type { ActiveFilterChip } from './Toolbar'
import {
  FilterChipBar,
  FilterChoice,
  FilterMenu,
  FilterSection,
  FilterToggle,
  SortMenu,
  ThumbnailToggle,
  ToolbarCount,
  ToolbarSearch,
  ToolbarShell,
  ViewModeSegment,
} from './Toolbar'
import type { FilePageSource } from './useFileFeed'
import { useFileFeed } from './useFileFeed'

type Props = {
  roots: RootInfo[]
  rootAccents: Map<number, string>
  /** ベンチモードでは Tauri の代わりに合成データを読む。 */
  source?: FilePageSource
  refreshToken: number
  thumbnailsVisible: boolean
  /** #120: ツールバー右端のラベル付きサムネトグル（ヘッダー / 詳細と共有）。 */
  onToggleThumbnails: () => void
  bench: boolean
  searchRef: RefObject<HTMLInputElement | null>
  search: string
  onSearchChange: (value: string) => void
  kind: FileKindFilter
  onKindChange: (value: FileKindFilter) => void
  rootId: number | null
  onRootIdChange: (value: number | null) => void
  sort: FileSortKey
  onSortChange: (value: FileSortKey) => void
  /** #87: 昇順 / 降順。 */
  dir: SortDir
  onToggleDir: () => void
  /** #60: 検索語を生成情報にも当てるか。 */
  metaSearch: boolean
  onMetaSearchChange: (value: boolean) => void
  /** #96: ツールバー右端の表示切替。 */
  viewMode: LibraryViewMode
  onViewModeChange: (mode: LibraryViewMode) => void
  onOpenFile: (file: FileSummary) => void
  onOpenRoots: () => void
  /** 削除後に選択を解除するためのトークン（App が削除成功時に増やす）。 */
  selectionResetToken?: number
  /** 選択ファイルの削除（#15）。 */
  onDeleteSelected?: (files: FileSummary[], intent: DeleteIntent) => void
  /** #71: 選択した 2〜4 ファイルを比較ビューで開く。 */
  onCompareSelected?: (files: FileSummary[]) => void
  /** #81: モードを切り替えて戻ったときに選択を復元する。 */
  initialSelection?: FileSummary[]
  /** #81: 選択を親（LibraryView）へ控えておく。 */
  onSelectionChange?: (files: FileSummary[]) => void
  /** #81: モードを切り替えて戻ったときのスクロール位置。 */
  restoreScrollTop?: number
}

/**
 * ファイルモード（#21）。`files` を直接グリッド表示し、65,000 件でも
 * 仮想スクロール + LIMIT/OFFSET で軽く動かす。
 *
 * サムネ非表示中は同じデータをコンパクトリストで描く（画像リクエスト 0 件）。
 */
export function FilesView({
  roots,
  rootAccents,
  source,
  refreshToken,
  thumbnailsVisible,
  onToggleThumbnails,
  bench,
  searchRef,
  search,
  onSearchChange,
  kind,
  onKindChange,
  rootId,
  onRootIdChange,
  sort,
  onSortChange,
  dir,
  onToggleDir,
  metaSearch,
  onMetaSearchChange,
  viewMode,
  onViewModeChange,
  onOpenFile,
  onOpenRoots,
  selectionResetToken = 0,
  onDeleteSelected,
  onCompareSelected,
  initialSelection,
  onSelectionChange,
  restoreScrollTop,
}: Props) {
  const feed = useFileFeed({
    query: {
      search,
      kind,
      rootId,
      sort,
      dir,
      metaQuery: metaSearch ? search : undefined,
    },
    source,
    refreshToken,
  })

  const hasFilters =
    search.trim() !== '' || kind !== 'all' || rootId !== null || metaSearch
  const resetFilters = () => {
    onSearchChange('')
    onKindChange('all')
    onRootIdChange(null)
    onMetaSearchChange(false)
  }

  // ファイルモードも選択はチェックボックスだけ（#27）。Ctrl / Shift はチェック上でのみ。
  // #81: 作品 / タイムラインへ切り替えて戻っても選択が消えないよう、
  // 初期値と変更の通知を受け取る（親がモードごとに控える）。
  const [selection, setSelection] = useState<Map<number, FileSummary>>(
    () => new Map((initialSelection ?? []).map((file) => [file.id, file])),
  )
  const anchorRef = useRef<number | null>(null)
  const selectedIds = useMemo(() => new Set(selection.keys()), [selection])
  const selectedFiles = useMemo(() => [...selection.values()], [selection])
  const selectedBytes = useMemo(
    () => selectedFiles.reduce((total, file) => total + file.bytes, 0),
    [selectedFiles],
  )
  const clearSelection = useCallback(() => {
    setSelection(new Map())
    anchorRef.current = null
  }, [])

  useEffect(() => {
    onSelectionChange?.(selectedFiles)
  }, [onSelectionChange, selectedFiles])

  useEffect(() => {
    if (selectionResetToken > 0) clearSelection()
  }, [selectionResetToken, clearSelection])

  const handleDelete = useCallback(
    (permanent = false) => {
      if (selectedFiles.length === 0) return
      onDeleteSelected?.(selectedFiles, { permanent })
    },
    [onDeleteSelected, selectedFiles],
  )

  const handleToggle = useCallback(
    (file: FileSummary, modifiers: SelectModifiers) => {
      const next = selectWorks(selection, file, modifiers, feed.files, anchorRef.current)
      setSelection(next.selection)
      anchorRef.current = next.anchorId
    },
    [feed.files, selection],
  )

  // Esc でファイルの選択を解除、Delete で削除（入力中は奪わない）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        Boolean(target?.isContentEditable)
      ) {
        return
      }
      if (event.key === 'Delete' && selection.size > 0) {
        if (document.querySelector('[role="dialog"]')) return
        event.preventDefault()
        handleDelete(event.shiftKey)
        return
      }
      if (event.key !== 'Escape') return
      clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearSelection, handleDelete, selection.size])

  const rootLabels = new Map(roots.map(({ root }) => [root.id, root.label]))
  const activeFilterCount =
    (kind !== 'all' ? 1 : 0) + (rootId !== null ? 1 : 0) + (metaSearch ? 1 : 0)
  const activeChips: ActiveFilterChip[] = []
  if (kind !== 'all') {
    activeChips.push({
      key: 'kind',
      label: FILE_KIND_FILTERS.find((option) => option.key === kind)?.label ?? '種類',
      onRemove: () => onKindChange('all'),
    })
  }
  if (rootId !== null) {
    activeChips.push({
      key: 'root',
      label: `ルート: ${rootLabels.get(rootId) ?? '選択中'}`,
      onRemove: () => onRootIdChange(null),
    })
  }
  if (metaSearch) {
    activeChips.push({
      key: 'meta',
      label: '生成情報も検索',
      onRemove: () => onMetaSearchChange(false),
    })
  }

  const empty: ReactNode = hasFilters ? (
    <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
      <p className="text-base font-semibold">条件に一致するファイルがありません</p>
      <p className="m-0 text-xs text-muted-foreground">
        検索語や種類・ルートの絞り込みを変えてみてください。
      </p>
      <Button variant="outline" size="sm" onClick={resetFilters}>
        条件をクリア
      </Button>
    </div>
  ) : roots.length === 0 ? (
    <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
      <p className="text-base font-semibold">まだファイルがありません</p>
      <p className="m-0 text-xs text-muted-foreground">
        走査ルートを追加して「走査」を実行すると、ファイルが並びます。
      </p>
      <Button size="sm" onClick={onOpenRoots}>
        走査ルートを追加
      </Button>
    </div>
  ) : (
    <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
      <p className="text-base font-semibold">索引されたファイルがありません</p>
      <p className="m-0 text-xs text-muted-foreground">
        「走査ルート」から対象フォルダを走査してください。
      </p>
      <Button size="sm" onClick={onOpenRoots}>
        走査ルートを開く
      </Button>
    </div>
  )

  const gridProps = {
    files: feed.files,
    total: feed.total,
    hasMore: feed.hasMore,
    loading: feed.status === 'loading',
    firstPageMs: feed.firstPageMs,
    onLoadMore: feed.loadMore,
    onOpen: onOpenFile,
    onToggle: handleToggle,
    selectedIds,
    rootLabels,
    rootAccents,
    thumbnailVisible: thumbnailsVisible,
    resetKey: `${search.trim()}\u0000${kind}\u0000${rootId ?? ''}\u0000${sort}\u0000${dir}\u0000${metaSearch ? 'meta' : ''}`,
    restoreScrollTop,
    bench,
    empty,
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="ファイル一覧">
      {selection.size > 0 && (
        <div
          className="flex flex-none flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-4 py-2 lg:px-6"
          role="region"
          aria-label="選択中のファイル"
        >
          <Badge
            variant="secondary"
            className="border border-[color-mix(in_srgb,var(--brand)_40%,transparent)] bg-[color-mix(in_srgb,var(--brand)_12%,transparent)] text-[var(--brand)] tabular-nums"
          >
            {formatCount(selection.size)} 件選択
          </Badge>
          <span className="text-xs text-[var(--text-secondary)] tabular-nums">
            {formatBytes(selectedBytes)}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" size="xs" onClick={clearSelection}>
              選択解除
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onCompareSelected?.(selectedFiles)}
              disabled={!canCompare(selectedFiles.length)}
              title="選択した 2〜4 件を並べて比較（#71）"
            >
              比較
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={() => handleDelete(false)}
              disabled={selectedFiles.length === 0}
            >
              削除
            </Button>
          </div>
        </div>
      )}

      <ToolbarShell
        label="ファイルのツールバー"
        chips={<FilterChipBar chips={activeChips} onClear={resetFilters} />}
      >
        <ToolbarSearch
          value={search}
          onChange={onSearchChange}
          inputRef={searchRef}
          placeholder="ファイル名・パスで検索"
          ariaLabel="ファイルを検索"
          searching={feed.isSearching}
          dataAttr={{ 'data-file-search': true }}
        />

        <FilterMenu count={activeFilterCount} onClear={resetFilters}>
          {() => (
            <>
              <FilterSection label="種類">
                <div className="flex flex-wrap gap-1.5">
                  {FILE_KIND_FILTERS.map((option) => (
                    <FilterChoice
                      key={option.key}
                      active={option.key === kind}
                      onClick={() => onKindChange(option.key)}
                    >
                      {option.label}
                    </FilterChoice>
                  ))}
                </div>
              </FilterSection>

              <FilterSection label="ルート">
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
                  <FilterChoice active={rootId === null} onClick={() => onRootIdChange(null)}>
                    すべて
                  </FilterChoice>
                  {roots.map(({ root }) => (
                    <FilterChoice
                      key={root.id}
                      active={rootId === root.id}
                      onClick={() => onRootIdChange(root.id)}
                    >
                      {root.label}
                    </FilterChoice>
                  ))}
                </div>
              </FilterSection>

              <FilterSection label="検索対象">
                <FilterToggle
                  active={metaSearch}
                  onClick={() => onMetaSearchChange(!metaSearch)}
                  label="生成情報も検索"
                  description="プロンプト・モデル名なども対象"
                />
              </FilterSection>
            </>
          )}
        </FilterMenu>

        <SortMenu
          options={FILE_SORTS}
          value={sort}
          onChange={onSortChange}
          dir={dir}
          onToggleDir={onToggleDir}
        />

        <div className="ml-auto flex flex-none items-center gap-3">
          <ToolbarCount total={feed.total} unit="ファイル" />
          <ThumbnailToggle visible={thumbnailsVisible} onToggle={onToggleThumbnails} />
          <ViewModeSegment value={viewMode} onChange={onViewModeChange} />
        </div>
      </ToolbarShell>

      {bench && (
        <p
          className="m-0 flex-none bg-[var(--surface)] px-4 py-1.5 text-xs text-[var(--warning)] lg:px-6"
          role="note"
        >
          ベンチモード: 合成ファイル（Tauri 未接続）。<code>window.__worksBench.start()</code>{' '}
          でスクロール性能を計測できます。
        </p>
      )}

      {feed.status === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-5 py-10 text-center">
          <p className="text-base font-semibold">ファイルを取得できませんでした</p>
          <p className="m-0 text-xs text-muted-foreground">{feed.error}</p>
          <Button size="sm" onClick={feed.retry}>
            再試行
          </Button>
        </div>
      ) : (
        <FileGrid {...gridProps} />
      )}
    </section>
  )
}
