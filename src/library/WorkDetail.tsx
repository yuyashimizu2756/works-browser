import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Film,
  FolderOpen,
  ImageIcon,
  Loader2,
  MoreHorizontal,
  Trash2,
} from 'lucide-react'
import { cn } from 'cn'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToastMessage, pushToast, removeToast } from '@/components/ToastStack'
import { api } from '../api'
import type {
  FileKindFilter,
  FileSortKey,
  FileSummary,
  WorkMark,
  WorkSummary,
} from '../api'
import { describeError, formatBytes, formatCount, formatShortDate } from '../lib/format'
import { canCompare } from '../lib/compare'
import { marqueeSelect, selectedBytes, selectWorks } from '../lib/selection'
import type { SelectModifiers } from '../lib/selection'
import { compareItemsFromFiles } from './compareItems'
import type { CompareItem } from './compareItems'
import { focusAdjacentItem } from './listFocus'
import { notifyMarkChanged, tagData } from './tagData'
import { useListShortcuts } from './useListShortcuts'
import type { DeleteIntent } from './DeleteFlow'
import type { FileTileSize } from './FileGrid'
import { FileGrid } from './FileGrid'
import { WorkMarksBar } from './WorkMarksBar'
import type { SortDir } from './sortPrefs'
import { defaultFileDirFor } from './sortPrefs'
import { SortMenu, ThumbnailToggle } from './Toolbar'
import type { FilePageSource } from './useFileFeed'
import { dbWorkFileSource, useFileFeed, WORK_FILE_PAGE_SIZE } from './useFileFeed'
import { lightboxVisualFromUrl } from './visualLightbox'

/**
 * #49: ライトボックスは開くまで読み込まない（初期チャンク削減）。
 * 内部実装には触らない（#47 のスクラブプレビューと競合しない）。
 */
const Lightbox = lazy(() =>
  import('./Lightbox').then((module) => ({ default: module.Lightbox })),
)
/** #71: 比較ビュー。選択した 2〜4 ファイルを並べる。 */
const CompareView = lazy(() =>
  import('./CompareView').then((module) => ({ default: module.CompareView })),
)

const KIND_FILTERS: { key: FileKindFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'video', label: '動画' },
  { key: 'image', label: '画像' },
]

const SORTS: { key: FileSortKey; label: string }[] = [
  { key: 'name', label: '名前' },
  { key: 'mtime', label: '更新日' },
  { key: 'size', label: 'サイズ' },
  { key: 'duration', label: '長さ' },
]

const SIZES: { key: FileTileSize; label: string }[] = [
  { key: 'small', label: '小' },
  { key: 'medium', label: '中' },
  { key: 'large', label: '大' },
]

type Props = {
  work: WorkSummary
  rootLabel: string
  /** ルートごとのアクセント（CSS 変数）。 */
  accent: string
  /** false のときはサムネイルを読まず、コンパクトリストにする（#21）。 */
  thumbnailVisible: boolean
  /** 右上の「サムネ表示」トグル（#99）。未指定なら表示のみ。 */
  onToggleThumbnails?: () => void
  /** #22: シールド中はライトボックス（画像・動画）を DOM から外す。 */
  shielded: boolean
  /** ファイルモードから開いたとき、このファイルのライトボックスを開く。 */
  startFileId?: number | null
  /** ベンチ / headless 用の合成ファイル供給元。 */
  source?: FilePageSource
  bench: boolean
  /** 一覧の再読み込み（スキャン後など）。 */
  refreshToken: number
  /** 削除後に選択を解除するためのトークン（App が削除成功時に増やす）。 */
  selectionResetToken?: number
  /** 選択ファイルの削除（#15）。 */
  onDeleteSelected?: (files: FileSummary[], intent: DeleteIntent) => void
  /** 作品ごと削除（#15）。 */
  onDeleteWork?: (work: WorkSummary, intent: DeleteIntent) => void
  onBack: () => void
  /** #33: 履歴（`useNavStack`）側でライトボックスを制御する場合の index。未指定なら内部状態。 */
  lightboxIndex?: number | null
  /** #33: ライトボックスの開閉・index 変更を履歴へ伝える。 */
  onLightboxIndexChange?: (index: number | null) => void
}

/**
 * 作品詳細（#5 / #99）。代表 1 枚ではなく、作品内の**全ファイル**をグリッドで見る。
 *
 * - ヘッダ: 戻る（左上）/ 題名 32px / メタ 1 行（本数・サイズ・更新日）/ 評価の行
 * - 右上: 「開く」「フォルダ」の 2 つだけ。削除などは `⋯` メニューへ
 * - ツールバー: 1 段。種類はセグメント、並びはメニュー + 昇降トグル
 * - 本文: 仮想スクロールのサムネイルグリッド（4:3 / 角丸 12 / メタ 2 行）
 * - サムネ非表示中は `CompactFilesList`（画像リクエスト 0 件）
 * - クリックでライトボックス / プレイヤー。選択はチェックボックス（Ctrl / Shift / 矩形）
 */
export function WorkDetail({
  work,
  rootLabel,
  accent,
  thumbnailVisible,
  onToggleThumbnails,
  shielded,
  startFileId,
  source,
  bench,
  refreshToken,
  selectionResetToken = 0,
  onDeleteSelected,
  onDeleteWork,
  onBack,
  lightboxIndex: controlledLightboxIndex,
  onLightboxIndexChange,
}: Props) {
  const [summary, setSummary] = useState<WorkSummary>(work)
  /** #8: 「パスをコピー」用（ルートの実パス）。ベンチ / 取得失敗では null。 */
  const [rootRealPath, setRootRealPath] = useState<string | null>(null)
  const [kind, setKind] = useState<FileKindFilter>('all')
  const [sort, setSort] = useState<FileSortKey>('name')
  const [dir, setDir] = useState<SortDir>(() => defaultFileDirFor('name'))
  const [tileSize, setTileSize] = useState<FileTileSize>('medium')
  const [selection, setSelection] = useState<Map<number, FileSummary>>(() => new Map())
  const [localLightboxIndex, setLocalLightboxIndex] = useState<number | null>(null)
  // #71: 選択したファイルの比較ビュー
  const [compareItems, setCompareItems] = useState<CompareItem[] | null>(null)
  // #33: 履歴から制御されているときはルートの index を正とする（Esc・戻るで親が閉じる）
  const lightboxIndex =
    controlledLightboxIndex === undefined ? localLightboxIndex : controlledLightboxIndex
  const setLightboxIndex = useCallback(
    (next: number | null) => {
      if (controlledLightboxIndex === undefined) setLocalLightboxIndex(next)
      onLightboxIndexChange?.(next)
    },
    [controlledLightboxIndex, onLightboxIndexChange],
  )
  const [pendingStart, setPendingStart] = useState<number | null>(startFileId ?? null)
  const anchorRef = useRef<number | null>(null)
  // #8: `?lightbox=1`（visual:check のスクショ用）。ベンチのときだけ効く。
  const visualLightbox = useMemo(() => (bench ? lightboxVisualFromUrl() : null), [bench])
  const [visualApplied, setVisualApplied] = useState(false)

  const feed = useFileFeed({
    query: { search: '', kind, rootId: null, sort, dir, workId: work.id },
    source: source ?? dbWorkFileSource,
    refreshToken,
    pageSize: WORK_FILE_PAGE_SIZE,
  })

  // ヘッダの本数・サイズは DB の集計で更新する（ファイルモードから開いた直後は仮値のため）
  useEffect(() => {
    if (bench) return
    let alive = true
    void api
      .getWorkSummary(work.id)
      .then((info) => {
        if (!alive) return
        setSummary(info.work)
        setRootRealPath(info.root_real_path)
      })
      .catch(() => {
        // 取得できなくても一覧は表示できる
      })
    return () => {
      alive = false
    }
  }, [bench, work.id])

  // #115: 文言だけの通知は共通スタックへ積む。同じ key は置き換え、2.8 秒で消える。
  const toastRef = useRef<number | null>(null)
  const showToast = useCallback((message: string) => {
    toastRef.current = pushToast({
      key: 'detail-toast',
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

  // Esc = ライブラリへ戻る（#71 のキーボード操作に統合。ライトボックス / 比較ビューが
  // 開いている間はそちらが先に閉じる）

  const rootLabels = useMemo(
    () => new Map<number, string>([[work.root_id, rootLabel]]),
    [rootLabel, work.root_id],
  )
  const rootAccents = useMemo(
    () => new Map<number, string>([[work.root_id, accent]]),
    [accent, work.root_id],
  )
  const selectedIds = useMemo(() => new Set(selection.keys()), [selection])
  const selectedFiles = useMemo(() => [...selection.values()], [selection])
  const selectedTotalBytes = useMemo(() => selectedBytes(selection), [selection])

  const clearSelection = useCallback(() => {
    setSelection(new Map())
    anchorRef.current = null
  }, [])

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

  // Delete / Shift+Delete で選択ファイルを削除（Esc は上のハンドラが戻る）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' || selection.size === 0 || lightboxIndex !== null) return
      if (document.querySelector('[role="dialog"]')) return
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
      event.preventDefault()
      handleDelete(event.shiftKey)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleDelete, lightboxIndex, selection.size])

  const handleToggle = useCallback(
    (file: FileSummary, modifiers: SelectModifiers) => {
      const next = selectWorks(selection, file, modifiers, feed.files, anchorRef.current)
      setSelection(next.selection)
      anchorRef.current = next.anchorId
    },
    [feed.files, selection],
  )

  const handleMarqueeSelect = useCallback(
    (files: FileSummary[], additive: boolean) => {
      setSelection(marqueeSelect(selection, files, additive))
      if (files.length > 0) anchorRef.current = files[files.length - 1].id
    },
    [selection],
  )

  const openLightbox = useCallback(
    (file: FileSummary) => {
      const index = feed.files.findIndex((item) => item.id === file.id)
      if (index >= 0) setLightboxIndex(index)
    },
    [feed.files],
  )

  // -------------------------------------------------------------------------
  // #71: キーボード操作（j / k・1〜5・0・F・Space・Enter・Esc）
  // -------------------------------------------------------------------------

  /** フォーカス中のファイルタイル。 */
  const focusedFile = useCallback((): FileSummary | null => {
    const active = document.activeElement as HTMLElement | null
    const tile = active?.closest<HTMLElement>('[data-file-id]') ?? null
    const id = Number(tile?.dataset.fileId)
    if (!Number.isFinite(id) || id <= 0) return null
    return feed.files.find((file) => file.id === id) ?? null
  }, [feed.files])

  /** 評価・お気に入りは作品 1 件（詳細画面のヘッダと同じ）に効かせる。 */
  const applyWorkMark = useCallback(
    async (change: (mark: WorkMark) => {
      favorite: boolean
      rating: number | null
      note?: string | null
    }) => {
      const mark = await tagData().getWorkMark(work.id)
      await tagData().setWorkMark(work.id, change(mark))
      // ヘッダの星 / ハート（WorkMarksBar）を読み直す
      notifyMarkChanged(work.id)
    },
    [work.id],
  )

  const handleRate = useCallback(
    (rating: number | null) => {
      void applyWorkMark((mark) => ({
        favorite: mark.favorite,
        rating,
        note: mark.note ?? null,
      }))
        .then(() => showToast(rating === null ? '未評価に戻しました' : `★${rating} に評価しました`))
        .catch((cause: unknown) => showToast(`評価を保存できませんでした: ${describeError(cause)}`))
    },
    [applyWorkMark, showToast],
  )

  const handleFavorite = useCallback(() => {
    void applyWorkMark((mark) => ({
      favorite: !mark.favorite,
      rating: mark.rating,
      note: mark.note ?? null,
    }))
      .then(() => showToast('お気に入りを切り替えました'))
      .catch((cause: unknown) =>
        showToast(`お気に入りを保存できませんでした: ${describeError(cause)}`),
      )
  }, [applyWorkMark, showToast])

  const handleFocusMove = useCallback(
    (delta: 1 | -1) => {
      focusAdjacentItem({
        selector: '[data-file-id]',
        delta,
        onBoundary: feed.loadMore,
      })
    },
    [feed.loadMore],
  )

  /** Space: フォーカス中の動画をライトボックスで開いて再生する。 */
  const handleTogglePlay = useCallback(() => {
    const file = focusedFile()
    if (!file || file.kind !== 'video') return
    openLightbox(file)
  }, [focusedFile, openLightbox])

  /** Enter: フォーカス中のファイルをライトボックスで開く。 */
  const handleShortcutOpen = useCallback(() => {
    const file = focusedFile()
    if (file) openLightbox(file)
  }, [focusedFile, openLightbox])

  const compareOpen = compareItems !== null
  useListShortcuts({
    // ライトボックス / 比較ビュー表示中は、そちらのキー操作を優先する
    enabled: lightboxIndex === null && !compareOpen,
    onFocusMove: handleFocusMove,
    onRate: handleRate,
    onFavorite: handleFavorite,
    onTogglePlay: handleTogglePlay,
    onOpen: handleShortcutOpen,
    onClose: onBack,
  })

  // ファイルモードから開いたとき: そのファイルが見つかるまでページを足してライトボックスを開く
  useEffect(() => {
    if (pendingStart === null) return
    const index = feed.files.findIndex((file) => file.id === pendingStart)
    if (index >= 0) {
      setLightboxIndex(index)
      setPendingStart(null)
      return
    }
    if (feed.status === 'error' || !feed.hasMore) {
      setPendingStart(null)
      return
    }
    if (feed.status !== 'loading') feed.loadMore()
  }, [feed.files, feed.hasMore, feed.loadMore, feed.status, pendingStart])

  /**
   * #8: `?lightbox=1` のスクショ用。ファイルが 1 件でも読めたら先頭の画像を開く
   * （動画しか無い作品では先頭）。ユーザー操作ではないので、1 回だけ適用する。
   */
  useEffect(() => {
    if (!visualLightbox?.open || visualApplied) return
    if (lightboxIndex !== null || feed.files.length === 0) return
    const imageIndex = feed.files.findIndex((file) => file.kind === 'image')
    setLightboxIndex(imageIndex >= 0 ? imageIndex : 0)
    setVisualApplied(true)
  }, [feed.files, lightboxIndex, setLightboxIndex, visualApplied, visualLightbox])

  /** エクスプローラで開く。`file` を渡すとそのファイルを選択状態で表示する。 */
  const revealTarget = useCallback(
    (file: FileSummary | null) => {
      if (bench) {
        showToast('ベンチモードではエクスプローラを開けません')
        return
      }
      const action = file ? api.revealFile(file.id) : api.revealWork(work.id)
      void action
        .then(() => {
          showToast(
            file ? 'エクスプローラでファイルを選択しました' : '作品フォルダを開きました',
          )
        })
        .catch((cause: unknown) => showToast(describeError(cause)))
    },
    [bench, showToast, work.id],
  )

  /** 右上の「フォルダ」: 常に作品フォルダを開く。 */
  const revealFolder = useCallback(() => revealTarget(null), [revealTarget])

  /** 選択バー / `⋯`: 1 件選んでいればそのファイルを表示する。 */
  const revealSelection = useCallback(
    () => revealTarget(selectedFiles.length === 1 ? selectedFiles[0] : null),
    [revealTarget, selectedFiles],
  )

  /** 右上の「開く」。選択が 1 件ならそれ、なければ先頭のファイルをライトボックスで開く。 */
  const openSelected = useCallback(() => {
    const target = selectedFiles.length === 1 ? selectedFiles[0] : feed.files[0]
    if (target) openLightbox(target)
  }, [feed.files, openLightbox, selectedFiles])

  /** 一覧の並びを変えたら、キーごとの既定の向きへ戻す（ファイルモードと同じ）。 */
  const changeSort = useCallback((next: FileSortKey) => {
    setSort(next)
    setDir(defaultFileDirFor(next))
  }, [])

  const resetKey = `${work.id}\u0000${kind}\u0000${sort}\u0000${dir}\u0000${tileSize}`

  const empty: ReactNode =
    kind !== 'all' ? (
      <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
        <p className="m-0 text-sm font-semibold">
          {kind === 'video' ? '動画がありません' : '画像がありません'}
        </p>
        <p className="m-0 text-xs text-[var(--text-secondary)]">
          種類の絞り込みを「すべて」に戻すと全ファイルが並びます。
        </p>
        <Button variant="outline" size="sm" onClick={() => setKind('all')}>
          すべて表示
        </Button>
      </div>
    ) : (
      <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
        <p className="m-0 text-sm font-semibold">この作品にファイルがありません</p>
        <p className="m-0 text-xs text-[var(--text-secondary)]">
          走査でファイルが見つからなかったか、索引から削除されています。
        </p>
      </div>
    )

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label="作品詳細"
      style={{ '--root-accent': accent } as CSSProperties}
      data-work-detail
      data-work-id={work.id}
    >
      {/* ヘッダ 3 層: 題名 / メタ 1 行（補助情報もここへ）/ 評価 */}
      <header
        className="flex flex-none flex-col gap-3 border-b border-[var(--line)] px-6 pt-4 pb-3"
        data-work-header
      >
        <div className="flex min-w-0 items-start gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label="ライブラリへ戻る"
            title="ライブラリへ戻る（Esc）"
            className="-ml-1.5 mt-1 flex-none text-[var(--text-secondary)]"
          >
            <ArrowLeft />
          </Button>

          <div className="min-w-0 flex-1">
            <h2
              className="type-display m-0 line-clamp-2 text-[length:var(--font-size-32)] leading-[1.2] font-[650] break-words"
              title={summary.title}
              data-work-title
            >
              {summary.title}
            </h2>
          </div>

          <div className="flex flex-none items-center gap-2">
            <Button
              size="sm"
              onClick={openSelected}
              disabled={feed.files.length === 0}
              title="選択中（なければ先頭）のファイルを開く（Enter）"
              data-work-open
            >
              <ArrowUpRight data-icon="inline-start" />
              開く
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={revealFolder}
              title="エクスプローラで作品フォルダを開く"
              data-work-folder
            >
              <FolderOpen data-icon="inline-start" />
              フォルダ
            </Button>
            <WorkActionsMenu
              selectionCount={selection.size}
              onRevealSelected={selection.size === 1 ? revealSelection : undefined}
              onDeleteWork={
                onDeleteWork ? () => onDeleteWork(summary, { permanent: false }) : undefined
              }
            />
          </div>
        </div>

        <div className="pl-9" data-work-secondary>
          <WorkMarksBar
            workId={work.id}
            bench={bench}
            rootLabel={rootLabel}
            meta={
              <>
                <span>{formatCount(summary.file_count)} ファイル</span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(summary.total_bytes)}</span>
                <span aria-hidden="true">·</span>
                <span>{formatShortDate(summary.mtime)}</span>
              </>
            }
          />
        </div>
      </header>

      {/* 選択バー（既存のライブラリと同じ操作） */}
      {selection.size > 0 && (
        <div
          className="flex flex-none flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-6 py-2"
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
            {formatBytes(selectedTotalBytes)}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="xs"
              onClick={revealSelection}
              title="選択中のファイルをエクスプローラで表示"
            >
              <ArrowUpRight data-icon="inline-start" />
              エクスプローラ
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setCompareItems(compareItemsFromFiles(selectedFiles))}
              disabled={!canCompare(selection.size)}
              title="選択した 2〜4 件を並べて比較（#71）"
            >
              比較
            </Button>
            <Button variant="destructive" size="xs" onClick={() => handleDelete(false)}>
              削除
            </Button>
            <Button variant="ghost" size="xs" onClick={clearSelection}>
              選択解除
            </Button>
          </div>
        </div>
      )}

      {/* ツールバー（1 段・スクロール追従） */}
      <div
        className="sticky top-0 z-20 flex h-12 flex-none items-center gap-2 border-b border-[var(--line)] bg-[var(--bg)] px-6"
        role="toolbar"
        aria-label="ファイルのツールバー"
        data-work-toolbar
      >
        <div
          className="flex h-8 flex-none items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface)] p-0.5"
          role="group"
          aria-label="種類で絞り込み"
        >
          {KIND_FILTERS.map((option) => {
            const active = option.key === kind
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={active}
                onClick={() => setKind(option.key)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs transition-colors duration-[var(--duration-fast)]',
                  active
                    ? 'bg-[var(--raised)] font-medium text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                {option.key === 'video' && (
                  <Film className="size-3.5" aria-hidden="true" />
                )}
                {option.key === 'image' && (
                  <ImageIcon className="size-3.5" aria-hidden="true" />
                )}
                {option.label}
              </button>
            )
          })}
        </div>

        <SortMenu options={SORTS} value={sort} onChange={changeSort} dir={dir} onToggleDir={() => {
          setDir((current) => (current === 'asc' ? 'desc' : 'asc'))
        }} />

        {/* サムネ非表示中はサイズ切替を出さない（リストになるため） */}
        {thumbnailVisible && (
          <div
            className="flex h-8 flex-none items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface)] p-0.5"
            role="group"
            aria-label="サムネイルの大きさ"
          >
            {SIZES.map((option) => {
              const active = tileSize === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  title={`サムネイル ${option.label}`}
                  onClick={() => setTileSize(option.key)}
                  className={cn(
                    'inline-flex h-7 min-w-7 items-center justify-center rounded-[6px] px-1.5 text-xs transition-colors duration-[var(--duration-fast)]',
                    active
                      ? 'bg-[var(--raised)] font-medium text-[var(--text-primary)] shadow-sm'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        )}

        <div className="ml-auto flex flex-none items-center gap-3 text-xs text-[var(--text-secondary)] tabular-nums">
          {feed.status === 'loading' && feed.files.length === 0 && (
            <Loader2 className="size-3.5 animate-spin text-[var(--brand)]" aria-label="読み込み中" />
          )}
          <span data-work-count>{formatCount(feed.total)} ファイル</span>
          <ThumbnailToggle
            visible={thumbnailVisible}
            onToggle={() => onToggleThumbnails?.()}
            disabled={!onToggleThumbnails}
            dataAttr={{ 'data-work-thumb-toggle': true }}
          />
        </div>
      </div>

      {bench && (
        <p
          className="m-0 flex-none bg-[var(--surface)] px-6 py-1.5 text-xs text-[var(--warning)]"
          role="note"
        >
          ベンチモード: 合成 {formatCount(summary.file_count)} ファイル。{' '}
          <code>window.__worksBench.start()</code> でスクロール性能を計測できます。
        </p>
      )}

      {feed.status === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
          <p className="m-0 text-sm font-semibold">ファイルを取得できませんでした</p>
          <p className="m-0 text-xs text-[var(--text-secondary)]">{feed.error}</p>
          <Button size="sm" onClick={feed.retry}>
            再試行
          </Button>
        </div>
      ) : (
        <FileGrid
          files={feed.files}
          total={feed.total}
          hasMore={feed.hasMore}
          loading={feed.status === 'loading'}
          firstPageMs={feed.firstPageMs}
          onLoadMore={feed.loadMore}
          onOpen={openLightbox}
          onToggle={handleToggle}
          selectedIds={selectedIds}
          rootLabels={rootLabels}
          rootAccents={rootAccents}
          thumbnailVisible={thumbnailVisible}
          resetKey={resetKey}
          bench={bench}
          empty={empty}
          tileSize={tileSize}
          showWorkTitle={false}
          onMarqueeSelect={handleMarqueeSelect}
          onClearSelection={clearSelection}
        />
      )}

      {lightboxIndex !== null && (
        <Suspense fallback={null}>
          <Lightbox
            files={feed.files}
            index={Math.min(lightboxIndex, Math.max(0, feed.files.length - 1))}
            hasMore={feed.hasMore}
            loadingMore={feed.status === 'loading'}
            onRequestMore={feed.loadMore}
            onIndexChange={setLightboxIndex}
            onClose={() => setLightboxIndex(null)}
            bench={bench}
            shielded={shielded}
            workId={work.id}
            // ベンチは合成データなので実パスが無い。スクショ用に固定の例を渡す。
            rootRealPath={bench ? 'D:\\bench\\synthetic' : rootRealPath}
            onDeleteFile={
              onDeleteSelected
                ? (file) => onDeleteSelected([file], { permanent: false })
                : undefined
            }
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
    </section>
  )
}

/**
 * ヘッダ右上の `⋯`。削除など、よく使わない操作だけをここへまとめる（#99）。
 * 外側クリック / Escape で閉じ、トリガーへフォーカスを戻す。
 */
function WorkActionsMenu({
  selectionCount,
  onRevealSelected,
  onDeleteWork,
}: {
  selectionCount: number
  onRevealSelected?: () => void
  onDeleteWork?: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative flex-none">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon-sm"
        aria-label="その他の操作"
        aria-haspopup="menu"
        aria-expanded={open}
        title="その他の操作"
        onClick={() => setOpen((value) => !value)}
        data-work-menu-trigger
      >
        <MoreHorizontal />
      </Button>

      {open && (
        <div
          role="menu"
          aria-label="その他の操作"
          data-work-menu
          className="absolute top-[calc(100%+8px)] right-0 z-50 w-64 origin-top-right rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--raised)] p-1.5 text-[13px] text-[var(--text-primary)] shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
        >
          <button
            type="button"
            role="menuitem"
            disabled={!onRevealSelected}
            title={
              selectionCount === 1
                ? '選択中のファイルをエクスプローラで表示'
                : 'ファイルを 1 件選ぶと使えます'
            }
            onClick={() => {
              setOpen(false)
              onRevealSelected?.()
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--muted)] disabled:pointer-events-none disabled:opacity-45"
          >
            <ArrowUpRight className="size-3.5 text-[var(--text-secondary)]" aria-hidden="true" />
            選択ファイルを表示
          </button>
          <div className="my-1 h-px bg-[var(--line)]" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!onDeleteWork}
            onClick={() => {
              setOpen(false)
              onDeleteWork?.()
            }}
            className="flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-[var(--destructive)] transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] disabled:pointer-events-none disabled:opacity-45"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            この作品をゴミ箱へ
          </button>
        </div>
      )}
    </div>
  )
}
