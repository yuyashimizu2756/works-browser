import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FolderPlus, ImageOff, Inbox, SearchX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToastMessage, pushToast, removeToast, updateToast } from '@/components/ToastStack'
import type {
  FileKindFilter,
  FileSortKey,
  FileSummary,
  MoveOutcome,
  MovePlan,
  MoveProgress,
  RootInfo,
  SmartFolder,
  SortKey,
  Tag,
  WatchChanged,
  WorkKindFilter,
  WorkMark,
  WorkSummary,
} from '../api'
import { api } from '../api'
import { canCompare } from '../lib/compare'
import { describeError, formatBytes, formatCount } from '../lib/format'
import { isEditableTarget, matchesShortcut } from '../lib/shortcuts'
import {
  defaultDirFor,
  defaultFileDirFor,
  flipDir,
  writeSortPreference,
} from './sortPrefs'
import type { SortDir } from './sortPrefs'
import {
  buildSmartFolderQuery,
  parseSmartFolderQuery,
  smartFolderMatches,
  stringifySmartFolderQuery,
} from './smartFolders'
import { marqueeSelect, selectAllWorks, selectedBytes as sumSelectedBytes, selectWorks } from '../lib/selection'
import type { SelectModifiers } from '../lib/selection'
import type { LibraryViewMode } from '../lib/viewMode'
import { compareItemsFromFiles, compareItemsFromWorks } from './compareItems'
import type { CompareItem } from './compareItems'
import { focusAdjacentItem, focusedWorkId } from './listFocus'
import { tagData } from './tagData'
import { useLibraryShortcuts } from './useLibraryShortcuts'
import { useListShortcuts } from './useListShortcuts'
import { RootsSidebar } from './RootsSidebar'
import { EmptyState } from './EmptyState'
import type { DeleteIntent } from './DeleteFlow'
import type { LibraryFilters } from './libraryFilters'
import { clearWorkFilters, defaultLibraryFilters } from './libraryFilters'
import { TagFilterChips } from './TagFilterChips'
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
import type { WorkPageSource } from './useWorkFeed'
import { useWorkFeed } from './useWorkFeed'
import { applyWatchChanged, clearBadge, pendingBadges } from './watchBadges'
import { WorkGrid } from './WorkGrid'

/** #49: ダイアログは開くまで読み込まない（初期チャンク削減）。 */
const TagEditor = lazy(() =>
  import('./TagEditor').then((module) => ({ default: module.TagEditor })),
)
const BulkMarkDialog = lazy(() =>
  import('./BulkMarkDialog').then((module) => ({ default: module.BulkMarkDialog })),
)
/** ファイルモード（Alt+2）は選ばれたときだけ読み込む。 */
const FilesView = lazy(() =>
  import('./FilesView').then((module) => ({ default: module.FilesView })),
)
/** タイムライン（Ctrl+Shift+T・#81）も選ばれたときだけ読み込む。 */
const TimelineView = lazy(() =>
  import('./TimelineView').then((module) => ({ default: module.TimelineView })),
)
/** #71: 比較ビューは開いたときだけ読み込む。 */
const CompareView = lazy(() =>
  import('./CompareView').then((module) => ({ default: module.CompareView })),
)
/** #57: 移動の確認・進捗・結果と Undo（5 秒）は必要時のみ読み込む。 */
const MoveConfirmDialog = lazy(() =>
  import('./MoveFlow').then((module) => ({ default: module.MoveConfirmDialog })),
)
const MoveReportDialog = lazy(() =>
  import('./MoveFlow').then((module) => ({ default: module.MoveReportDialog })),
)
/** #57 / #115: Undo トーストの中身も必要時のみ読み込む。 */
const MoveUndoToast = lazy(() =>
  import('./MoveFlow').then((module) => ({ default: module.MoveUndoToast })),
)

const KIND_FILTERS: { key: WorkKindFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'video', label: '動画あり' },
  { key: 'image', label: '画像のみ' },
]

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'mtime', label: '更新日' },
  { key: 'created', label: '追加日' },
  { key: 'title', label: '名前' },
  { key: 'size', label: 'サイズ' },
  { key: 'files', label: 'ファイル数' },
  { key: 'last_opened', label: '最近見た' },
  { key: 'open_count', label: 'よく見る' },
]

type Props = {
  roots: RootInfo[]
  rootAccents: Map<number, string>
  /** #71: 動画カードの Space 用に、再生を始めるファイルを指定できる。 */
  onOpenWork: (work: WorkSummary, startFileId?: number | null) => void
  /** ファイルモードのダブルクリック（#5 のプレビューへ。#21 では作品詳細の仮画面）。 */
  onOpenFile: (file: FileSummary) => void
  onOpenRoots: () => void
  /** #100: `?q=` / 空状態のショット用の初期検索語。 */
  initialSearch?: string
  /**
   * #120: 作品詳細から戻ったときに復元する絞り込み。
   * 未指定なら `initialSearch` と保存済みの並び順から始める。
   */
  initialFilters?: LibraryFilters
  /** #120: 離脱時に備えて、いまの絞り込みを App（履歴）へ知らせる。 */
  onFiltersChange?: (filters: LibraryFilters) => void
  /** #55: サイドバーでルートを追加/変更/削除したときに親へ知らせる（roots を読み直す）。 */
  onRootsChanged?: () => void
  refreshToken: number
  /** ベンチモードでは Tauri の代わりに合成データを読む。 */
  source?: WorkPageSource
  fileSource?: FilePageSource
  bench: boolean
  benchCount: number
  /** `works` | `files`（#21）。 */
  viewMode: LibraryViewMode
  /** #88: `Alt+1` / `Alt+2` / `Alt+3` の切り替え先を親（App）へ返す。 */
  onViewModeChange: (mode: LibraryViewMode) => void
  /** #21: `Ctrl+Shift+H` のサムネ表示トグル。 */
  onToggleThumbnails: () => void
  /** `useThumbnailVisible` の値。false ならサムネを一切読まず、コンパクトリストにする。 */
  thumbnailsVisible: boolean
  /** #22: シールド中は比較ビューの画像・動画も描画しない。 */
  shielded?: boolean
  /** 削除後に選択を解除するためのトークン（App が削除成功時に増やす）。 */
  selectionResetToken?: number
  /** 選択作品に対する操作の差し込み口（実装は #6 / 削除 Issue で）。 */
  onDeleteSelected?: (works: WorkSummary[], intent: DeleteIntent) => void
  /** ファイルモードの選択削除（#15）。 */
  onDeleteFiles?: (files: FileSummary[], intent: DeleteIntent) => void
  onTagSelected?: (works: WorkSummary[]) => void
  onRateSelected?: (works: WorkSummary[]) => void
  /** #33: 作品詳細から戻ったときに選択を復元する。 */
  initialSelection?: WorkSummary[]
  /** #33: 離脱時に選択を履歴へ控えるための通知。 */
  onSelectionChange?: (works: WorkSummary[]) => void
}

export function LibraryView({
  roots,
  rootAccents,
  onOpenWork,
  onOpenFile,
  onOpenRoots,
  initialSearch,
  initialFilters,
  onFiltersChange,
  onRootsChanged,
  refreshToken,
  source,
  fileSource,
  bench,
  benchCount,
  viewMode,
  onViewModeChange,
  onToggleThumbnails,
  thumbnailsVisible,
  shielded = false,
  selectionResetToken = 0,
  onDeleteSelected,
  onDeleteFiles,
  onTagSelected,
  onRateSelected,
  initialSelection,
  onSelectionChange,
}: Props) {
  // #120: 戻ってきたときは履歴の写しを、初回は URL の検索語と保存済みの並び順を使う。
  const initial = useMemo(
    () => initialFilters ?? { ...defaultLibraryFilters(), search: initialSearch ?? '' },
    [initialFilters, initialSearch],
  )
  const [search, setSearch] = useState(initial.search)
  const [kind, setKind] = useState<WorkKindFilter>(initial.kind)
  const [rootId, setRootId] = useState<number | null>(initial.rootId)
  // #60: 検索語を生成情報（プロンプト・モデル等）にも当てるか（既定 OFF）
  const [metaSearch, setMetaSearch] = useState(initial.metaSearch)
  const [sort, setSort] = useState<SortKey>(initial.sort)
  // #59: 昇順/降順（キーごとの既定から始め、切り替えたら保存する）
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initial.sortDir)

  const changeSort = useCallback((key: SortKey) => {
    setSort(key)
    setSortDir(defaultDirFor(key))
  }, [])
  const toggleSortDir = useCallback(() => {
    setSortDir((current) => flipDir(current))
  }, [])
  useEffect(() => {
    writeSortPreference(sort, sortDir)
  }, [sort, sortDir])
  // #6: お気に入り・タグの絞り込み
  const [favorite, setFavorite] = useState(initial.favorite)
  const [tagId, setTagId] = useState<number | null>(initial.tagId)
  // #96: 適用中チップにタグ名を出すため、TagFilterChips が読んだ一覧を控える
  const [tags, setTags] = useState<Tag[]>([])
  // #69: 最低評価（1〜5）。スマートフォルダにも保存する
  const [minRating, setMinRating] = useState<number | null>(initial.minRating)
  // #69: 保存したスマートフォルダ（サイドバーの節）
  const [smartFolders, setSmartFolders] = useState<SmartFolder[]>([])
  // #6: タグ・評価を変えたらグリッドを読み直す（件数と並び順に反映する）
  const [marksVersion, setMarksVersion] = useState(0)
  const [tagOpen, setTagOpen] = useState(false)
  const [markOpen, setMarkOpen] = useState(false)
  // #57: 作品カードをルートへドラッグ&ドロップして移動する。
  const [movePlan, setMovePlan] = useState<MovePlan | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveProgress, setMoveProgress] = useState<MoveProgress | null>(null)
  const [moveReport, setMoveReport] = useState<MoveOutcome | null>(null)
  const [moveUndo, setMoveUndo] = useState<{
    id: string
    title: string
    targetLabel: string
  } | null>(null)
  const [moveUndoBusy, setMoveUndoBusy] = useState(false)
  /** ドラッグ中の作品の移動元ルート（同じルートへのドロップは無効）。 */
  const [draggingRootId, setDraggingRootId] = useState<number | null>(null)
  // #63: 監視で増えた件数（root_id → 件数）。起動時に 1 回読み、以降はイベントで更新。
  const [pendingCounts, setPendingCounts] = useState<Map<number, number>>(() => new Map())
  const searchRef = useRef<HTMLInputElement>(null)

  // ファイルモードの絞り込み。モードを切り替えても保つため LibraryView が持つ
  const [fileSearch, setFileSearch] = useState('')
  const [fileKind, setFileKind] = useState<FileKindFilter>('all')
  const [fileRootId, setFileRootId] = useState<number | null>(initial.fileRootId)
  const [fileSort, setFileSort] = useState<FileSortKey>('mtime')
  // #87: ファイルモードの昇順/降順（キーごとの既定から始める）
  const [fileSortDir, setFileSortDir] = useState<SortDir>(() => defaultFileDirFor('mtime'))
  const changeFileSort = useCallback((key: FileSortKey) => {
    setFileSort(key)
    setFileSortDir(defaultFileDirFor(key))
  }, [])
  const toggleFileSortDir = useCallback(() => {
    setFileSortDir((current) => flipDir(current))
  }, [])
  const [fileMetaSearch, setFileMetaSearch] = useState(false)
  const fileSearchRef = useRef<HTMLInputElement>(null)

  // #120: 作品詳細へ移動する直前に App が控えられるよう、最新の絞り込みを写す。
  const filters = useMemo<LibraryFilters>(
    () => ({
      search,
      kind,
      rootId,
      tagId,
      minRating,
      favorite,
      metaSearch,
      sort,
      sortDir,
      fileRootId,
    }),
    [search, kind, rootId, tagId, minRating, favorite, metaSearch, sort, sortDir, fileRootId],
  )
  useEffect(() => {
    onFiltersChange?.(filters)
  }, [filters, onFiltersChange])

  const [selection, setSelection] = useState<Map<number, WorkSummary>>(
    () => new Map((initialSelection ?? []).map((work) => [work.id, work])),
  )
  // #81: 作品 ↔ ファイル ↔ タイムラインを切り替えても、スクロール位置と選択を保つ。
  // スクロールはそれぞれのモードの `scrollTop` を控え、マウント時に戻す。
  const scrollTops = useRef<Partial<Record<LibraryViewMode, number>>>({})
  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.hasAttribute('data-scroll-region')) return
      scrollTops.current[viewMode] = target.scrollTop
    }
    // scroll は bubble しないので capture で拾う
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [viewMode])
  // ファイルモードの選択は FilesView 内にあるため、離れるときに控えて戻す。
  const fileSelectionRef = useRef<FileSummary[]>([])
  const handleFileSelectionChange = useCallback((files: FileSummary[]) => {
    fileSelectionRef.current = files
  }, [])
  const [selectAllBusy, setSelectAllBusy] = useState(false)
  const anchorRef = useRef<number | null>(null)

  const feed = useWorkFeed({
    query: {
      search,
      kind,
      rootId,
      sort,
      dir: sortDir,
      favorite,
      tagId,
      minRating,
      metaQuery: metaSearch ? search : undefined,
    },
    source,
    refreshToken: refreshToken + marksVersion,
  })

  const rootLabels = useMemo(
    () => new Map(roots.map(({ root }) => [root.id, root.label])),
    [roots],
  )
  const rootName = rootId === null ? null : (rootLabels.get(rootId) ?? null)
  const hasFilters =
    search.trim() !== '' ||
    kind !== 'all' ||
    rootId !== null ||
    favorite ||
    tagId !== null ||
    minRating !== null ||
    metaSearch

  // #96: フィルタボタンのバッジと、適用中チップ（検索語は入力欄に出ているので含めない）
  const activeFilterCount =
    (kind !== 'all' ? 1 : 0) +
    (rootId !== null ? 1 : 0) +
    (tagId !== null ? 1 : 0) +
    (minRating !== null ? 1 : 0) +
    (favorite ? 1 : 0) +
    (metaSearch ? 1 : 0)
  const activeTagName = tags.find((tag) => tag.id === tagId)?.name ?? null
  const activeChips: ActiveFilterChip[] = []
  if (kind !== 'all') {
    activeChips.push({
      key: 'kind',
      label: KIND_FILTERS.find((option) => option.key === kind)?.label ?? '種類',
      onRemove: () => setKind('all'),
    })
  }
  if (rootId !== null && rootName) {
    activeChips.push({ key: 'root', label: `ルート: ${rootName}`, onRemove: () => selectRoot(null) })
  }
  if (tagId !== null) {
    activeChips.push({
      key: 'tag',
      label: `タグ: ${activeTagName ?? '選択中'}`,
      onRemove: () => setTagId(null),
    })
  }
  if (minRating !== null) {
    activeChips.push({
      key: 'rating',
      label: `★${minRating} 以上`,
      onRemove: () => setMinRating(null),
    })
  }
  if (favorite) {
    activeChips.push({ key: 'favorite', label: 'お気に入り', onRemove: () => setFavorite(false) })
  }
  if (metaSearch) {
    activeChips.push({
      key: 'meta',
      label: '生成情報も検索',
      onRemove: () => setMetaSearch(false),
    })
  }

  const selectedIds = useMemo(() => new Set(selection.keys()), [selection])
  const selectedWorks = useMemo(() => [...selection.values()], [selection])
  // #33: 画面を離れるときに備えて、いまの選択を App（履歴）へ知らせる
  useEffect(() => {
    onSelectionChange?.(selectedWorks)
  }, [onSelectionChange, selectedWorks])
  const selectedBytes = useMemo(() => sumSelectedBytes(selection), [selection])

  // #115: 文言だけの通知は共通スタックへ積む。同じ key は置き換え、2.8 秒で消える。
  const toastRef = useRef<number | null>(null)
  const showToast = useCallback((message: string) => {
    toastRef.current = pushToast({
      key: 'library-toast',
      content: <ToastMessage message={message} />,
      duration: 2800,
    })
  }, [])

  // 画面を離れたら通知も消す（従来はアンマウントで消えていた）。
  useEffect(() => {
    return () => {
      if (toastRef.current !== null) removeToast(toastRef.current)
    }
  }, [])

  // -------------------------------------------------------------------------
  // #71: 比較ビューとキーボード操作
  // -------------------------------------------------------------------------

  const [compareItems, setCompareItems] = useState<CompareItem[] | null>(null)

  /** 選択（チェックボックス）から 2〜4 枚を比較する。 */
  const openCompareForWorks = useCallback(() => {
    if (!canCompare(selectedWorks.length)) {
      showToast('比較する作品を 2〜4 件選んでください')
      return
    }
    setCompareItems(compareItemsFromWorks(selectedWorks))
  }, [selectedWorks, showToast])

  const openCompareForFiles = useCallback(
    (files: FileSummary[]) => {
      if (!canCompare(files.length)) {
        showToast('比較するファイルを 2〜4 件選んでください')
        return
      }
      setCompareItems(compareItemsFromFiles(files))
    },
    [showToast],
  )

  /** キーボード評価 / お気に入りの対象（フォーカス中の作品 → 選択 1〜4 件）。 */
  const keyboardTargetIds = useCallback((): number[] => {
    const focused = focusedWorkId()
    if (focused !== null) return [focused]
    if (selectedWorks.length > 0 && selectedWorks.length <= 4) {
      return selectedWorks.map((work) => work.id)
    }
    return []
  }, [selectedWorks])

  const applyMarkChange = useCallback(
    async (
      workIds: number[],
      change: (mark: WorkMark) => { favorite: boolean; rating: number | null; note?: string | null },
    ) => {
      await Promise.all(
        workIds.map(async (workId) => {
          const mark = await tagData().getWorkMark(workId)
          await tagData().setWorkMark(workId, change(mark))
        }),
      )
    },
    [],
  )

  const handleKeyboardRate = useCallback(
    (rating: number | null) => {
      const ids = keyboardTargetIds()
      if (ids.length === 0) {
        showToast('評価する作品にフォーカスしてください（j / k）')
        return
      }
      // #14: ベンチ / デモは実在する作品 ID へ保存しない
      if (bench) {
        showToast('ベンチモードでは保存されません')
        return
      }
      void applyMarkChange(ids, (mark) => ({
        favorite: mark.favorite,
        rating,
        note: mark.note,
      }))
        .then(() =>
          showToast(
            rating === null
              ? '未評価に戻しました'
              : `${ids.length > 1 ? `${ids.length} 件を ` : ''}★${rating} に評価しました`,
          ),
        )
        .catch((cause: unknown) =>
          showToast(`評価を保存できませんでした: ${describeError(cause)}`),
        )
    },
    [applyMarkChange, bench, keyboardTargetIds, showToast],
  )

  const handleKeyboardFavorite = useCallback(() => {
    const ids = keyboardTargetIds()
    if (ids.length === 0) {
      showToast('お気に入りを切り替える作品にフォーカスしてください（j / k）')
      return
    }
    // #14: ベンチ / デモは実在する作品 ID へ保存しない
    if (bench) {
      showToast('ベンチモードでは保存されません')
      return
    }
    void applyMarkChange(ids, (mark) => ({
      favorite: !mark.favorite,
      rating: mark.rating,
      note: mark.note,
    }))
      .then(() => showToast('お気に入りを切り替えました'))
      .catch((cause: unknown) =>
        showToast(`お気に入りを保存できませんでした: ${describeError(cause)}`),
      )
  }, [applyMarkChange, bench, keyboardTargetIds, showToast])

  const handleFocusMove = useCallback(
    (delta: 1 | -1) => {
      focusAdjacentItem({
        // タイムラインも作品カード（#81）
        selector: viewMode === 'files' ? '[data-file-id]' : '[data-work-id]',
        delta,
        onBoundary: viewMode === 'works' ? feed.loadMore : undefined,
      })
    },
    [feed.loadMore, viewMode],
  )

  /** Space: フォーカス中の動画を開いて再生する（詳細 → ライトボックスが自動再生）。 */
  const handleTogglePlay = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    if (viewMode === 'files') {
      const tile = active?.closest<HTMLElement>('[data-file-id]') ?? null
      if (!tile || tile.dataset.fileKind !== 'video') return
      tile.click()
      return
    }
    const focused = focusedWorkId()
    if (focused === null) return
    const work = feed.works.find((item) => item.id === focused)
    if (!work || work.kind === 'image' || work.cover_file_id === null) return
    onOpenWork(work, work.cover_file_id)
  }, [feed.works, onOpenWork, viewMode])

  /** Enter: フォーカス中のカードを開く（カード自身の Enter が先に処理する場合を除く）。 */
  const handleShortcutOpen = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    active?.closest<HTMLElement>('[data-work-id], [data-file-id]')?.click()
  }, [])

  useListShortcuts({
    onFocusMove: handleFocusMove,
    onRate: handleKeyboardRate,
    onFavorite: handleKeyboardFavorite,
    onTogglePlay: handleTogglePlay,
    onOpen: handleShortcutOpen,
  })

  const clearSelection = useCallback(() => {
    setSelection(new Map())
    anchorRef.current = null
  }, [])

  // 削除が完了したら選択を解除する（消えた作品の id を残さない）。
  useEffect(() => {
    if (selectionResetToken > 0) clearSelection()
  }, [selectionResetToken, clearSelection])

  const handleToggle = useCallback(
    (work: WorkSummary, modifiers: SelectModifiers) => {
      const next = selectWorks(selection, work, modifiers, feed.works, anchorRef.current)
      setSelection(next.selection)
      anchorRef.current = next.anchorId
    },
    [feed.works, selection],
  )

  const handleMarqueeSelect = useCallback(
    (picked: WorkSummary[], additive: boolean) => {
      setSelection(marqueeSelect(selection, picked, additive))
      if (picked.length > 0) anchorRef.current = picked[picked.length - 1].id
    },
    [selection],
  )

  // #55: サイドバーからのルート操作（showToast の定義後に置く）
  const handleRescanRoot = useCallback(
    async (id: number) => {
      showToast('再スキャンしています…')
      try {
        await api.scanRoot(id)
        onRootsChanged?.()
        showToast('再スキャンが完了しました')
      } catch (cause) {
        showToast(`再スキャンに失敗しました: ${describeError(cause)}`)
      }
    },
    [onRootsChanged, showToast],
  )
  const handleToggleRoot = useCallback(
    async (id: number, enabled: boolean) => {
      try {
        await api.updateRoot(id, { enabled })
        onRootsChanged?.()
      } catch (cause) {
        showToast(`ルートの変更に失敗しました: ${describeError(cause)}`)
      }
    },
    [onRootsChanged, showToast],
  )
  const handleDeleteRoot = useCallback(
    async (id: number) => {
      const target = roots.find((info) => info.root.id === id)
      const label = target?.root.label ?? 'このルート'
      const ok = window.confirm(
        `「${label}」を一覧から削除しますか？\n（ファイルは削除されません。索引だけ消します）`,
      )
      if (!ok) return
      try {
        await api.deleteRoot(id)
        if (rootId === id) setRootId(null)
        onRootsChanged?.()
      } catch (cause) {
        showToast(`削除に失敗しました: ${describeError(cause)}`)
      }
    },
    [roots, rootId, onRootsChanged, showToast],
  )

  // -------------------------------------------------------------------------
  // #63: 新着バッジ（監視で増えた件数）
  // -------------------------------------------------------------------------

  // 起動時に累計を 1 回読み、以降は `watch://changed` の増分で更新する。
  useEffect(() => {
    if (bench) return
    let disposed = false
    let unlisten: (() => void) | null = null

    void api
      .watchPending()
      .then((rows) => {
        if (!disposed) setPendingCounts(pendingBadges(rows))
      })
      .catch(() => {
        // ブラウザ単体（Tauri なし）では IPC が無いので無視
      })

    void listen<WatchChanged>('watch://changed', (event) => {
      if (!disposed) setPendingCounts((current) => applyWatchChanged(current, event.payload))
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // 同上
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [bench])

  /** ルートを開いたら新着バッジを消す（Rust 側の累計もクリア）。 */
  const selectRoot = useCallback(
    (next: number | null) => {
      setRootId(next)
      setFileRootId(next)
      if (next === null) return
      setPendingCounts((current) => clearBadge(current, next))
      if (bench) return
      void api.clearWatchPending(next).catch(() => {
        // バッジが消えるだけなので失敗しても操作は続ける
      })
    },
    [bench],
  )

  // #88: ルート絞り込み・表示モード・サムネ表示は 1 つのハンドラで受ける
  //（以前はこの画面と `useLibraryShortcuts` が同じ `Ctrl+1` に反応していた）。
  useLibraryShortcuts({
    enabled: true,
    onViewModeChange,
    onToggleThumbnails,
    onSelectRoot: (index) => {
      if (index === null) {
        selectRoot(null)
        return
      }
      const target = roots[index]
      if (target) selectRoot(target.root.id)
    },
  })

  // -------------------------------------------------------------------------
  // #69: スマートフォルダ（保存検索）
  // -------------------------------------------------------------------------

  const reloadSmartFolders = useCallback(async () => {
    if (bench) return
    try {
      setSmartFolders(await api.listSmartFolders())
    } catch {
      // ブラウザ単体（Tauri なし）や読み込み失敗では、節が出ないだけ
    }
  }, [bench])

  useEffect(() => {
    void reloadSmartFolders()
  }, [reloadSmartFolders])

  /** いまの絞り込み条件（保存と「適用中」の判定に使う）。 */
  const currentSmartQuery = useMemo(
    () =>
      buildSmartFolderQuery({
        search,
        kind,
        rootId,
        tagId,
        minRating,
        favorite,
        metaSearch,
        sort,
        dir: sortDir,
      }),
    [search, kind, rootId, tagId, minRating, favorite, metaSearch, sort, sortDir],
  )

  /** いまの条件と完全に一致するスマートフォルダ（サイドバーの強調に使う）。 */
  const activeSmartFolder = useMemo(
    () =>
      smartFolders.find((folder) =>
        smartFolderMatches(parseSmartFolderQuery(folder.query_json), currentSmartQuery),
      ) ?? null,
    [smartFolders, currentSmartQuery],
  )

  /** 保存済みの条件を適用する。 */
  const applySmartFolder = useCallback(
    (folder: SmartFolder) => {
      const query = parseSmartFolderQuery(folder.query_json)
      setSearch(query.search)
      setKind(query.kind)
      selectRoot(query.rootId)
      setTagId(query.tagId)
      setMinRating(query.minRating)
      setFavorite(query.favorite)
      setMetaSearch(query.metaSearch)
      setSort(query.sort)
      setSortDir(query.dir)
      clearSelection()
    },
    [clearSelection, selectRoot],
  )

  const saveSmartFolder = useCallback(
    async (name: string) => {
      if (bench) {
        showToast('ベンチモードでは保存できません')
        return
      }
      try {
        await api.saveSmartFolder(name, stringifySmartFolderQuery(currentSmartQuery))
        await reloadSmartFolders()
        showToast(`スマートフォルダ「${name}」を保存しました`)
      } catch (cause) {
        showToast(`保存できませんでした: ${describeError(cause)}`)
      }
    },
    [bench, currentSmartQuery, reloadSmartFolders, showToast],
  )

  const renameSmartFolder = useCallback(
    async (id: number, name: string) => {
      if (bench) {
        showToast('ベンチモードでは変更できません')
        return
      }
      try {
        await api.renameSmartFolder(id, name)
        await reloadSmartFolders()
        showToast(`スマートフォルダの名前を「${name}」に変更しました`)
      } catch (cause) {
        showToast(`名前を変更できませんでした: ${describeError(cause)}`)
      }
    },
    [bench, reloadSmartFolders, showToast],
  )

  const deleteSmartFolder = useCallback(
    async (folder: SmartFolder) => {
      if (bench) {
        showToast('ベンチモードでは削除できません')
        return
      }
      const ok = window.confirm(
        `「${folder.name}」を削除しますか？\n（保存した条件だけを消します。作品は削除されません）`,
      )
      if (!ok) return
      try {
        await api.deleteSmartFolder(folder.id)
        await reloadSmartFolders()
        showToast(`「${folder.name}」を削除しました`)
      } catch (cause) {
        showToast(`削除できませんでした: ${describeError(cause)}`)
      }
    },
    [bench, reloadSmartFolders, showToast],
  )

  // -------------------------------------------------------------------------
  // #57: ドラッグ&ドロップで作品を別ルートへ移動
  // -------------------------------------------------------------------------

  const handleDragWorkStart = useCallback((work: WorkSummary) => {
    setDraggingRootId(work.root_id)
  }, [])
  const handleDragWorkEnd = useCallback(() => setDraggingRootId(null), [])

  /** ドロップ時に移動計画を作り、確認ダイアログを開く（実ファイルにはまだ触れない）。 */
  const handleDropWork = useCallback(
    async (workId: number, targetRootId: number) => {
      setDraggingRootId(null)
      if (bench) {
        showToast('ベンチモードでは移動できません')
        return
      }
      setMoveReport(null)
      setMoveProgress(null)
      try {
        const plan = await api.inspectMove(workId, targetRootId)
        setMovePlan(plan)
      } catch (cause) {
        showToast(`移動できません: ${describeError(cause)}`)
      }
    },
    [bench, showToast],
  )

  useEffect(() => {
    if (!moving) return
    let disposed = false
    let unlisten: (() => void) | null = null
    void listen<MoveProgress>('move://progress', (event) => {
      if (!disposed) setMoveProgress(event.payload)
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // ブラウザ単体（Tauri なし）ではイベントが無いので無視
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [moving])

  const handleCancelMove = useCallback(() => {
    if (bench) return
    void api.cancelMove().catch(() => {
      // 実行していなければ false が返るだけ
    })
  }, [bench])

  const confirmMove = useCallback(async () => {
    const plan = movePlan
    if (!plan || moving) return
    setMoving(true)
    setMoveProgress({ moved_bytes: 0, total_bytes: plan.total_bytes })
    try {
      const outcome = await api.moveWork(plan.work_id, plan.target_root_id, 'rename')
      setMovePlan(null)
      if (outcome.moved) {
        // 移動した作品は選択から外す（別ルートへ移った id を残さない）。
        setSelection((current) => {
          if (!current.has(outcome.work_id)) return current
          const next = new Map(current)
          next.delete(outcome.work_id)
          return next
        })
        showToast(`「${outcome.new_title}」を「${plan.target_root_label}」へ移動しました`)
        if (outcome.undo_id) {
          setMoveUndo({
            id: outcome.undo_id,
            title: outcome.new_title,
            targetLabel: plan.target_root_label,
          })
        }
        onRootsChanged?.()
      }
      if (!outcome.moved || outcome.failures.length > 0) setMoveReport(outcome)
    } catch (cause) {
      setMovePlan(null)
      showToast(`移動できませんでした: ${describeError(cause)}`)
    } finally {
      setMoving(false)
      setMoveProgress(null)
    }
  }, [bench, movePlan, moving, onRootsChanged, showToast])

  const handleUndoMove = useCallback(async () => {
    if (!moveUndo || moveUndoBusy) return
    setMoveUndoBusy(true)
    try {
      await api.undoMove(moveUndo.id)
      setMoveUndo(null)
      showToast(`「${moveUndo.title}」を元の場所へ戻しました`)
      onRootsChanged?.()
    } catch (cause) {
      setMoveUndo(null)
      showToast(`移動を取り消せませんでした: ${describeError(cause)}`)
    } finally {
      setMoveUndoBusy(false)
    }
  }, [moveUndo, moveUndoBusy, onRootsChanged, showToast])

  // #115: 移動の Undo は moveUndo / moveUndoBusy が変わっても同じトーストを
  // 差し替えるだけにして、5 秒タイマーを張り直さない。
  const moveToastRef = useRef<{ id: number; moveId: string } | null>(null)

  useEffect(() => {
    const current = moveToastRef.current
    if (!moveUndo) {
      if (current) {
        removeToast(current.id)
        moveToastRef.current = null
      }
      return
    }

    const content = (
      <Suspense fallback={null}>
        <MoveUndoToast
          moveId={moveUndo.id}
          title={moveUndo.title}
          targetLabel={moveUndo.targetLabel}
          busy={moveUndoBusy}
          onUndo={() => void handleUndoMove()}
          onExpire={() => setMoveUndo(null)}
        />
      </Suspense>
    )

    if (current && current.moveId === moveUndo.id) {
      updateToast(current.id, { content })
      return
    }
    if (current) removeToast(current.id)
    const id = pushToast({
      key: `move-undo:${moveUndo.id}`,
      content,
      width: 'min(92vw,460px)',
      onEvict: () => setMoveUndo(null),
    })
    moveToastRef.current = { id, moveId: moveUndo.id }
  }, [moveUndo, moveUndoBusy, handleUndoMove])

  useEffect(() => {
    return () => {
      if (moveToastRef.current) {
        removeToast(moveToastRef.current.id)
        moveToastRef.current = null
      }
    }
  }, [])

  const handleSelectAll = useCallback(async () => {
    if (selectAllBusy || feed.total === 0) return
    setSelectAllBusy(true)
    showToast('全件を読み込み中…')
    try {
      const all = await feed.loadAll()
      setSelection(selectAllWorks(all))
      anchorRef.current = all[0]?.id ?? null
      showToast(`${formatCount(all.length)} 件を選択しました`)
    } catch (cause) {
      showToast(`全選択に失敗しました: ${describeError(cause)}`)
    } finally {
      setSelectAllBusy(false)
    }
  }, [feed.total, feed.loadAll, selectAllBusy, showToast])

  const handleDelete = useCallback(
    (permanent = false) => {
      if (selectedWorks.length === 0) return
      if (onDeleteSelected) onDeleteSelected(selectedWorks, { permanent })
      else showToast('削除は未実装です（別 Issue でゴミ箱移動・確認・Undo を実装予定）')
    },
    [onDeleteSelected, selectedWorks, showToast],
  )
  const handleTag = () => {
    // #14: ベンチ / デモはタグ編集を開かない（保存しない）
    if (bench) {
      showToast('ベンチモードでは保存されません')
      return
    }
    if (onTagSelected) onTagSelected(selectedWorks)
    else if (selectedWorks.length > 0) setTagOpen(true)
  }
  const handleRate = () => {
    // #14: ベンチ / デモは一括評価を開かない（保存しない）
    if (bench) {
      showToast('ベンチモードでは保存されません')
      return
    }
    if (onRateSelected) onRateSelected(selectedWorks)
    else if (selectedWorks.length > 0) setMarkOpen(true)
  }
  const handleMarksChanged = useCallback(() => {
    setMarksVersion((value) => value + 1)
  }, [])

  const resetFilters = () => {
    // #120: 空検索・「すべて」へ戻した状態がそのまま履歴にも残るよう、
    // 個別の setter ではなく同じ純関数で次の値を組み立てる。
    const next = clearWorkFilters(filters)
    setSearch(next.search)
    setKind(next.kind)
    setRootId(next.rootId)
    setFavorite(next.favorite)
    setTagId(next.tagId)
    setMinRating(next.minRating)
    setMetaSearch(next.metaSearch)
  }

  // `/` 検索フォーカス、Ctrl+A 全選択、Esc 選択解除。入力中のキーは奪わない
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 先に処理したリスナー（#88 のルート絞り込み・表示モードなど）のキーは奪わない
      if (event.defaultPrevented) return

      const typing = isEditableTarget(event.target)

      if (document.querySelector('[role="dialog"]')) return

      if (
        event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'a' &&
        !typing &&
        viewMode === 'works'
      ) {
        event.preventDefault()
        void handleSelectAll()
        return
      }
      if (event.key === 'Escape' && !typing && viewMode === 'works') {
        clearSelection()
        return
      }
      if (
        (matchesShortcut('delete', event) || matchesShortcut('delete-permanent', event)) &&
        !typing &&
        viewMode === 'works' &&
        selection.size > 0
      ) {
        event.preventDefault()
        handleDelete(event.shiftKey)
        return
      }
      if (!matchesShortcut('search', event)) return
      if (typing) return
      event.preventDefault()
      if (viewMode === 'works') searchRef.current?.focus()
      else fileSearchRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleSelectAll, clearSelection, viewMode, handleDelete])

  const empty: ReactNode = hasFilters ? (
    <EmptyState
      icon={SearchX}
      title="条件に一致する作品がありません"
      description="検索語や種類・ルートの絞り込みを変えてみてください。"
      action={{ label: '条件をクリア', onClick: resetFilters }}
    />
  ) : roots.length === 0 ? (
    <EmptyState
      icon={FolderPlus}
      title="まだ作品がありません"
      description="走査ルートを追加して「走査」を実行すると、作品がカードで並びます。"
      action={{ label: '走査ルートを追加', onClick: onOpenRoots }}
    />
  ) : (
    <EmptyState
      icon={Inbox}
      title="索引された作品がありません"
      description="「走査ルート」から対象フォルダを走査してください。"
      action={{ label: '走査ルートを開く', onClick: onOpenRoots }}
    />
  )

  /**
   * #100: サムネイル表示中なのに、読み込んだ作品に 1 枚もサムネイルが無い
   * （＝未生成）ときだけ、説明と次の行動を 1 つ出す。生成が進めば消える。
   */
  const thumbnailsPending =
    thumbnailsVisible &&
    feed.status === 'ready' &&
    feed.works.length > 0 &&
    feed.works.every((work) => work.cover_thumb === null)
  const handleGenerateThumbs = useCallback(() => {
    if (bench) {
      showToast('ベンチモードではサムネイルを生成できません')
      return
    }
    void api
      .generateThumbs(500)
      .then(() => onRootsChanged?.())
      .catch((cause: unknown) =>
        showToast(`サムネイルを生成できませんでした: ${describeError(cause)}`),
      )
  }, [bench, onRootsChanged, showToast])

  const resetKey = `${search.trim()}\u0000${kind}\u0000${rootId ?? ''}\u0000${sort}\u0000${sortDir}\u0000${
    favorite ? 'fav' : ''
  }\u0000${tagId ?? ''}\u0000${minRating ?? ''}\u0000${metaSearch ? 'meta' : ''}`

  if (viewMode === 'timeline') {
    return (
      <>
        <Suspense fallback={null}>
          <TimelineView
            rootLabels={rootLabels}
            rootAccents={rootAccents}
            source={source}
            refreshToken={refreshToken}
            thumbnailsVisible={thumbnailsVisible}
            onToggleThumbnails={onToggleThumbnails}
            bench={bench}
            selectedIds={selectedIds}
            onOpenWork={onOpenWork}
            onToggle={handleToggle}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            restoreScrollTop={scrollTops.current.timeline}
          />
        </Suspense>
      </>
    )
  }

  if (viewMode === 'files') {
    return (
      <>
        <Suspense fallback={null}>
          <FilesView
            roots={roots}
            rootAccents={rootAccents}
            source={fileSource}
            refreshToken={refreshToken}
            thumbnailsVisible={thumbnailsVisible}
            onToggleThumbnails={onToggleThumbnails}
            bench={bench}
            searchRef={fileSearchRef}
            search={fileSearch}
            onSearchChange={setFileSearch}
            kind={fileKind}
            onKindChange={setFileKind}
            rootId={fileRootId}
            onRootIdChange={setFileRootId}
            sort={fileSort}
            onSortChange={changeFileSort}
            dir={fileSortDir}
            onToggleDir={toggleFileSortDir}
            metaSearch={fileMetaSearch}
            onMetaSearchChange={setFileMetaSearch}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
            onOpenFile={onOpenFile}
            onOpenRoots={onOpenRoots}
            onCompareSelected={openCompareForFiles}
            selectionResetToken={selectionResetToken}
            onDeleteSelected={onDeleteFiles}
            initialSelection={fileSelectionRef.current}
            onSelectionChange={handleFileSelectionChange}
            restoreScrollTop={scrollTops.current.files}
          />
        </Suspense>
        {compareItems && (
          <Suspense fallback={null}>
            <CompareView
              items={compareItems}
              bench={bench}
              shielded={shielded}
              onClose={() => setCompareItems(null)}
            />
          </Suspense>
        )}
      </>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* #55: ルート一覧サイドバー。クリックで本画面の一覧を絞り込む */}
      <RootsSidebar
        roots={roots}
        rootAccents={rootAccents}
        selectedRootId={rootId}
        onSelect={selectRoot}
        pendingCounts={pendingCounts}
        onAddRoot={onOpenRoots}
        onFocusFilters={() => searchRef.current?.focus()}
        onRescan={(id) => void handleRescanRoot(id)}
        onToggleEnabled={(id, enabled) => void handleToggleRoot(id, enabled)}
        onDelete={(id) => void handleDeleteRoot(id)}
        draggingRootId={draggingRootId}
        moveBusy={moving}
        onDropWork={(workId, targetRootId) => void handleDropWork(workId, targetRootId)}
        smartFolders={smartFolders}
        activeSmartFolderId={activeSmartFolder?.id ?? null}
        activeSmartFolderCount={activeSmartFolder ? feed.total : null}
        onSaveSmartFolder={(name) => void saveSmartFolder(name)}
        onSelectSmartFolder={applySmartFolder}
        onRenameSmartFolder={(id, name) => void renameSmartFolder(id, name)}
        onDeleteSmartFolder={(folder) => void deleteSmartFolder(folder)}
      />
      <section className="flex min-h-0 flex-1 flex-col" aria-label="作品ライブラリ">
      {selection.size > 0 && (
        <div
          className="flex flex-none flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-4 py-2 lg:px-6"
          role="region"
          aria-label="選択中の作品"
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
            <Button
              variant="ghost"
              size="xs"
              onClick={openCompareForWorks}
              disabled={!canCompare(selection.size)}
              title="選択した 2〜4 件を並べて比較（#71）"
            >
              比較
            </Button>
            <Button variant="destructive" size="xs" onClick={() => handleDelete(false)}>
              削除
            </Button>
            <Button variant="ghost" size="xs" onClick={handleTag}>
              タグ
            </Button>
            <Button variant="ghost" size="xs" onClick={handleRate}>
              評価
            </Button>
            <Button variant="ghost" size="xs" onClick={clearSelection}>
              選択解除
            </Button>
          </div>
        </div>
      )}

      <ToolbarShell
        label="ライブラリのツールバー"
        chips={<FilterChipBar chips={activeChips} onClear={resetFilters} />}
      >
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          onEscape={clearSelection}
          inputRef={searchRef}
          placeholder="タイトル・パスで検索"
          ariaLabel="作品を検索"
          searching={feed.isSearching}
          dataAttr={{ 'data-work-search': true }}
        />

        <FilterMenu count={activeFilterCount} onClear={resetFilters}>
          {() => (
            <>
              <FilterSection label="種類">
                <div className="flex flex-wrap gap-1.5">
                  {KIND_FILTERS.map((option) => (
                    <FilterChoice
                      key={option.key}
                      active={option.key === kind}
                      onClick={() => setKind(option.key)}
                    >
                      {option.label}
                    </FilterChoice>
                  ))}
                </div>
              </FilterSection>

              <FilterSection label="ルート">
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto pr-1">
                  <FilterChoice active={rootId === null} onClick={() => selectRoot(null)}>
                    すべて
                  </FilterChoice>
                  {roots.map(({ root, works }) => (
                    <FilterChoice
                      key={root.id}
                      active={rootId === root.id}
                      onClick={() => selectRoot(root.id)}
                    >
                      {root.label}
                      <span className="text-xs opacity-70 tabular-nums">
                        {formatCount(works)}
                      </span>
                    </FilterChoice>
                  ))}
                </div>
              </FilterSection>

              <FilterSection label="タグ">
                <TagFilterChips
                  tagId={tagId}
                  onChange={setTagId}
                  onTagsChange={setTags}
                  refreshToken={refreshToken + marksVersion}
                  showLabel={false}
                />
              </FilterSection>

              <FilterSection label="評価">
                <div className="flex flex-wrap gap-1.5">
                  <FilterChoice active={minRating === null} onClick={() => setMinRating(null)}>
                    指定なし
                  </FilterChoice>
                  {[3, 4, 5].map((rating) => (
                    <FilterChoice
                      key={rating}
                      active={minRating === rating}
                      onClick={() => setMinRating(rating)}
                    >
                      ★{rating} 以上
                    </FilterChoice>
                  ))}
                </div>
              </FilterSection>

              <FilterSection label="状態">
                <FilterToggle
                  active={favorite}
                  onClick={() => setFavorite((value) => !value)}
                  label="お気に入り"
                  description="お気に入りの作品だけ表示"
                />
                <FilterToggle
                  active={metaSearch}
                  onClick={() => setMetaSearch((value) => !value)}
                  label="生成情報も検索"
                  description="プロンプト・モデル名なども対象"
                />
              </FilterSection>
            </>
          )}
        </FilterMenu>

        <SortMenu
          options={SORTS}
          value={sort}
          onChange={changeSort}
          dir={sortDir}
          onToggleDir={toggleSortDir}
        />

        <div className="ml-auto flex flex-none items-center gap-3">
          <ToolbarCount total={feed.total} unit="作品" />
          <ThumbnailToggle visible={thumbnailsVisible} onToggle={onToggleThumbnails} />
          <ViewModeSegment value={viewMode} onChange={onViewModeChange} />
        </div>
      </ToolbarShell>

      {bench && (
        <p
          className="m-0 flex-none bg-[var(--surface)] px-4 py-1.5 text-xs text-[var(--warning)] lg:px-6"
          role="note"
        >
          ベンチモード: 合成 {formatCount(benchCount)} 件（Tauri 未接続）。{' '}
          <code>window.__worksBench.start()</code> でスクロール性能を計測できます。
        </p>
      )}

      {feed.status === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-5 py-10 text-center">
          <p className="text-base font-semibold">作品を取得できませんでした</p>
          <p className="m-0 text-xs text-muted-foreground">{feed.error}</p>
          <Button size="sm" onClick={feed.retry}>
            再試行
          </Button>
        </div>
      ) : (
        <>
          {thumbnailsPending && (
            <div className="flex-none px-6 pt-4" data-thumbnails-pending>
              <EmptyState
                variant="notice"
                icon={ImageOff}
                title="サムネイルはまだ生成されていません"
                description="画像を表示すると作品を見分けやすくなります。生成は表示中に自動で進みます。"
                action={{ label: 'サムネイルを生成', onClick: handleGenerateThumbs }}
              />
            </div>
          )}
          <WorkGrid
            works={feed.works}
            total={feed.total}
            hasMore={feed.hasMore}
            loading={feed.status === 'loading'}
            onLoadMore={feed.loadMore}
            onOpen={onOpenWork}
            onToggle={handleToggle}
            selectedIds={selectedIds}
            onMarqueeSelect={handleMarqueeSelect}
            onClearSelection={clearSelection}
            rootLabels={rootLabels}
            rootAccents={rootAccents}
            thumbnailVisible={thumbnailsVisible}
            resetKey={resetKey}
            restoreScrollTop={scrollTops.current.works}
            bench={bench}
            onDragWorkStart={handleDragWorkStart}
            onDragWorkEnd={handleDragWorkEnd}
            empty={empty}
          />
        </>
      )}

      {tagOpen && (
        <Suspense fallback={null}>
          <TagEditor
            open={tagOpen}
            onOpenChange={setTagOpen}
            workIds={selectedWorks.map((work) => work.id)}
            onChanged={handleMarksChanged}
          />
        </Suspense>
      )}
      {markOpen && (
        <Suspense fallback={null}>
          <BulkMarkDialog
            open={markOpen}
            onOpenChange={setMarkOpen}
            workIds={selectedWorks.map((work) => work.id)}
            onApplied={handleMarksChanged}
          />
        </Suspense>
      )}

      {compareItems && (
        <Suspense fallback={null}>
          <CompareView
            items={compareItems}
            bench={bench}
            shielded={shielded}
            onClose={() => setCompareItems(null)}
          />
        </Suspense>
      )}

      {/* #57: 移動の確認・進捗・結果と Undo（同一ボリュームのみ 5 秒）。 */}
      {movePlan && (
        <Suspense fallback={null}>
          <MoveConfirmDialog
            plan={movePlan}
            busy={moving}
            progress={moveProgress}
            onClose={() => {
              if (!moving) setMovePlan(null)
            }}
            onConfirm={() => void confirmMove()}
            onCancelRunning={handleCancelMove}
          />
        </Suspense>
      )}
      {moveReport && (
        <Suspense fallback={null}>
          <MoveReportDialog result={moveReport} onClose={() => setMoveReport(null)} />
        </Suspense>
      )}
      </section>
    </div>
  )
}
