import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/button'
import type { WorkSummary } from '../api'
import { formatCount } from '../lib/format'
import { groupWorksByDay, timelineHeading } from '../lib/timeline'
import type { TimelineSection } from '../lib/timeline'
import { useDelayedVisible } from '../lib/useDelayedVisible'
import type { LibraryViewMode } from '../lib/viewMode'
import { rootAccentFor } from './accents'
import { GRID_GAP, gridMetricsFor, skeletonMetricsFor } from './gridMetrics'
import { SkeletonCards } from './SkeletonCards'
import { ThumbnailToggle, ToolbarShell, ViewModeSegment } from './Toolbar'
import { useScrollRestore } from './useScrollRestore'
import type { WorkPageSource } from './useWorkFeed'
import { useWorkFeed } from './useWorkFeed'
import { WorkCard } from './WorkCard'
import type { WorkSelectModifiers } from './WorkCard'

/** タイムラインの外側余白（px-5）。 */
const GRID_PADDING = 20
/** 日付見出し 1 行の高さ。 */
const HEADER_HEIGHT = 46
/** 最後の行の下に確保する余白（次のページを読みにいく余地）。 */
const BOTTOM_PADDING = 28

type HeaderRow = {
  kind: 'header'
  key: string
  section: TimelineSection
  height: number
  start: number
}

type WorksRow = {
  kind: 'works'
  key: string
  sectionKey: string
  works: WorkSummary[]
  height: number
  start: number
}

type TimelineRow = HeaderRow | WorksRow

type Props = {
  rootLabels: Map<number, string>
  rootAccents: Map<number, string>
  /** ベンチモードでは Tauri の代わりに合成データを読む。 */
  source?: WorkPageSource
  refreshToken: number
  /** false のときはサムネイルを要求しない（#21 の方針をそのまま守る）。 */
  thumbnailsVisible: boolean
  /** #120: ツールバー右端のラベル付きサムネトグル（ヘッダー / 詳細と共有）。 */
  onToggleThumbnails: () => void
  bench: boolean
  selectedIds: ReadonlySet<number>
  onOpenWork: (work: WorkSummary) => void
  onToggle: (work: WorkSummary, modifiers: WorkSelectModifiers) => void
  /** #96: ツールバー右端の表示切替。 */
  viewMode: LibraryViewMode
  onViewModeChange: (mode: LibraryViewMode) => void
  /** モードを切り替えて戻ったときのスクロール位置（#81）。 */
  restoreScrollTop?: number
}

/**
 * タイムライン（日別）ビュー（#81）。
 *
 * `find_works` を **`sort=mtime` / 降順**で 1 ページずつ読み、届いた分を
 * `groupWorksByDay`（純関数）でローカル日付のセクションに足していく。
 * 全件を一度に取らない・描画しないために、行は `@tanstack/react-virtual` で
 * 可視範囲だけを DOM に置く。日付見出しは現在のセクションを上端に固定表示する。
 */
export function TimelineView({
  rootLabels,
  rootAccents,
  source,
  refreshToken,
  thumbnailsVisible,
  onToggleThumbnails,
  bench,
  selectedIds,
  onOpenWork,
  onToggle,
  viewMode,
  onViewModeChange,
  restoreScrollTop,
}: Props) {
  // タイムラインは常に「更新日の新しい順」。作品モードの並び替え設定には影響されない。
  const feed = useWorkFeed({
    query: {
      search: '',
      kind: 'all',
      rootId: null,
      sort: 'mtime',
      dir: 'desc',
    },
    source,
    refreshToken,
  })

  const sections = useMemo(() => groupWorksByDay(feed.works), [feed.works])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const scrollFrame = useRef(0)

  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollElement(node)
  }, [])

  useEffect(() => {
    if (!scrollElement) return
    const update = () => setViewportWidth(scrollElement.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scrollElement)
    return () => observer.disconnect()
  }, [scrollElement])

  /** #98: 作品グリッドと同じ 3〜6 列 / 4:3 のカード寸法を共有する。 */
  const metrics = gridMetricsFor(viewportWidth || 1280, GRID_PADDING)
  const columns = metrics.columns
  const workRowHeight = metrics.cardHeight + GRID_GAP

  /**
   * セクション → 仮想行（見出し 1 行 + カードの折り返し行）へ平坦化する。
   * 高さは固定なので、仮想スクロールの位置と sticky 判定の両方で同じ値を使える。
   */
  const rows = useMemo(() => {
    const flattened: TimelineRow[] = []
    let offset = 0
    for (const section of sections) {
      flattened.push({
        kind: 'header',
        key: `header:${section.dateKey}`,
        section,
        height: HEADER_HEIGHT,
        start: offset,
      })
      offset += HEADER_HEIGHT
      for (let index = 0; index < section.works.length; index += columns) {
        flattened.push({
          kind: 'works',
          key: `works:${section.dateKey}:${index}`,
          sectionKey: section.dateKey,
          works: section.works.slice(index, index + columns),
          height: workRowHeight,
          start: offset,
        })
        offset += workRowHeight
      }
    }
    return { flattened, totalHeight: offset }
  }, [columns, sections, workRowHeight])

  const virtualizer = useVirtualizer({
    count: rows.flattened.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) => rows.flattened[index]?.height ?? workRowHeight,
    overscan: 5,
  })

  // 幅が変わるとカード高さ（= 行送り）も変わるので測り直す
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, workRowHeight])

  const virtualRows = virtualizer.getVirtualItems()
  const lastRowIndex = virtualRows[virtualRows.length - 1]?.index ?? 0

  // 表示範囲が末尾に近づいたら次のページを要求する（届いた分から日付グループに足す）。
  const { hasMore, status, loadMore } = feed
  useEffect(() => {
    if (!hasMore || status === 'loading') return
    if (rows.flattened.length === 0) return
    if (lastRowIndex >= rows.flattened.length - 2) loadMore()
  }, [hasMore, lastRowIndex, loadMore, rows.flattened.length, status])

  useScrollRestore(scrollRef, restoreScrollTop)

  const handleScroll = useCallback(() => {
    if (scrollFrame.current !== 0) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0
      setScrollTop(scrollRef.current?.scrollTop ?? 0)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (scrollFrame.current !== 0) window.cancelAnimationFrame(scrollFrame.current)
    }
  }, [])

  /**
   * 上端に固定表示する見出し。スクロール位置が属するセクションの見出しを選ぶ
   * （実体の見出し行は普通に流れ、完全に見えたら重ねて出さない）。
   */
  const activeHeader = useMemo(() => {
    let current: HeaderRow | null = null
    for (const row of rows.flattened) {
      if (row.start > scrollTop + 1) break
      if (row.kind === 'header') current = row
    }
    return current
  }, [rows.flattened, scrollTop])

  const stickyHeader = activeHeader !== null && activeHeader.start < scrollTop

  const rootLabelFor = (work: WorkSummary) => rootLabels.get(work.root_id) ?? ''
  const totalHeight = rows.totalHeight + BOTTOM_PADDING
  const initialLoading = feed.status === 'loading' && feed.works.length === 0
  // #100: 200ms 未満の読み込みではスケルトンを出さない（ちらつき防止）。
  const showSkeleton = useDelayedVisible(initialLoading)
  const skeleton = skeletonMetricsFor(viewportWidth || 1280, GRID_PADDING)
  const showEmpty = !initialLoading && feed.works.length === 0 && feed.total === 0

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="タイムライン">
      <ToolbarShell label="タイムラインのツールバー">
        <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)] tabular-nums">
          <strong className="text-[13px] font-semibold text-[var(--text-primary)] tabular-nums">
            {formatCount(feed.total)}
          </strong>
          作品
          <span aria-hidden="true">·</span>
          {formatCount(sections.length)} 日分
          <span aria-hidden="true">·</span>
          <span>更新日の新しい順</span>
          {feed.total > feed.works.length && (
            <span>（{formatCount(feed.works.length)} 件読み込み済み）</span>
          )}
        </p>
        <div className="ml-auto flex flex-none items-center gap-3">
          <ThumbnailToggle visible={thumbnailsVisible} onToggle={onToggleThumbnails} />
          <ViewModeSegment value={viewMode} onChange={onViewModeChange} />
        </div>
      </ToolbarShell>

      {feed.status === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2.5 px-5 py-10 text-center">
          <p className="text-base font-semibold">作品を取得できませんでした</p>
          <p className="m-0 text-xs text-muted-foreground">{feed.error}</p>
          <Button size="sm" onClick={feed.retry}>
            再試行
          </Button>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={attachScroll}
            data-scroll-region
            data-shortcut-region
            data-timeline
            data-loaded={feed.works.length}
            data-total={feed.total}
            data-sections={sections.length}
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pt-1 pb-7 [scrollbar-color:var(--border)_transparent] contain-[layout_paint] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border"
            aria-busy={initialLoading || undefined}
            onScroll={handleScroll}
          >
            {showEmpty ? (
              <div className="flex min-h-full items-center justify-center px-5 py-10">
                <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
                  <p className="text-base font-semibold">まだ作品がありません</p>
                  <p className="m-0 text-xs text-muted-foreground">
                    走査ルートを追加して走査すると、更新日ごとに作品が並びます。
                  </p>
                </div>
              </div>
            ) : showSkeleton ? (
              <SkeletonCards
                className="pt-2"
                coverHeight={skeleton.coverHeight}
                cardHeight={skeleton.cardHeight}
              />
            ) : (
              <div className="relative w-full" style={{ height: totalHeight }}>
                {viewportWidth > 0 &&
                  virtualRows.map((virtualRow) => {
                    const row = rows.flattened[virtualRow.index]
                    if (!row) return null
                    if (row.kind === 'header') {
                      return (
                        <div
                          key={row.key}
                          role="presentation"
                          className="absolute top-0 right-0 left-0 flex items-end pb-1 will-change-transform"
                          style={{ transform: `translateY(${row.start}px)`, height: HEADER_HEIGHT }}
                        >
                          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-foreground tabular-nums">
                            {timelineHeading(row.section)}
                          </h2>
                        </div>
                      )
                    }
                    return (
                      <div
                        key={row.key}
                        role="presentation"
                        className="absolute top-0 right-0 left-0 grid will-change-transform"
                        style={{
                          transform: `translateY(${row.start}px)`,
                          height: metrics.cardHeight,
                          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                          gap: GRID_GAP,
                        }}
                      >
                        {row.works.map((work) => (
                          <div
                            key={work.id}
                            className="relative transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:z-20 hover:scale-[1.02]"
                          >
                            <WorkCard
                              work={work}
                              rootLabel={rootLabelFor(work)}
                              accent={rootAccentFor(rootAccents, work.root_id)}
                              selected={selectedIds.has(work.id)}
                              thumbnailVisible={thumbnailsVisible}
                              bench={bench}
                              coverHeight={metrics.coverHeight}
                              onToggle={onToggle}
                              onOpen={onOpenWork}
                            />
                          </div>
                        ))}
                      </div>
                    )
                  })}
              </div>
            )}
          </div>

          {/* 日付見出しの sticky。実体の見出しが上に隠れたときだけ重ねて出す。 */}
          {stickyHeader && activeHeader && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 px-5">
              <div className="flex h-[38px] items-end rounded-b-lg border-b border-border bg-card/95 pb-1 backdrop-blur-sm">
                <h2 className="m-0 text-[15px] font-semibold text-foreground tabular-nums">
                  {timelineHeading(activeHeader.section)}
                </h2>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
