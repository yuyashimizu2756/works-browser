import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from 'cn'
import { rowsPerScreen, wantsNextPage } from '../lib/prefetch'
import { useDelayedVisible } from '../lib/useDelayedVisible'
import type { WorkSummary } from '../api'
import { installBenchHarness } from './bench'
import { rootAccentFor } from './accents'
import { GRID_GAP, gridMetricsFor, skeletonMetricsFor } from './gridMetrics'
import { SkeletonCards } from './SkeletonCards'
import { useScrollRestore } from './useScrollRestore'
import { WorkCard } from './WorkCard'
import type { WorkSelectModifiers } from './WorkCard'

/** これ以上動いたらクリックではなく矩形選択とみなす。 */
const DRAG_THRESHOLD = 6

type Props = {
  works: WorkSummary[]
  total: number
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  onOpen: (work: WorkSummary) => void
  onToggle: (work: WorkSummary, modifiers: WorkSelectModifiers) => void
  selectedIds: ReadonlySet<number>
  onMarqueeSelect: (works: WorkSummary[], additive: boolean) => void
  onClearSelection: () => void
  rootLabels: Map<number, string>
  rootAccents: Map<number, string>
  /** false のときはカバー画像を読み込まない（#21 のサムネ非表示）。 */
  thumbnailVisible: boolean
  /** 検索・並び替えが変わったらスクロールを先頭へ戻すためのキー。 */
  resetKey: string
  /** モードを切り替えて戻ってきたときのスクロール位置（#81）。 */
  restoreScrollTop?: number
  bench: boolean
  /** #57: カードをルートへドラッグし始めた / やめた。 */
  onDragWorkStart?: (work: WorkSummary) => void
  onDragWorkEnd?: () => void
  empty: ReactNode
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

/**
 * ウィンドウ幅に合わせて列数を変える仮想スクロールグリッド（複数選択対応）。
 *
 * #21 でファイル表示（FileGrid）・サムネ非表示のコンパクト表示（CompactList）を
 * 追加するときは、このコンポーネントを差し替えるだけで済むよう、選択・矩形選択の
 * ロジックはグリッド内に閉じている。
 */
export function WorkGrid({
  works,
  total,
  hasMore,
  loading,
  onLoadMore,
  onOpen,
  onToggle,
  selectedIds,
  onMarqueeSelect,
  onClearSelection,
  rootLabels,
  rootAccents,
  thumbnailVisible,
  resetKey,
  restoreScrollTop,
  bench,
  onDragWorkStart,
  onDragWorkEnd,
  empty,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** スクロール要素は常に同じ DOM を保つ（状態で差し替えると ResizeObserver が外れる）。 */
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const dragRef = useRef<DragState | null>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [dragging, setDragging] = useState(false)

  const worksById = useMemo(() => new Map(works.map((work) => [work.id, work])), [works])

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

  /**
   * #98: 列数 3〜6、外側余白 24、間隔 16。カバーが 4:3 なので、カード高さは
   * 幅から決まる（仮想スクロールの行送りも同じ値を使う）。
   * 測定前は 1280px 相当で描き、ResizeObserver の初回で実際の値へ揃える。
   */
  const metrics = gridMetricsFor(viewportWidth || 1280)
  const columns = metrics.columns
  const rowHeight = metrics.cardHeight + GRID_GAP
  const rowCount = Math.ceil(total / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: 4,
  })

  // 幅が変わるとカード高さ（= 行送り）も変わるので測り直す
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight])

  const virtualRows = virtualizer.getVirtualItems()
  const lastRowIndex = virtualRows[virtualRows.length - 1]?.index ?? 0

  // #49: 表示範囲が「残り 2 画面」になったら次のページを要求する（末端まで待たない）。
  // 二重取得は useWorkFeed の pending フラグ（同じ offset の再要求を無視）で防ぐ。
  const rowsAhead = rowsPerScreen(viewportHeight, rowHeight) * 2
  useEffect(() => {
    if (!hasMore || loading) return
    if (wantsNextPage({ lastRowIndex, columns, loaded: works.length, rowsAhead })) onLoadMore()
  }, [lastRowIndex, columns, works.length, hasMore, loading, onLoadMore, rowsAhead])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = 0
  }, [resetKey])

  // #81: モードを切り替えて戻ってきたら、直前のスクロール位置へ戻す。
  useScrollRestore(scrollRef, restoreScrollTop)

  const loadedRef = useRef(works.length)
  loadedRef.current = works.length
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
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('[data-work-id], button, input, select, textarea, a')) return
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

    if (cancelled) return
    if (!drag.moved) {
      // 空き領域の単クリックは選択解除（Ctrl / Shift 中は維持）
      if (!drag.additive) onClearSelection()
      return
    }

    const left = Math.min(drag.startX, event.clientX)
    const right = Math.max(drag.startX, event.clientX)
    const top = Math.min(drag.startY, event.clientY)
    const bottom = Math.max(drag.startY, event.clientY)
    const picked: WorkSummary[] = []
    event.currentTarget.querySelectorAll<HTMLElement>('[data-work-id]').forEach((node) => {
      const work = worksById.get(Number(node.dataset.workId))
      if (!work) return
      const bounds = node.getBoundingClientRect()
      if (bounds.right >= left && bounds.left <= right && bounds.bottom >= top && bounds.top <= bottom) {
        picked.push(work)
      }
    })
    onMarqueeSelect(picked, drag.additive)
  }

  const totalSize = virtualizer.getTotalSize()
  const initialLoading = loading && works.length === 0
  // #100: 200ms 未満の読み込みではスケルトンを出さない（ちらつき防止）。
  const showSkeleton = useDelayedVisible(initialLoading)
  const skeleton = skeletonMetricsFor(viewportWidth || 1280)

  return (
    <div
      ref={attachScroll}
      data-scroll-region
      data-shortcut-region
      className={cn(
        'min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pt-4 pb-8 [scrollbar-color:var(--line)_transparent] contain-[layout_paint] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--line-strong)]',
        dragging && 'cursor-crosshair select-none',
      )}
      role="listbox"
      aria-label="作品一覧"
      aria-multiselectable="true"
      aria-busy={initialLoading || undefined}
      data-loaded={works.length}
      data-total={total}
      data-columns={columns}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishDrag(event, false)}
      onPointerCancel={(event) => finishDrag(event, true)}
    >
      {!loading && total === 0 ? (
        <div className="flex min-h-full items-center justify-center px-5 py-10">{empty}</div>
      ) : showSkeleton ? (
        <SkeletonCards coverHeight={skeleton.coverHeight} cardHeight={skeleton.cardHeight} />
      ) : (
        <div className="relative w-full" style={{ height: totalSize }}>
          {viewportWidth > 0 &&
            virtualRows.map((virtualRow) => {
              const start = virtualRow.index * columns
              const rowWorks = works.slice(start, start + columns)
              return (
                <div
                  key={virtualRow.key}
                  role="presentation"
                  className="absolute top-0 right-0 left-0 grid will-change-transform"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: metrics.cardHeight,
                    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                    gap: GRID_GAP,
                  }}
                >
                  {rowWorks.map((work) => (
                    <WorkCard
                      key={work.id}
                      work={work}
                      rootLabel={rootLabels.get(work.root_id) ?? ''}
                      accent={rootAccentFor(rootAccents, work.root_id)}
                      selected={selectedIds.has(work.id)}
                      thumbnailVisible={thumbnailVisible}
                      bench={bench}
                      coverHeight={metrics.coverHeight}
                      onToggle={onToggle}
                      onOpen={onOpen}
                      onDragStart={onDragWorkStart}
                      onDragEnd={onDragWorkEnd}
                    />
                  ))}
                  {Array.from({ length: columns - rowWorks.length }, (_, index) => (
                    <span
                      key={`pending-${index}`}
                      className="rounded-[var(--radius-card)] border border-dashed border-[var(--line)] bg-transparent"
                      style={{ height: metrics.cardHeight }}
                      aria-hidden="true"
                    />
                  ))}
                </div>
              )
            })}
        </div>
      )}

      {marquee &&
        createPortal(
          <div
            aria-hidden="true"
            className="pointer-events-none fixed z-50 rounded-sm border border-[var(--accent-cyan)] bg-[color-mix(in_oklch,var(--accent-cyan)_12%,transparent)]"
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
