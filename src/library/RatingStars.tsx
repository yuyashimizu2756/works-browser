/**
 * 5 段階評価 + お気に入り（#6）。
 *
 * 作品詳細のヘッダと、選択作品への一括評価ダイアログで使う。
 * 同じ星をもう一度押すと未評価（`null`）に戻る。
 */
import { Heart, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  favorite: boolean
  rating: number | null
  onChange: (next: { favorite: boolean; rating: number | null }) => void
  disabled?: boolean
  /** ラベル（未評価 / 3 / 5）を出すか。 */
  showLabel?: boolean
  /** ハートを星の隣に出すか（#99 の詳細ヘッダでは補助情報へ分ける）。 */
  showFavorite?: boolean
  /**
   * #15: 未評価の星の色。既定はパネル背景向けの控えめな色。
   * 黒背景のライトボックスでは `text-white/60` を渡す（コントラスト 7.4:1）。
   */
  unratedClassName?: string
}

const RATINGS = [1, 2, 3, 4, 5] as const

export function RatingStars({
  favorite,
  rating,
  onChange,
  disabled = false,
  showLabel = true,
  showFavorite = true,
  unratedClassName = 'text-muted-foreground/45',
}: Props) {
  return (
    <span className="flex items-center gap-0.5" data-rating-stars data-rating={rating ?? ''}>
      {showFavorite && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
          aria-pressed={favorite}
          data-favorite={favorite ? 'true' : 'false'}
          title={favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
          disabled={disabled}
          className={favorite ? 'text-[var(--highlight)]' : 'text-[var(--text-secondary)]'}
          onClick={() => onChange({ favorite: !favorite, rating })}
        >
          <Heart className={favorite ? 'fill-current' : undefined} aria-hidden="true" />
        </Button>
      )}
      {RATINGS.map((value) => {
        const active = rating !== null && value <= rating
        return (
          <Button
            key={value}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${value} 段階で評価`}
            aria-pressed={rating === value}
            data-rating-value={value}
            title={`${value} 段階（もう一度押すと未評価）`}
            disabled={disabled}
            className={active ? 'text-[var(--warning)]' : unratedClassName}
            onClick={() =>
              onChange({ favorite, rating: rating === value ? null : value })
            }
          >
            <Star className={active ? 'fill-current' : undefined} aria-hidden="true" />
          </Button>
        )
      })}
      {showLabel && (
        <span className="ml-1 text-xs text-muted-foreground tabular-nums">
          {rating === null ? '未評価' : `${rating} / 5`}
        </span>
      )}
    </span>
  )
}
