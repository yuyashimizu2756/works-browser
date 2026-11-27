import { useEffect, useState } from 'react'
import { AlertTriangle, FolderInput, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import type { MoveOutcome, MovePlan, MoveProgress } from '../api'
import { formatBytes, formatCount } from '../lib/format'

const LARGE_BYTES = 5 * 1024 * 1024 * 1024

function percentOf(progress: MoveProgress | null): number {
  if (!progress || progress.total_bytes <= 0) return 0
  return Math.min(100, Math.round((progress.moved_bytes / progress.total_bytes) * 100))
}

/**
 * 移動前の確認ダイアログ（#57）。
 *
 * 移動先のフルパス・ファイル数・合計サイズ・同一 / 別ボリュームを必ず出し、
 * 5GB 超または別ボリュームのときは「時間がかかります」と明示する。
 * 同一ボリュームだけ「5 秒間は元に戻せる」ことを伝える。
 */
export function MoveConfirmDialog({
  plan,
  busy,
  progress,
  onClose,
  onConfirm,
  onCancelRunning,
}: {
  plan: MovePlan | null
  busy: boolean
  progress: MoveProgress | null
  onClose: () => void
  onConfirm: () => void
  onCancelRunning: () => void
}) {
  if (!plan) return null

  const percent = percentOf(progress)
  const slow = !plan.same_volume || plan.total_bytes >= LARGE_BYTES
  const warnings = plan.warning?.split('\n').filter(Boolean) ?? []

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        data-move-dialog
        data-same-volume={plan.same_volume ? 'true' : 'false'}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="size-4 text-primary" aria-hidden="true" />
            作品「{plan.title}」を「{plan.target_root_label}」へ移動します
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
            <span>{formatCount(plan.file_count)} ファイル</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(plan.total_bytes)}</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                plan.same_volume
                  ? 'font-medium text-[var(--accent-cyan)]'
                  : 'font-medium text-[var(--warning)]'
              }
            >
              {plan.same_volume ? '同一ボリューム' : '別ボリューム'}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 rounded-lg border border-border bg-black/20 px-3 py-2 text-xs">
          <span className="text-xs text-muted-foreground">移動先</span>
          <code
            className="break-all text-xs text-foreground"
            data-move-target-path
          >
            {plan.target_path}
          </code>
          {plan.conflict_renamed && (
            <span className="text-xs text-[var(--warning)]">
              同名のフォルダがあるため「{plan.target_name}」に変更します（上書きしません）
            </span>
          )}
        </div>

        {warnings.length > 0 && (
          <ul
            className="m-0 flex list-none flex-col gap-1 rounded-lg border border-border bg-black/10 px-3 py-2 text-xs text-muted-foreground"
            role="note"
            data-move-warning
          >
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5">
                <AlertTriangle
                  className={`mt-px size-3.5 flex-none ${
                    slow ? 'text-[var(--warning)]' : 'text-muted-foreground'
                  }`}
                  aria-hidden="true"
                />
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        )}

        {!plan.same_volume && (
          <p className="m-0 text-xs text-muted-foreground">
            別ボリュームの移動はコピー完了後に移動元を削除します。取り消しはできません
            （移動後に元の場所へ戻す場合はエクスプローラで移動してください）。
          </p>
        )}

        {busy && (
          <div className="flex flex-col gap-1.5" role="status" aria-live="polite" data-move-progress>
            <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
              <span>
                移動中…{' '}
                {progress
                  ? `${formatBytes(progress.moved_bytes)} / ${formatBytes(progress.total_bytes)}`
                  : ''}
              </span>
              <span>{percent}%</span>
            </div>
            <Progress value={percent} aria-label="移動の進捗" />
          </div>
        )}

        <DialogFooter className="gap-2">
          {busy ? (
            <Button variant="outline" size="sm" onClick={onCancelRunning}>
              中止
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                キャンセル
              </Button>
              <Button size="sm" onClick={onConfirm} data-move-confirm>
                移動する
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 失敗・中止したときの結果ダイアログ。成功はトーストと Undo だけ出す。 */
export function MoveReportDialog({
  result,
  onClose,
}: {
  result: MoveOutcome | null
  onClose: () => void
}) {
  if (!result) return null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-move-report>
        <DialogHeader>
          <DialogTitle>
            {result.cancelled ? '移動を中止しました' : '移動できませんでした'}
          </DialogTitle>
          <DialogDescription className="tabular-nums">
            {result.cancelled
              ? 'コピー先の部分データは削除しました。移動元は変更していません。'
              : `「${result.new_title}」の移動を完了できませんでした`}
            {result.moved && `（${formatCount(result.files)} ファイルは移動済み）`}
          </DialogDescription>
        </DialogHeader>

        {result.failures.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-black/20 p-2">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
              {result.failures.map((failure) => (
                <li key={failure} className="flex items-start gap-1.5">
                  <AlertTriangle
                    className="mt-px size-3.5 flex-none text-destructive"
                    aria-hidden="true"
                  />
                  <span className="break-words">{failure}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 移動直後の Undo トーストの中身（#57 / #115）。
 *
 * 同一ボリュームで rename した場合だけ 5 秒間表示する（別ボリュームは非対応）。
 * 枠・背景・影・配置は `ToastStack` が持つ。
 */
export function MoveUndoToast({
  moveId,
  title,
  targetLabel,
  busy,
  onUndo,
  onExpire,
  seconds = 5,
}: {
  moveId: string
  title: string
  targetLabel: string
  busy: boolean
  onUndo: () => void
  onExpire: () => void
  seconds?: number
}) {
  const [remaining, setRemaining] = useState(seconds)

  useEffect(() => {
    setRemaining(seconds)
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const left = Math.max(0, seconds - (Date.now() - startedAt) / 1000)
      setRemaining(left)
      if (left <= 0) {
        window.clearInterval(timer)
        onExpire()
      }
    }, 100)
    return () => window.clearInterval(timer)
    // moveId が変わったときだけタイマーを張り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveId, seconds])

  return (
    <div data-move-undo-toast>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <FolderInput className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="m-0 min-w-0 flex-1 truncate text-xs">
          「{title}」を「{targetLabel}」へ移動しました
        </p>
        <Button
          size="xs"
          variant="secondary"
          disabled={busy}
          onClick={onUndo}
          data-move-undo-button
        >
          <Undo2 data-icon="inline-start" />
          元に戻す
        </Button>
      </div>
      <div className="h-0.5 w-full bg-muted">
        <div
          className="h-full bg-primary transition-[width] duration-100 ease-linear"
          style={{ width: `${(remaining / seconds) * 100}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
