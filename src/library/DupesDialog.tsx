/**
 * #67: 重複・類似画像の整理ダイアログ。
 *
 * 似た機能を持つアプリ（Eagle の重複スキャン / Hydrus の similar files）に倣い、
 * 1. 索引済みファイルの内容ハッシュ（完全一致）と dHash（類似）を解析
 * 2. グループごとに「残す 1 枚」を提案
 * 3. 残りをまとめてゴミ箱へ（確認・Undo は既存の削除フローに任せる）
 *
 * 解析は重いので、ボタンを押したときだけ実行する。結果は DB に残る。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Copy, Film, Image as ImageIcon, Layers, Loader2, Trash2 } from 'lucide-react'

import { api } from '@/api'
import type { DupGroup, DupesProgress, DupesStats } from '@/api'
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
import { describeError, formatBytes, formatCount } from '../lib/format'
import { mediaSrc } from './mediaSrc'
import { ChipButton } from './ChipButton'
import { keeperOf, removalIds, wastedBytes } from './dupes'

type Mode = 'exact' | 'similar'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** キーパー以外を削除する（確認ダイアログと Undo は App 側）。 */
  onDelete: (ids: number[], bytes: number) => void
}

const THRESHOLDS = [
  { value: 4, label: 'ごく近い' },
  { value: 8, label: '近い（既定）' },
  { value: 12, label: 'ゆるい' },
]

export function DupesDialog({ open, onOpenChange, onDelete }: Props) {
  const [mode, setMode] = useState<Mode>('exact')
  const [threshold, setThreshold] = useState(8)
  const [stats, setStats] = useState<DupesStats | null>(null)
  const [groups, setGroups] = useState<DupGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [progress, setProgress] = useState<DupesProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** グループごとの「残す 1 枚」の上書き。 */
  const [keepers, setKeepers] = useState<Record<string, number>>({})
  const mounted = useRef(true)
  const cancelRef = useRef(false)

  const load = useCallback(
    async (nextMode: Mode, nextThreshold: number) => {
      setLoading(true)
      setError(null)
      try {
        const [nextStats, nextGroups] = await Promise.all([
          api.dupesStats(),
          api.dupesGroups(nextMode, nextThreshold, 60),
        ])
        if (!mounted.current) return
        setStats(nextStats)
        setGroups(nextGroups)
      } catch (cause) {
        if (mounted.current) setError(describeError(cause))
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setKeepers({})
    setProgress(null)
    void load(mode, threshold)
  }, [open, mode, threshold, load])

  useEffect(() => {
    if (!open) return
    const unlisten = listen<DupesProgress>('dupes://progress', (event) => {
      if (mounted.current) setProgress(event.payload)
    })
    return () => {
      void unlisten.then((off) => off())
    }
  }, [open])

  const analyze = useCallback(async () => {
    setAnalyzing(true)
    cancelRef.current = false
    setError(null)
    try {
      // 残りが 0 になるまで 1 バッチずつ回す（UI を固めない）
      for (;;) {
        if (cancelRef.current) break
        const summary = await api.dupesAnalyze(1200)
        if (!mounted.current) return
        if (summary.cancelled || summary.remaining === 0) break
        if (summary.total === 0) break
      }
    } catch (cause) {
      if (mounted.current) setError(describeError(cause))
    } finally {
      if (mounted.current) {
        setAnalyzing(false)
        setProgress(null)
      }
      await load(mode, threshold)
    }
  }, [load, mode, threshold])

  const cancelAnalysis = useCallback(async () => {
    cancelRef.current = true
    try {
      await api.cancelDupes()
    } catch {
      // 実行していなければ false が返るだけ
    }
  }, [])

  const removeGroup = useCallback(
    (group: DupGroup) => {
      const keeperId = keepers[group.key]
      const ids = removalIds(group, keeperId)
      if (ids.length === 0) return
      onDelete(ids, wastedBytes(group, keeperId))
      onOpenChange(false)
    },
    [keepers, onDelete, onOpenChange],
  )

  const pending = stats?.pending ?? 0
  const percent = progress && progress.total > 0 ? progress.done / progress.total : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[min(960px,92vw)] max-w-none flex-col" data-dupes>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Layers className="size-4" aria-hidden="true" />
            重複・類似を整理
          </DialogTitle>
          <DialogDescription>
            内容が同じファイルと、見た目が近い画像をまとめます。「残す 1 枚」以外をゴミ箱へ移せます（Undo 可）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-black/25 p-0.5" role="group" aria-label="判定方法">
            <ChipButton active={mode === 'exact'} onClick={() => setMode('exact')}>
              完全一致
            </ChipButton>
            <ChipButton active={mode === 'similar'} onClick={() => setMode('similar')}>
              類似
            </ChipButton>
          </div>

          {mode === 'similar' && (
            <div className="flex items-center gap-1" role="group" aria-label="類似のしきい値">
              {THRESHOLDS.map((option) => (
                <ChipButton
                  key={option.value}
                  active={threshold === option.value}
                  onClick={() => setThreshold(option.value)}
                  title={`ハミング距離 ${option.value} / 64bit`}
                >
                  {option.label}
                </ChipButton>
              ))}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {stats && (
              <span className="text-xs text-muted-foreground tabular-nums">
                解析済み {formatCount(stats.hashed)} / {formatCount(stats.total)}
                {pending > 0 && `（残り ${formatCount(pending)}）`}
              </span>
            )}
            {analyzing ? (
              <Button variant="outline" size="sm" onClick={() => void cancelAnalysis()}>
                解析を中止
              </Button>
            ) : (
              <Button size="sm" onClick={() => void analyze()} disabled={loading}>
                <Copy data-icon="inline-start" />
                {pending > 0 ? '解析する' : '再解析'}
              </Button>
            )}
          </div>
        </div>

        {analyzing && (
          <div className="flex flex-col gap-1" role="status">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.round(percent * 100)}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {progress ? `${formatCount(progress.done)} / ${formatCount(progress.total)} 件` : '準備中…'}
              （画像は 1 枚あたり数十 ms。中止してもここまでの結果は残ります）
            </span>
          </div>
        )}

        {error && (
          <p className="m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading && groups.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              読み込み中…
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
              <Layers className="size-6 opacity-60" aria-hidden="true" />
              <p className="m-0">
                {mode === 'exact'
                  ? '完全一致の重複はありません。'
                  : '類似のグループはありません（しきい値をゆるめると増えます）。'}
              </p>
              {pending > 0 && (
                <p className="m-0 text-xs">
                  未解析が {formatCount(pending)} 件あります。先に「解析する」を実行してください。
                </p>
              )}
            </div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {groups.map((group) => {
                const keeperId = keepers[group.key]
                const keeper = keeperOf(group, keeperId)
                const wasted = wastedBytes(group, keeperId)
                return (
                  <li key={group.key} className="rounded-xl border border-border bg-card/40 p-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="tabular-nums">
                        {group.files.length} 枚
                      </Badge>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        余分 {formatBytes(wasted)} / 合計 {formatBytes(group.total_bytes)}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="ml-auto"
                        onClick={() => removeGroup(group)}
                        title="キーパー以外をゴミ箱へ移します"
                      >
                        <Trash2 data-icon="inline-start" />
                        他をゴミ箱へ
                      </Button>
                    </div>

                    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2 p-0">
                      {group.files.map((file) => {
                        const isKeeper = keeper?.id === file.id
                        const src = file.kind === 'image' ? mediaSrc(file.id) : null
                        return (
                          <li key={file.id}>
                            <button
                              type="button"
                              className={`group flex w-full flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors ${
                                isKeeper
                                  ? 'border-primary/70 bg-primary/10'
                                  : 'border-border/70 bg-black/20 hover:border-border'
                              }`}
                              onClick={() =>
                                setKeepers((current) => ({ ...current, [group.key]: file.id }))
                              }
                              title={`${file.rel_path}\nクリックで「残す 1 枚」に指定`}
                            >
                              <span className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-black/40">
                                {src ? (
                                  <img
                                    src={src}
                                    alt=""
                                    loading="lazy"
                                    className="size-full object-cover"
                                    draggable={false}
                                  />
                                ) : file.kind === 'image' ? (
                                  <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                                ) : (
                                  <Film className="size-5 text-muted-foreground" aria-hidden="true" />
                                )}
                                {isKeeper && (
                                  <span className="absolute top-1 left-1 rounded bg-primary px-1 py-px text-xs font-semibold text-primary-foreground">
                                    残す
                                  </span>
                                )}
                              </span>
                              <span className="truncate text-xs text-foreground" title={file.name}>
                                {file.name}
                              </span>
                              <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                                {file.kind === 'image' ? (
                                  <ImageIcon className="size-3" aria-hidden="true" />
                                ) : (
                                  <Film className="size-3" aria-hidden="true" />
                                )}
                                {file.width && file.height ? `${file.width}×${file.height}` : '—'}
                                <span aria-hidden="true">·</span>
                                {formatBytes(file.bytes)}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="flex-none">
          <span className="mr-auto text-xs text-muted-foreground">
            {stats && stats.exact_groups > 0
              ? `完全一致 ${formatCount(stats.exact_groups)} グループ / 余分 ${formatBytes(stats.exact_wasted_bytes)}`
              : '解析結果はこの PC の索引に保存されます'}
          </span>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
