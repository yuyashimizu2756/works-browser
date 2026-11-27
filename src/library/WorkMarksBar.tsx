/**
 * 作品詳細ヘッダの評価・タグ・開封回数（#6 / #99）。
 *
 * マウント時に `record_open` を 1 回呼び、`open_count` / `last_opened_at` を記録する。
 * 評価・お気に入りは押した瞬間に保存する。タグは `TagEditor` のダイアログで編集する。
 *
 * #14: ベンチ / デモ（`?bench=N&demo=1`）では実 DB に書き込まない。表示は固定値
 * （`BENCH_MARK` / `BENCH_TAGS`）にし、保存系の操作は disabled + ツールチップ案内にする。
 *
 * レイアウト（#99）: 評価は独立した行（星 + 数値 / 未評価）。お気に入り・タグ・開封数は
 * 右側の補助情報へ寄せ、星のラベルと「未評価」が重複しないようにする。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Heart } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import type { Tag, WorkMark } from '../api'
import { describeError } from '../lib/format'
import { RatingStars } from './RatingStars'
import { TagEditorButton } from './TagEditorButton'
import { emptyMark, MARK_CHANGED_EVENT, notifyTagsChanged, tagData } from './tagData'

/** #14: ベンチ / デモで表示する固定値（読み書きしない）。 */
const BENCH_MARK: Omit<WorkMark, 'work_id'> = {
  favorite: true,
  rating: 4,
  note: null,
  last_opened_at: null,
  open_count: 3,
}

/** #14: ベンチ / デモで表示する固定タグ（読み取り専用）。 */
const BENCH_TAGS: Tag[] = [
  { id: -1, name: 'サンプル', color: '#22d3ee', created_at: 0, works: 0 },
  { id: -2, name: 'シリーズ', color: '#ec4899', created_at: 0, works: 0 },
]

/** #14: 保存できない理由（ツールチップ / テスト用）。 */
export const BENCH_SAVE_HINT = 'ベンチモードでは保存されません'

function benchMark(workId: number): WorkMark {
  return { work_id: workId, ...BENCH_MARK }
}

type Props = {
  workId: number
  /** ベンチモードでは接続エラーを出さない（メモリ上の実装で動く）。 */
  bench?: boolean
  /** ルート名（補助情報としてメタ行に出す）。 */
  rootLabel?: string
  /** 題名の下に置く、ファイル数・サイズ・日付（#108 でメタ行へ統合）。 */
  meta?: ReactNode
}

export function WorkMarksBar({ workId, bench = false, rootLabel = '', meta }: Props) {
  const [mark, setMark] = useState<WorkMark>(() => (bench ? benchMark(workId) : emptyMark(workId)))
  const [tags, setTags] = useState<Tag[]>(() => (bench ? BENCH_TAGS : []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // StrictMode の二重マウントでも 1 回しか数えない（作品ごとに 1 回）
  const recordedRef = useRef<number | null>(null)

  const reloadTags = useCallback(() => {
    void tagData()
      .getWorkTags(workId)
      .then((next) => setTags(next))
      .catch(() => {
        // タグが読めなくても評価は使える
      })
  }, [workId])

  useEffect(() => {
    let alive = true
    setError(null)
    // #14: ベンチ / デモは実 DB を読み書きせず、固定値を表示する
    if (bench) {
      recordedRef.current = workId
      setMark(benchMark(workId))
      return () => {
        alive = false
      }
    }
    setMark(emptyMark(workId))
    if (recordedRef.current !== workId) {
      recordedRef.current = workId
      void tagData()
        .recordOpen(workId)
        .then((next) => {
          if (alive) setMark(next)
        })
        .catch((cause: unknown) => {
          // Tauri 未接続でも表示は続ける
          if (alive) setError(describeError(cause))
        })
    } else {
      // StrictMode の再マウント: 記録は増やさず、保存済みの値を読み直す
      void tagData()
        .getWorkMark(workId)
        .then((next) => {
          if (alive) setMark(next)
        })
        .catch(() => {
          // 読めなくても表示は続ける
        })
    }
    return () => {
      alive = false
    }
  }, [bench, workId])

  useEffect(() => {
    // #14: ベンチ / デモは固定タグを読み取り専用で見せる
    if (bench) {
      setTags(BENCH_TAGS)
      return
    }
    setTags([])
    reloadTags()
  }, [bench, reloadTags])

  // #71: キーボード（1〜5 / F）で評価・お気に入りが変わったら、ヘッダの星を読み直す
  useEffect(() => {
    if (bench) return
    let alive = true
    const onMarkChanged = (event: Event) => {
      const changed = (event as CustomEvent<{ workId?: number }>).detail?.workId
      if (changed !== workId) return
      void tagData()
        .getWorkMark(workId)
        .then((next) => {
          if (alive) setMark(next)
        })
        .catch(() => {
          // 読めなくても次の操作で再取得される
        })
    }
    window.addEventListener(MARK_CHANGED_EVENT, onMarkChanged)
    return () => {
      alive = false
      window.removeEventListener(MARK_CHANGED_EVENT, onMarkChanged)
    }
  }, [bench, workId])

  const change = useCallback(
    (next: { favorite: boolean; rating: number | null }) => {
      // #14: ベンチ / デモでは保存しない
      if (bench) return
      setBusy(true)
      setError(null)
      setMark((prev) => ({ ...prev, ...next }))
      void tagData()
        .setWorkMark(workId, { favorite: next.favorite, rating: next.rating, note: mark.note })
        .then((saved) => {
          setMark(saved)
          notifyTagsChanged()
        })
        .catch((cause: unknown) => setError(describeError(cause)))
        .finally(() => setBusy(false))
    },
    [bench, mark.note, workId],
  )

  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      data-work-marks
      data-open-count={mark.open_count}
      data-bench-locked={bench ? 'true' : undefined}
      // #14: disabled なボタンは pointer-events が切れるため、領域全体で理由を案内する
      title={bench ? BENCH_SAVE_HINT : undefined}
    >
      {/*
        #108: 右側に散っていた小さなチップ（お気に入り / 開封 / ルート）を
        ファイル数・サイズ・日付と同じ 1 行のメタへ統合した。タグだけは
        現行どおりチップのまま残す。
      */}
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-secondary)] tabular-nums"
        data-work-meta
      >
        {meta !== undefined && (
          <>
            {meta}
            <span aria-hidden="true">·</span>
          </>
        )}

        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={mark.favorite ? 'お気に入りから外す' : 'お気に入りに追加'}
          aria-pressed={mark.favorite}
          data-favorite={mark.favorite ? 'true' : 'false'}
          title={
            bench
              ? BENCH_SAVE_HINT
              : mark.favorite
                ? 'お気に入りから外す（F）'
                : 'お気に入りに追加（F）'
          }
          disabled={bench || busy}
          className={cn(
            'h-5 gap-1 rounded-full px-1 text-xs font-normal',
            mark.favorite
              ? 'text-[var(--brand)] hover:text-[var(--brand)]'
              : 'text-[var(--text-secondary)]',
          )}
          onClick={() => change({ favorite: !mark.favorite, rating: mark.rating })}
        >
          <Heart
            className={cn('size-3', mark.favorite && 'fill-current')}
            aria-hidden="true"
          />
          お気に入り
        </Button>

        {mark.open_count > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              title="この作品を開いた回数"
              data-open-count-label
            >
              <Check className="size-3" aria-hidden="true" />
              開封 {mark.open_count} 回
            </span>
          </>
        )}

        {rootLabel !== '' && (
          <>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-1.5 rounded-full bg-[var(--root-accent)]"
                aria-hidden="true"
              />
              <span className="max-w-40 truncate">{rootLabel}</span>
            </span>
          </>
        )}

        {tags.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--text-secondary)]"
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: tag.color }}
              aria-hidden="true"
            />
            {tag.name}
          </span>
        ))}
        <TagEditorButton
          workIds={[workId]}
          onChanged={reloadTags}
          size="xs"
          label="タグ"
          disabled={bench}
          title={bench ? BENCH_SAVE_HINT : undefined}
        />
      </div>

      {/* 評価（独立した行）。星は操作、右のテキストが値。 */}
      <span className="flex items-center gap-2" data-rating-row>
        <span className="text-xs text-[var(--text-secondary)]">評価</span>
        <RatingStars
          favorite={mark.favorite}
          rating={mark.rating}
          onChange={(next) => change({ favorite: next.favorite, rating: next.rating })}
          disabled={bench || busy}
          showFavorite={false}
          showLabel={false}
        />
        <span
          className="text-xs text-[var(--text-secondary)] tabular-nums"
          data-rating-label
          aria-live="polite"
        >
          {mark.rating === null ? '未評価' : `${mark.rating} / 5`}
        </span>
      </span>

      {error && (
        <span className="text-xs text-[var(--destructive)]" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
