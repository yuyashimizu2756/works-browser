import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Film, ImageIcon, Layers } from 'lucide-react'
import { cn } from 'cn'
import { rowsPerScreen, wantsNextPage } from '../lib/prefetch'
import { useDelayedVisible } from '../lib/useDelayedVisible'
import { Checkbox } from '@/components/ui/checkbox'
import type { FileSummary, WorkSummary } from '../api'
import { formatBytes, formatCount, formatDuration, formatShortDate } from '../lib/format'
import { installBenchHarness } from './bench'
import { rootAccentFor } from './accents'
import type { WorkSelectModifiers } from './WorkCard'

const ROW_HEIGHT = 44

type VirtualRowsProps = {
  /** 仮想スクロールの行数（DB の total）。 */
  count: number
  /** 読み込み済みの行数（ページング）。 */
  loaded: number
  loading: boolean
  hasMore: boolean
  onLoadMore: () => void
  empty: ReactNode
  resetKey: string
  bench: boolean
  ariaLabel: string
  gridTemplate: string
  header: ReactNode
  renderRow: (index: number) => ReactNode
  /** 最初のページが届くまでの時間（ベンチ計測用）。 */
  firstPageMs?: number | null
}

/** サムネ非表示モードの共通リスト（#21）。画像は 1 枚も描画しない。 */
function VirtualRows({
  count,
  loaded,
  loading,
  hasMore,
  onLoadMore,
  empty,
  resetKey,
  bench,
  ariaLabel,
  gridTemplate,
  header,
  renderRow,
  firstPageMs,
}: VirtualRowsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)

  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollElement(node)
  }, [])

  useEffect(() => {
    if (!scrollElement) return
    const update = () => setViewportHeight(scrollElement.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(scrollElement)
    return () => observer.disconnect()
  }, [scrollElement])

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const virtualRows = virtualizer.getVirtualItems()
  const lastIndex = virtualRows[virtualRows.length - 1]?.index ?? 0

  // #49: 残り 2 画面になったら次のページを要求する（末端まで待たない）。
  // 二重取得は useWorkFeed / useFileFeed の pending フラグで防ぐ。
  const rowsAhead = rowsPerScreen(viewportHeight, ROW_HEIGHT) * 2
  useEffect(() => {
    if (!hasMore || loading) return
    if (wantsNextPage({ lastRowIndex: lastIndex, columns: 1, loaded, rowsAhead })) onLoadMore()
  }, [lastIndex, loaded, hasMore, loading, onLoadMore, rowsAhead])

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollTop = 0
  }, [resetKey])

  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const countRef = useRef(count)
  countRef.current = count

  useEffect(() => {
    if (!bench) return
    const element = scrollRef.current
    if (!element) return
    return installBenchHarness(element, {
      loaded: () => loadedRef.current,
      total: () => countRef.current,
      columns: () => 1,
    })
  }, [bench])

  const initialLoading = loading && loaded === 0
  // #100: 200ms 未満の読み込みではスケルトンを出さない（ちらつき防止）。
  const showSkeleton = useDelayedVisible(initialLoading)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="grid flex-none items-center gap-2 border-b border-border px-5 py-1.5 text-xs font-semibold tracking-[0.06em] whitespace-nowrap text-muted-foreground uppercase"
        style={{ gridTemplateColumns: gridTemplate }}
        aria-hidden="true"
      >
        {header}
      </div>
      <div
        ref={attachScroll}
        data-scroll-region
        data-shortcut-region
        className={cn(
          'min-h-0 flex-1 overflow-x-hidden overflow-y-auto contain-[layout_paint] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border',
        )}
        role="list"
        aria-label={ariaLabel}
        aria-busy={initialLoading || undefined}
        data-compact-list
        data-loaded={loaded}
        data-total={count}
        data-first-page-ms={firstPageMs ?? undefined}
      >
        {!loading && count === 0 ? (
          <div className="flex min-h-full items-center justify-center px-5 py-10">{empty}</div>
        ) : showSkeleton ? (
          <div className="px-5 py-2">
            {Array.from({ length: 12 }, (_, index) => (
              <div
                key={index}
                className="mb-1 h-10 animate-pulse rounded-md bg-white/[0.05]"
                aria-hidden="true"
              />
            ))}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((virtualRow) => (
              <div
                key={virtualRow.key}
                role="presentation"
                className="absolute top-0 right-0 left-0 grid items-center gap-2 px-5"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: ROW_HEIGHT,
                  gridTemplateColumns: gridTemplate,
                }}
              >
                {renderRow(virtualRow.index)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const WORK_GRID = '1.5rem minmax(0,1fr) 5.5rem 5rem 6rem'
const FILE_GRID = '1.5rem minmax(0,1fr) minmax(6rem,0.7fr) 4rem 5rem 6rem'

const KIND_ICON: Record<'image' | 'video' | 'mixed', ReactNode> = {
  image: <ImageIcon className="size-4 text-[var(--accent-cyan)]" aria-hidden="true" />,
  video: <Film className="size-4 text-[var(--accent-violet)]" aria-hidden="true" />,
  mixed: <Layers className="size-4 text-[var(--accent-amber)]" aria-hidden="true" />,
}

type WorksProps = {
  works: WorkSummary[]
  total: number
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  onOpen: (work: WorkSummary) => void
  onToggle: (work: WorkSummary, modifiers: WorkSelectModifiers) => void
  selectedIds: ReadonlySet<number>
  rootLabels: Map<number, string>
  rootAccents: Map<number, string>
  resetKey: string
  bench: boolean
  empty: ReactNode
}

/**
 * サムネ非表示 + 作品モードのコンパクトリスト。
 * 種類アイコン + タイトル + 本数 + サイズ + 日付。選択操作はグリッドと同じ。
 */
export function CompactWorksList({
  works,
  total,
  hasMore,
  loading,
  onLoadMore,
  onOpen,
  onToggle,
  selectedIds,
  rootLabels,
  rootAccents,
  resetKey,
  bench,
  empty,
}: WorksProps) {
  /** 単クリック → ダブルクリック / Enter の二重遷移ガード（#27）。 */
  const lastOpenRef = useRef(Number.NEGATIVE_INFINITY)
  const openWork = (work: WorkSummary) => {
    const now = performance.now()
    if (now - lastOpenRef.current < 500) return
    lastOpenRef.current = now
    onOpen(work)
  }

  return (
    <VirtualRows
      count={total}
      loaded={works.length}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      empty={empty}
      resetKey={resetKey}
      bench={bench}
      ariaLabel="作品一覧（サムネ非表示）"
      gridTemplate={WORK_GRID}
      header={
        <>
          <span />
          <span>作品</span>
          <span className="text-right">本数</span>
          <span className="text-right">サイズ</span>
          <span className="text-right">更新日</span>
        </>
      }
      renderRow={(index) => {
        const work = works[index]
        if (!work) return null
        const selected = selectedIds.has(work.id)
        const accent = rootAccentFor(rootAccents, work.root_id)
        const rootLabel = rootLabels.get(work.root_id) ?? ''
        return (
          <div
            role="listitem"
            tabIndex={0}
            data-work-id={work.id}
            data-selected={selected ? 'true' : undefined}
            aria-selected={selected}
            title={`${work.title} — ${work.rel_path}`}
            className={cn(
              'col-span-full flex h-10 min-w-0 cursor-default items-center gap-2 rounded-md border px-1.5',
              'transition-[border-color,background-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
              selected
                ? 'border-[var(--root-accent)] bg-[color-mix(in_oklch,var(--root-accent)_9%,transparent)]'
                : 'border-transparent hover:bg-white/[0.05]',
            )}
            style={{ '--root-accent': accent } as CSSProperties}
            onClick={(event) => {
              if (event.detail > 1) return
              openWork(work)
            }}
            onDoubleClick={() => openWork(work)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                openWork(work)
              }
            }}
          >
            <span
              className="flex size-6 items-center justify-center"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                if (event.target === event.currentTarget) {
                  onToggle(work, { ctrl: event.ctrlKey, shift: event.shiftKey })
                }
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                // Space / Enter はチェックのトグルに使うので本体（開く）へ流さない。Esc などは通す。
                if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
              }}
            >
              <Checkbox
                checked={selected}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggle(work, { ctrl: event.ctrlKey, shift: event.shiftKey })
                }}
                aria-label={selected ? `${work.title} の選択を解除` : `${work.title} を選択`}
                className={cn(
                  'size-4 border-border after:inset-0',
                  'data-checked:border-[var(--root-accent)] data-checked:bg-[var(--root-accent)] data-checked:text-white',
                  'data-[state=checked]:border-[var(--root-accent)] data-[state=checked]:bg-[var(--root-accent)] data-[state=checked]:text-white',
                )}
              />
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="flex size-4 shrink-0 justify-center">{KIND_ICON[work.kind]}</span>
              <span className="truncate text-[13px] font-medium">{work.title}</span>
              {rootLabel && (
                <span className="truncate text-xs text-muted-foreground/70">
                  {rootLabel}
                </span>
              )}
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatCount(work.file_count)}
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatBytes(work.total_bytes)}
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatShortDate(work.mtime)}
            </span>
          </div>
        )
      }}
    />
  )
}

type FilesProps = {
  files: FileSummary[]
  total: number
  hasMore: boolean
  loading: boolean
  onLoadMore: () => void
  onOpen: (file: FileSummary) => void
  onToggle: (file: FileSummary, modifiers: WorkSelectModifiers) => void
  selectedIds: ReadonlySet<number>
  rootLabels: Map<number, string>
  rootAccents: Map<number, string>
  resetKey: string
  bench: boolean
  empty: ReactNode
  firstPageMs?: number | null
}

/**
 * サムネ非表示 + ファイルモードのコンパクトリスト。
 * 種類アイコン + ファイル名 + 作品名 + 長さ + サイズ + 日付。
 */
export function CompactFilesList({
  files,
  total,
  hasMore,
  loading,
  onLoadMore,
  onOpen,
  onToggle,
  selectedIds,
  rootLabels,
  rootAccents,
  resetKey,
  bench,
  empty,
  firstPageMs,
}: FilesProps) {
  /** 単クリック → ダブルクリック / Enter の二重遷移ガード（#27）。 */
  const lastOpenRef = useRef(Number.NEGATIVE_INFINITY)
  const openFile = (file: FileSummary) => {
    const now = performance.now()
    if (now - lastOpenRef.current < 500) return
    lastOpenRef.current = now
    onOpen(file)
  }

  return (
    <VirtualRows
      count={total}
      loaded={files.length}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      empty={empty}
      resetKey={resetKey}
      bench={bench}
      firstPageMs={firstPageMs}
      ariaLabel="ファイル一覧（サムネ非表示）"
      gridTemplate={FILE_GRID}
      header={
        <>
          <span />
          <span>ファイル</span>
          <span>作品</span>
          <span className="text-right">長さ</span>
          <span className="text-right">サイズ</span>
          <span className="text-right">更新日</span>
        </>
      }
      renderRow={(index) => {
        const file = files[index]
        if (!file) return null
        const selected = selectedIds.has(file.id)
        return (
          <div
            role="listitem"
            tabIndex={0}
            data-file-id={file.id}
            data-file-kind={file.kind}
            data-work-id={file.work_id}
            data-selected={selected ? 'true' : undefined}
            aria-selected={selected}
            title={`${file.work_title} — ${file.rel_path}`}
            className={cn(
              'col-span-full flex h-10 min-w-0 items-center gap-2 rounded-md border px-1.5',
              'transition-[border-color,background-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
              selected
                ? 'border-[var(--root-accent)] bg-[color-mix(in_oklch,var(--root-accent)_9%,transparent)]'
                : 'border-transparent hover:bg-white/[0.05]',
            )}
            style={
              {
                '--root-accent': rootAccentFor(rootAccents, file.root_id),
              } as CSSProperties
            }
            onClick={(event) => {
              if (event.detail > 1) return
              openFile(file)
            }}
            onDoubleClick={() => openFile(file)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                openFile(file)
              }
            }}
          >
            <span
              className="flex size-6 items-center justify-center"
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
            >
              <Checkbox
                checked={selected}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggle(file, { ctrl: event.ctrlKey, shift: event.shiftKey })
                }}
                aria-label={selected ? `${file.name} の選択を解除` : `${file.name} を選択`}
                className={cn(
                  'size-4 border-border after:inset-0',
                  'data-checked:border-[var(--root-accent)] data-checked:bg-[var(--root-accent)] data-checked:text-white',
                  'data-[state=checked]:border-[var(--root-accent)] data-[state=checked]:bg-[var(--root-accent)] data-[state=checked]:text-white',
                )}
              />
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="flex size-4 shrink-0 justify-center">
                {file.kind === 'video' ? (
                  <Film className="size-4 text-[var(--accent-violet)]" aria-hidden="true" />
                ) : (
                  <ImageIcon className="size-4 text-[var(--accent-cyan)]" aria-hidden="true" />
                )}
              </span>
              <span className="truncate text-[13px] font-medium">{file.name}</span>
              {file.has_meta && (
                <span
                  className="shrink-0 rounded border border-border px-1 text-xs font-semibold text-[var(--accent-cyan)]"
                  title="生成情報あり（meta）"
                  data-meta-badge
                >
                  meta
                </span>
              )}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="size-1.5 shrink-0 rounded-full bg-[var(--root-accent)]"
                aria-hidden="true"
              />
              <span className="truncate text-xs text-muted-foreground">
                {file.work_title || rootLabels.get(file.root_id) || ''}
              </span>
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatDuration(file.duration_ms)}
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatBytes(file.bytes)}
            </span>
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {formatShortDate(file.mtime)}
            </span>
          </div>
        )
      }}
    />
  )
}
