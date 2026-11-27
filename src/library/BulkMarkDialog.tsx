/**
 * 選択作品への一括評価（#6）。
 *
 * ライブラリの選択バー「評価」から開く。チェックした瞬間に全作品へ保存する。
 * 評価が揃っていないときは「未評価」として開く（星を押すと全件その値になる）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { describeError } from '../lib/format'
import { RatingStars } from './RatingStars'
import { notifyTagsChanged, tagData } from './tagData'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  workIds: number[]
  onApplied?: () => void
}

export function BulkMarkDialog({ open, onOpenChange, workIds, onApplied }: Props) {
  const [favorite, setFavorite] = useState(false)
  const [rating, setRating] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ids = workIds

  useEffect(() => {
    if (!open || ids.length === 0) return
    let alive = true
    setFavorite(false)
    setRating(null)
    setError(null)
    void Promise.all(ids.map((workId) => tagData().getWorkMark(workId)))
      .then((marks) => {
        if (!alive) return
        if (marks.length === 0) return
        setFavorite(marks.every((mark) => mark.favorite))
        const first = marks[0].rating
        setRating(
          marks.every((mark) => mark.rating === first) ? first : null,
        )
      })
      .catch((cause: unknown) => {
        if (alive) setError(describeError(cause))
      })
    return () => {
      alive = false
    }
  }, [open, ids])

  const change = useCallback(
    (next: { favorite: boolean; rating: number | null }) => {
      if (ids.length === 0) return
      setFavorite(next.favorite)
      setRating(next.rating)
      setBusy(true)
      setError(null)
      void Promise.all(
        ids.map((workId) =>
          tagData().setWorkMark(workId, {
            favorite: next.favorite,
            rating: next.rating,
          }),
        ),
      )
        .then(() => {
          notifyTagsChanged()
          onApplied?.()
        })
        .catch((cause: unknown) => setError(describeError(cause)))
        .finally(() => setBusy(false))
    },
    [ids, onApplied],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-bulk-mark>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Star className="size-4" aria-hidden="true" />
            評価
            <Badge variant="secondary" className="tabular-nums">
              {ids.length} 件
            </Badge>
          </DialogTitle>
          <DialogDescription>
            選んだ作品すべてに同じ評価を付けます。もう一度押すと未評価に戻ります。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
          <RatingStars
            favorite={favorite}
            rating={rating}
            onChange={change}
            disabled={busy || ids.length === 0}
          />
        </div>

        {error && (
          <p className="m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          {busy && (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              保存中…
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
