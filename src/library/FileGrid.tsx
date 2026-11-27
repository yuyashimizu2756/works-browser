import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Eye, EyeOff, Film, ImageIcon, Copy, Play } from 'lucide-react'
import { cn } from 'cn'
import { ToastMessage, pushToast } from '@/components/ToastStack'
import { rowsPerScreen, wantsNextPage } from '../lib/prefetch'
import { copyFilePath } from '../lib/pathCopy'
import { useDelayedVisible } from '../lib/useDelayedVisible'
import { Checkbox } from '@/components/ui/checkbox'
import type { FileSummary } from '../api'
import { formatBytes, formatDuration, formatShortDate } from '../lib/format'
import { installBenchHarness } from './bench'
import { rootAccentFor } from './accents'
import { SkeletonCards } from './SkeletonCards'
import { useRevealedFiles } from './revealedFiles'
import { thumbSrc } from './thumbSrc'
import { useScrollRestore } from './useScrollRestore'
import type { WorkSelectModifiers } from './WorkCard'
import { useHoverVideoPreview } from './useHoverVideoPreview'

/** 作品詳細のサムネイルサイズ（#5）。小は一覧性、大は内容確認。 */
export type FileTileSize = 'small' | 'medium' | 'large'

type TileMetrics = {
  minWidth: number
  /** カード下のメタ領域（名前 1 行 + メタ 2 行）。 */
  metaHeight: number
  gap: number
}

/**
 * #98 のカード規則: サムネイルは **4:3**、角丸 **12px**、名前は 1 行、メタは 2 行。
 * 高さは列幅から計算する（仮想スクロールの行高と一致させる）。
 */
const TILE_METRICS: Record<FileTileSize, TileMetrics> = {
  small: { minWidth: 148, metaHeight: 77, gap: 12 },
  medium: { minWidth: 196, metaHeight: 77, gap: 16 },
  large: { minWidth: 268, metaHeight: 77, gap: 16 },
}

/** グリッド左右の余白（`px-6` = 24px）。列数を出すときに差し引く。 */
const GRID_PADDING_X = 24


/** これ以上動いたらクリックではなく矩形選択とみなす。 */
const DRAG_THRESHOLD = 6

type Props = {
  files: FileSummary[]
  total: number
  hasMore: boolean
  loading: boolean
  /** 最初のページが届くまでの時間（ベンチ計測用）。 */
  firstPageMs: number | null
  onLoadMore: () => void
  onOpen: (file: FileSummary) => void
  onToggle: (file: FileSummary, modifiers: WorkSelectModifiers) => void
  selectedIds: ReadonlySet<number>
  rootLabels: Map<number, string>
  rootAccents: Map<number, string>
  /** false のときはサムネイルを 1 枚も読まない。 */
  thumbnailVisible: boolean
  resetKey: string
  /** モードを切り替えて戻ってきたときのスクロール位置（#81）。 */
  restoreScrollTop?: number
  bench: boolean
  empty: ReactNode
  /** サムネイルの大きさ（#5）。既定は中。 */
  tileSize?: FileTileSize
  /** 所属作品名のバッジ（作品詳細では不要なので false）。 */
  showWorkTitle?: boolean
  /** 矩形選択（#5 の作品詳細）。未指定なら矩形選択しない。 */
  onMarqueeSelect?: (files: FileSummary[], additive: boolean) => void
  /** 空き領域のクリックで選択解除（矩形選択とセットで使う）。 */
  onClearSelection?: () => void
}

const KIND_TINT: Record<FileSummary['kind'], string> = {
  image: 'color-mix(in srgb, #ffffff 3%, var(--surface))',
  video: 'color-mix(in srgb, #ffffff 4%, var(--surface))',
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  additive: boolean
  moved: boolean
}

type Rect = {
  left: number
  top: number
  width: number
  height: number
}

function FileTile({
  file,
  rootLabel,
  accent,
  selected,
  thumbnailVisible,
  bench,
  thumbHeight,
  cardHeight,
  showWorkTitle,
  onToggle,
  onOpen,
}: {
  file: FileSummary
  rootLabel: string
  accent: string
  selected: boolean
  thumbnailVisible: boolean
  bench: boolean
  thumbHeight: number
  cardHeight: number
  showWorkTitle: boolean
  onToggle: (file: FileSummary, modifiers: WorkSelectModifiers) => void
  onOpen: (file: FileSummary) => void
}) {
  const [failed, setFailed] = useState(false)
  /** #24: コピー中の連打を防ぐ（結果はトーストで知らせる）。 */
  const copyBusy = useRef(false)
  // #52 / #30: 全体非表示中でも、このファイルだけ一時的に表示できる。
  // 開くことによる自動表示はしない（一覧へ戻ったときに残らないようにする）。
  const { enabled: globalHidden, revealed, toggle: toggleReveal } = useRevealedFiles()
  const individuallyRevealed = globalHidden && revealed.has(file.id)
  const thumbVisible = thumbnailVisible || individuallyRevealed
  // 非表示中は convertFileSrc を呼ばない
  const thumb = thumbVisible && !failed ? thumbSrc(file.thumb_path) : null
  /** ホバー動画プレビュー（#46）。動画タイルだけ 5 秒無音再生する。 */
  const videoPreview = useHoverVideoPreview(
    file.kind === 'video' ? file.id : null,
    thumbVisible && !bench,
  )
  /** 単クリック → ダブルクリック / Enter の二重遷移ガード（#27）。 */
  const lastOpenRef = useRef(Number.NEGATIVE_INFINITY)
  const openFile = () => {
    const now = performance.now()
    if (now - lastOpenRef.current < 500) return
    lastOpenRef.current = now
    // #30: 開いたファイルを勝手に一時表示しない。ここで `reveal` すると、
    // 一覧へ戻ったときにサムネイルが表示されたままになる（手動の目アイコンだけ）。
    onOpen(file)
  }
  const resumeAt = file.kind === 'video' && (file.position_ms ?? 0) > 1_000 ? file.position_ms : null
  /**
   * #24: カードのコピーアイコン。パスは Rust の `file_path` で解決し、
   * UI では組み立てない。結果は既存のトーストへ出す。
   */
  const copyPath = async () => {
    if (copyBusy.current) return
    copyBusy.current = true
    try {
      const result = await copyFilePath(file.id)
      pushToast({
        key: 'file-path-copy',
        content: (
          <ToastMessage
            message={result.ok ? 'パスをコピーしました' : result.message}
          />
        ),
        duration: 2800,
      })
    } finally {
      copyBusy.current = false
    }
  }
  /** メタ 2 行目: 作品詳細では種類 / 寸法 / 長さ、ファイルモードではルート名（#98）。 */
  const secondMeta = showWorkTitle
    ? rootLabel
    : [
        file.kind === 'video' ? '動画' : '画像',
        file.kind === 'video'
          ? file.duration_ms
            ? formatDuration(file.duration_ms)
            : null
          : file.width && file.height
            ? `${file.width}×${file.height}`
            : null,
      ]
        .filter(Boolean)
        .join(' · ')

  return (
    <div
      role="listitem"
      tabIndex={0}
      data-file-id={file.id}
      data-file-kind={file.kind}
      data-work-id={file.work_id}
      data-selected={selected ? 'true' : undefined}
      data-video-previewing={videoPreview.playing ? 'true' : undefined}
      aria-selected={selected}
      title={`${file.work_title} — ${file.rel_path}`}
      aria-label={`${file.name}（${file.work_title}、${formatBytes(file.bytes)}）`}
      onClick={(event) => {
        // 単クリックで開く。ダブルクリックの 2 回目は捨てる
        if (event.detail > 1) return
        openFile()
      }}
      onDoubleClick={openFile}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          openFile()
        }
      }}
      onPointerEnter={videoPreview.startPreview}
      onPointerLeave={videoPreview.stopPreview}
      className={cn(
        'group/file relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] border bg-[var(--surface)] text-left',
        'transition-[border-color,box-shadow,transform,background-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
        selected
          ? 'border-2 border-[var(--root-accent)] bg-[color-mix(in_srgb,var(--root-accent)_9%,var(--card))]'
          : 'border-[var(--line)] hover:-translate-y-0.5 hover:border-[var(--line-strong)] hover:shadow-[0_12px_28px_-18px_rgb(0_0_0/0.9)]',
      )}
      style={
        {
          '--root-accent': accent,
          height: cardHeight,
        } as CSSProperties
      }
    >
      <span
        className="relative flex w-full flex-none items-center justify-center overflow-hidden"
        style={{ height: thumbHeight, backgroundColor: KIND_TINT[file.kind] }}
        data-thumb-ratio="4:3"
      >
        {thumb ? (
          <img
            className="absolute inset-0 h-full w-full object-cover"
            src={thumb}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
          />
        ) : file.kind === 'video' ? (
          <Film className="size-8 text-white/25" aria-hidden="true" />
        ) : (
          <ImageIcon className="size-8 text-white/25" aria-hidden="true" />
        )}

        {/* ホバー動画プレビュー（#46）。再生中だけ共有 <video> が差し込まれる */}
        <span
          ref={videoPreview.videoHostRef}
          aria-hidden="true"
          data-hover-video={videoPreview.playing ? 'playing' : 'idle'}
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />

        {/*
          #52: 全体が非表示のときだけ、このファイルだけ表示するトグルを出す。
          #112: 右上はチェックボックス専用（右端 6px / 24×24）。目アイコンは
          その左隣に 8px 間隔で置く（右端から 38px = 6 + 24 + 8）。
          同じ座標に重ねるとクリック対象が競合するため、絶対に共有しない。
        */}
        {globalHidden && (
          <button
            type="button"
            data-file-reveal
            aria-pressed={individuallyRevealed}
            aria-label={individuallyRevealed ? 'このファイルだけ隠す' : 'このファイルだけ表示'}
            title={individuallyRevealed ? 'このファイルだけ隠す' : 'このファイルだけ表示'}
            onClick={(event) => {
              event.stopPropagation()
              toggleReveal(file.id)
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              // #5: 非表示中は hover / focus のときだけ出す。タッチ環境（hover: none）は
              // index.css の media query で常時表示に戻す。
              'absolute top-1.5 right-[38px] z-10 flex size-6 items-center justify-center rounded-md border border-white/15 backdrop-blur-sm transition-[opacity,background-color,border-color,color]',
              individuallyRevealed
                ? 'bg-[var(--root-accent)]/80 text-white'
                : 'bg-black/60 text-white/75 hover:bg-black/80',
              individuallyRevealed
                ? 'opacity-100'
                : 'pointer-events-none opacity-0 group-hover/file:pointer-events-auto group-hover/file:opacity-100 group-focus-within/file:pointer-events-auto group-focus-within/file:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
            )}
          >
            {individuallyRevealed ? (
              <EyeOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
          </button>
        )}

        {/* #24: ホバーでフルパスをコピー（目アイコンの隣。非表示中はさらに左） */}
        <button
          type="button"
          data-file-copy
          aria-label={`${file.name} のパスをコピー`}
          title="パスをコピー"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void copyPath()
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Enter / Space はコピーだけに使い、カードを開かない
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
          }}
          className={cn(
            'absolute top-1.5 z-10 flex size-6 items-center justify-center rounded-md border border-white/15 bg-black/60 text-white/75 backdrop-blur-sm transition-[opacity,background-color,border-color,color] hover:bg-black/80',
            // 右から 6px（チェック）+ 24 + 8 = 38px。目アイコンがある間はさらに 32px 左。
            globalHidden ? 'right-[70px]' : 'right-[38px]',
            'pointer-events-none opacity-0 group-hover/file:pointer-events-auto group-hover/file:opacity-100 group-focus-within/file:pointer-events-auto group-focus-within/file:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
          )}
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>

        {/* 左上に所属作品名を小さく出す（Issue #21）。作品詳細では出さない */}
        {showWorkTitle && (
          <span
            data-work-title-badge
            className={cn(
              'absolute top-1.5 left-1.5 truncate rounded border border-white/10 bg-black/70 px-1.5 py-0.5 text-xs leading-tight font-medium text-white/85 backdrop-blur-sm',
              // #112: 目アイコン + チェックボックスのクラスタ（右から 62px）に
              // 重ならないよう、非表示中はバッジの右端を手前で止める。
              globalHidden ? 'max-w-[calc(100%_-_76px)]' : 'max-w-[78%]',
            )}
          >
            <span
              className="mr-1 inline-block size-1.5 rounded-full bg-[var(--text-tertiary)] align-middle"
              aria-hidden="true"
            />
            {file.work_title}
          </span>
        )}

        {/* 作品詳細（#5）では種類バッジを出さない（メタ 2 行目が種類を伝える。#99） */}

        {file.kind === 'video' && (
          <span
            data-duration-badge
            className="absolute right-1.5 bottom-1.5 rounded border border-white/10 bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-white/85 tabular-nums backdrop-blur-sm"
          >
            {formatDuration(file.duration_ms)}
          </span>
        )}

        {/* #60: 生成情報（プロンプト・モデル等）がキャッシュされているファイル */}
        {file.has_meta && (
          <span
            className={cn(
              'absolute rounded border border-white/10 bg-black/70 px-1.5 py-0.5 text-xs font-semibold text-[var(--brand)] backdrop-blur-sm',
              // #114: ファイルモードは 4 隅を分ける。右下は動画の長さ、meta は
              // その上（右端 6px は同じ、下から 32px）。作品詳細は左上のまま。
              showWorkTitle ? 'bottom-8 right-1.5' : 'top-1.5 left-1.5',
            )}
            title="生成情報あり（meta）"
            data-meta-badge
          >
            meta
          </span>
        )}

        {resumeAt !== null && (
          <span
            data-resume-badge
            className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded border border-white/10 bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white/85 tabular-nums backdrop-blur-sm"
            title={`前回の続きから再生（${formatDuration(resumeAt)}）`}
          >
            <Play className="size-2.5" aria-hidden="true" />
            {formatDuration(resumeAt)}
          </span>
        )}

        {selected && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[color-mix(in_oklch,var(--root-accent)_8%,transparent)]"
          />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1 px-3 pt-2 pb-2">
        <span className="truncate text-[13px] leading-[1.3] font-semibold" title={file.name}>
          {file.name}
        </span>
        <span className="truncate text-xs whitespace-nowrap text-[var(--text-secondary)] tabular-nums">
          {formatBytes(file.bytes)}
          <span aria-hidden="true"> · </span>
          {formatShortDate(file.mtime)}
        </span>
        <span className="truncate text-xs whitespace-nowrap text-[var(--text-secondary)] tabular-nums">
          {secondMeta}
        </span>
      </span>

      {/* 選択はチェックボックスだけ（#27）。見た目 size-5 / 当たり判定 24×24。 */}
      <div
        className="absolute top-1.5 right-1.5 z-10 flex size-6 cursor-pointer items-center justify-center"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          if (event.target === event.currentTarget) {
            onToggle(file, { ctrl: event.ctrlKey, shift: event.shiftKey })
          }
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Space / Enter はチェックのトグルに使うので本体（開く）へ流さない。Esc などは通す。
          if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
        }}
        data-file-checkbox-wrapper
      >
        <Checkbox
          checked={selected}
          onClick={(event) => {
            event.stopPropagation()
            onToggle(file, { ctrl: event.ctrlKey, shift: event.shiftKey })
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={selected ? `${file.name} の選択を解除` : `${file.name} を選択`}
          className={cn(
            'size-5 border-white/40 bg-black/55 shadow-sm backdrop-blur-sm transition-opacity after:inset-0',
            'opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100 focus-visible:opacity-100',
            'data-checked:border-[var(--root-accent)] data-checked:bg-[var(--root-accent)] data-checked:text-white data-checked:opacity-100',
            'data-[state=checked]:border-[var(--root-accent)] data-[state=checked]:bg-[var(--root-accent)] data-[state=checked]:text-white data-[state=checked]:opacity-100',
          )}
        />
      </div>
    </div>
  )
}

/**
 * ファイルの仮想スクロールグリッド（#21 / #5）。
 *
 * 作品を無視して `files` をそのまま並べる。1 カード = サムネ（または種類アイコン）
 * + ファイル名 + 所属作品名 + 長さ + サイズ + 日付。行は `@tanstack/react-virtual`。
 *
 * 作品詳細（#5）では `tileSize` で小 / 中 / 大、`onMarqueeSelect` で矩形選択を足す。
 */
export function FileGrid({
  files,
  total,
  hasMore,
  loading,
  firstPageMs,
  onLoadMore,
  onOpen,
  onToggle,
  selectedIds,
  rootLabels,
  rootAccents,
  thumbnailVisible,
  resetKey,
  restoreScrollTop,
  bench,
  empty,
  tileSize = 'medium',
  showWorkTitle = true,
  onMarqueeSelect,
  onClearSelection,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const metrics = TILE_METRICS[tileSize]
  const contentWidth = Math.max(0, viewportWidth - GRID_PADDING_X * 2)
  const columns = Math.max(
    1,
    Math.floor(
      (Math.max(contentWidth, metrics.minWidth) + metrics.gap) /
        (metrics.minWidth + metrics.gap),
    ),
  )
  /** 実際の列幅（4:3 のサムネ高と行高をここから出す）。 */
  const cardWidth =
    contentWidth > 0
      ? (contentWidth - metrics.gap * (columns - 1)) / columns
      : metrics.minWidth
  const thumbHeight = Math.max(1, Math.round((cardWidth * 3) / 4))
  const cardHeight = thumbHeight + metrics.metaHeight
  const rowHeight = cardHeight + metrics.gap

  const dragRef = useRef<DragState | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [dragging, setDragging] = useState(false)
  const filesById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files])

  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollElement(node)
  }, [])

  useEffect(() => {
    if (!scrollElement) return
    const update = () => {
      setViewportWidth(scrollElement.clientWidth)
      setViewportHeight(scrollElement.clientHeight)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scrollElement)
    return () => observer.disconnect()
  }, [scrollElement])

  const rowCount = Math.ceil(total / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: 4,
  })

  // サイズ切替（小 / 中 / 大）で行の高さを計算し直す
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight])

  const virtualRows = virtualizer.getVirtualItems()
  const lastRowIndex = virtualRows[virtualRows.length - 1]?.index ?? 0

  // #49: 表示範囲が「残り 2 画面」になったら次のページを要求する。
  // 二重取得は useFileFeed の pending フラグ（同じ offset の再要求を無視）で防ぐ。
  const rowsAhead = rowsPerScreen(viewportHeight, rowHeight) * 2
  useEffect(() => {
    if (!hasMore || loading) return
    if (wantsNextPage({ lastRowIndex, columns, loaded: files.length, rowsAhead })) onLoadMore()
  }, [lastRowIndex, columns, files.length, hasMore, loading, onLoadMore, rowsAhead])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = 0
  }, [resetKey])

  // #81: モードを切り替えて戻ってきたら、直前のスクロール位置へ戻す。
  useScrollRestore(scrollRef, restoreScrollTop)

  const loadedRef = useRef(files.length)
  loadedRef.current = files.length
  const totalRef = useRef(total)
  totalRef.current = total
  const columnsRef = useRef(columns)
  columnsRef.current = columns

  useEffect(() => {
    if (!bench) return
    const element = scrollRef.current
    if (!element) return
    return installBenchHarness(element, {
      loaded: () => loadedRef.current,
      total: () => totalRef.current,
      columns: () => columnsRef.current,
    })
  }, [bench])

  // ---------------------------------------------------------------- 矩形選択

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!onMarqueeSelect || event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-file-id], button, input, select, textarea, a')) return
    const element = event.currentTarget
    const bounds = element.getBoundingClientRect()
    // スクロールバー上からのドラッグは無視する
    if (event.clientX - bounds.left >= element.clientWidth) return

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      additive: event.ctrlKey || event.shiftKey,
      moved: false,
    }
    try {
      element.setPointerCapture(event.pointerId)
    } catch {
      // 合成イベントなどで pointer capture できない場合はそのまま続行
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    if (!drag.moved) {
      drag.moved = true
      setDragging(true)
    }
    event.preventDefault()
    setMarquee({
      left: Math.min(drag.startX, event.clientX),
      top: Math.min(drag.startY, event.clientY),
      width: Math.abs(dx),
      height: Math.abs(dy),
    })
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    setMarquee(null)
    if (!onMarqueeSelect) return
    if (cancelled) return

    if (!drag.moved) {
      // 空き領域の単クリックは選択解除（Ctrl / Shift 中は維持）
      if (!drag.additive) onClearSelection?.()
      return
    }

    const left = Math.min(drag.startX, event.clientX)
    const right = Math.max(drag.startX, event.clientX)
    const top = Math.min(drag.startY, event.clientY)
    const bottom = Math.max(drag.startY, event.clientY)
    const picked: FileSummary[] = []
    event.currentTarget.querySelectorAll<HTMLElement>('[data-file-id]').forEach((node) => {
      const file = filesById.get(Number(node.dataset.fileId))
      if (!file) return
      const bounds = node.getBoundingClientRect()
      if (
        bounds.right >= left &&
        bounds.left <= right &&
        bounds.bottom >= top &&
        bounds.top <= bottom
      ) {
        picked.push(file)
      }
    })
    onMarqueeSelect(picked, drag.additive)
  }

  const totalSize = virtualizer.getTotalSize()
  const initialLoading = loading && files.length === 0
  // #100: 200ms 未満の読み込みではスケルトンを出さない（ちらつき防止）。
  const showSkeleton = useDelayedVisible(initialLoading)

  return (
    <div
      ref={attachScroll}
      data-scroll-region
      data-shortcut-region
      className={cn(
        'min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pt-4 pb-8 [scrollbar-color:var(--border)_transparent] contain-[layout_paint] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
        dragging && 'cursor-crosshair select-none',
      )}
      role="list"
      aria-label="ファイル一覧"
      aria-busy={initialLoading || undefined}
      aria-multiselectable={onMarqueeSelect ? true : undefined}
      data-file-grid
      data-tile-size={tileSize}
      data-loaded={files.length}
      data-total={total}
      data-columns={columns}
      data-first-page-ms={firstPageMs ?? undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, false)}
      onPointerCancel={(event) => finishDrag(event, true)}
    >
      {!loading && total === 0 ? (
        <div className="flex min-h-full items-center justify-center px-6 py-10">{empty}</div>
      ) : showSkeleton ? (
        <SkeletonCards
          coverHeight={thumbHeight}
          cardHeight={cardHeight}
          gap={metrics.gap}
        />
      ) : (
        <div className="relative w-full" style={{ height: totalSize }}>
          {viewportWidth > 0 &&
            virtualRows.map((virtualRow) => {
              const start = virtualRow.index * columns
              const rowFiles = files.slice(start, start + columns)
              return (
                <div
                  key={virtualRow.key}
                  role="presentation"
                  className="absolute top-0 right-0 left-0 grid will-change-transform"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: cardHeight,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    gap: metrics.gap,
                  }}
                >
                  {rowFiles.map((file) => (
                    <FileTile
                      key={file.id}
                      file={file}
                      rootLabel={rootLabels.get(file.root_id) ?? ''}
                      accent={rootAccentFor(rootAccents, file.root_id)}
                      selected={selectedIds.has(file.id)}
                      thumbnailVisible={thumbnailVisible}
                      bench={bench}
                      thumbHeight={thumbHeight}
                      cardHeight={cardHeight}
                      showWorkTitle={showWorkTitle}
                      onToggle={onToggle}
                      onOpen={onOpen}
                    />
                  ))}
                  {Array.from({ length: columns - rowFiles.length }, (_, index) => (
                    <span
                      key={`pending-${index}`}
                      className="rounded-[var(--radius-card)] border border-dashed border-border bg-background/40"
                      style={{ height: cardHeight }}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              )
            })}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {formatLoaded(files.length, total)}
      </span>

      {marquee &&
        createPortal(
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-50 rounded-sm border border-[var(--brand)] bg-[color-mix(in_srgb,var(--brand)_12%,transparent)]"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />,
          document.body,
        )}
    </div>
  )
}

function formatLoaded(loaded: number, total: number): string {
  return `${loaded} / ${total} ファイルを読み込み済み`
}
