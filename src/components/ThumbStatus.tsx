import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ImageIcon, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { ThumbProgress, ThumbStatusInfo, ThumbSummary } from '../api'
import { api } from '../api'
import { describeError } from '../lib/format'

type Props = {
  /** `useThumbnailVisible` の値。false の間は購読も生成も行わない。 */
  visible: boolean
  /** 生成が終わったらライブラリを読み直す（`cover_thumb` が増えるため）。 */
  onGenerated: () => void
}

const FFMPEG_SOURCE_LABEL: Record<string, string> = {
  setting: '設定値',
  sidecar: '同梱 sidecar',
  path: 'PATH',
  fallback: '既定の場所',
  none: '見つかりません',
}

/**
 * サムネイル生成の状態表示（#3 / #19 の UI 配線）。
 *
 * - 表示中に未生成があれば `generate_thumbs` を **1 回だけ**キックする
 * - 進捗は `thumbs://progress`、結果は `thumb_status` から読む
 * - 非表示中（#21 のサムネ非表示）は購読を張らず、生成もしない
 */
export function ThumbStatus({ visible, onGenerated }: Props) {
  const [status, setStatus] = useState<ThumbStatusInfo | null>(null)
  const [progress, setProgress] = useState<ThumbProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<ThumbSummary | null>(null)
  const mounted = useRef(true)
  const kicked = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const next = await api.thumbStatus()
      if (mounted.current) setStatus(next)
    } catch (cause) {
      if (mounted.current) setError(describeError(cause))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    if (!visible) {
      kicked.current = false
      setProgress(null)
      return
    }

    void refresh()
    const unlisten = listen<ThumbProgress>('thumbs://progress', (event) => {
      if (mounted.current) setProgress(event.payload)
    })

    return () => {
      mounted.current = false
      void unlisten.then((off) => off())
    }
  }, [visible, refresh])

  const generate = useCallback(
    async (force = false) => {
      setBusy(true)
      setError(null)
      try {
        const summary = await api.generateThumbs(500, force)
        if (mounted.current) {
          setLast(summary)
          setProgress(null)
        }
        onGenerated()
      } catch (cause) {
        // StrictMode の二重マウントなどで「既に実行中」は失敗として見せない
        const message = describeError(cause)
        if (mounted.current && !message.includes('既に実行中')) setError(message)
      } finally {
        await refresh()
        if (mounted.current) setBusy(false)
      }
    },
    [onGenerated, refresh],
  )

  // 未生成があれば 1 回だけキックする。表示を戻したら再評価する。
  useEffect(() => {
    if (!visible || !status || status.generating || kicked.current) return
    if (status.queue.pending === 0) return
    kicked.current = true
    void generate()
  }, [visible, status, generate])

  const cancel = useCallback(async () => {
    try {
      await api.cancelThumbs()
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [])

  if (!visible || !status) return null

  const generating = busy || status.generating
  const total = progress?.total ?? status.queue.total
  const done = progress?.done ?? status.queue.ready
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const pending = status.queue.pending

  return (
    <div className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
      <div
        className="flex items-center gap-1.5 rounded-full border border-border bg-black/25 py-0.5 pr-1 pl-2"
        title={
          `サムネイル ${status.queue.ready} / ${status.queue.total} 枚（残り ${pending}）\n` +
          `長辺 ${status.settings.max_edge}px / WebP ${status.settings.quality} / 並列 ${status.settings.parallelism}\n` +
          `ffmpeg: ${status.settings.ffmpeg ?? 'なし'}（${
            FFMPEG_SOURCE_LABEL[status.settings.ffmpeg_source] ?? status.settings.ffmpeg_source
          }）` +
          (last
            ? `\n前回: ${last.generated} 枚生成${last.failed > 0 ? ` / ${last.failed} 枚失敗` : ''}${
                last.cancelled ? '（中断）' : ''
              } / ${(last.elapsed_ms / 1000).toFixed(1)} s`
            : '')
        }
      >
        <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {done} / {total}
        </span>
        {generating ? (
          <Progress value={percent} aria-label="サムネイル生成の進捗" className="h-1 w-16" />
        ) : pending > 0 ? (
          <Badge
            variant="outline"
            className="h-4 border-[color-mix(in_oklch,var(--warning)_55%,var(--border))] px-1.5 text-xs text-warning"
          >
            残り {pending}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="h-4 border-[color-mix(in_oklch,var(--success)_55%,var(--border))] px-1.5 text-xs text-success"
          >
            完了
          </Badge>
        )}
        {generating ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="サムネイル生成をキャンセル"
            onClick={() => void cancel()}
          >
            <X />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="サムネイルを生成"
            title="未生成のサムネイルを生成"
            disabled={pending === 0}
            onClick={() => void generate()}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
      {error && (
        <span
          className="max-w-36 truncate text-xs text-destructive"
          title={error}
          role="alert"
        >
          サムネ: {error}
        </span>
      )}
    </div>
  )
}
