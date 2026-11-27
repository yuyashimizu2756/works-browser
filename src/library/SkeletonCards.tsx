import { Skeleton } from '@/components/ui/skeleton'
import { CARD_META_HEIGHT, GRID_GAP } from './gridMetrics'

type Props = {
  /** 4:3 のカバー高さ。 */
  coverHeight: number
  /** カバー + メタ。 */
  cardHeight: number
  /** 列数（#100 の既定は 3 列 × 2 行）。 */
  columns?: number
  count?: number
  gap?: number
  className?: string
}

/**
 * #100: カード形状を保つスケルトン。
 *
 * 実カードと同じ 4:3 のカバー + 2 行のメタを 3 列 × 2 行（6 枚）で描く。
 * 表示するかどうかは `useDelayedVisible`（200ms）に任せ、素早い読み込みでは
 * 出さない。
 */
export function SkeletonCards({
  coverHeight,
  cardHeight,
  columns = 3,
  count = 6,
  gap = GRID_GAP,
  className,
}: Props) {
  return (
    <div
      data-skeleton-grid
      aria-hidden="true"
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap,
      }}
    >
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          data-skeleton-card
          className="overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface)] shadow-[inset_0_0_0_1px_var(--line)]"
          style={{ height: cardHeight }}
        >
          <Skeleton className="w-full rounded-none" style={{ height: coverHeight }} />
          <div
            className="flex flex-col justify-center gap-2 px-3"
            style={{ height: CARD_META_HEIGHT }}
          >
            <Skeleton className="h-3 w-2/3 rounded" />
            <Skeleton className="h-2.5 w-1/2 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}
