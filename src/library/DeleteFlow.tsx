import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import type { DeleteProgress, DeleteResult } from '../api'
import { formatBytes, formatCount } from '../lib/format'

/** Shift+Delete かどうか。UI の削除コールバックはこれを第 2 引数で受ける。 */
export type DeleteIntent = {
  permanent: boolean
}

/** 確認ダイアログに渡す、これから削除する対象。 */
export type DeleteRequest = {
  /** ライブラリのグリッドからか、作品詳細からか（削除後の戻り先の判断）。 */
  source: 'library' | 'detail'
  /** 作品単位の選択か、ファイル単位の選択か（表示文言だけに使う）。 */
  kind: 'works' | 'files'
  /** 作品 id またはファイル id。パスは渡さない（#15 の安全策）。 */
  ids: number[]
  count: number
  totalBytes: number
  permanent: boolean
}

const TRASH_NOTICE = 'ゴミ箱へ移動します。あとからゴミ箱を開いて復元できます。'
const PERMANENT_NOTICE =
  '完全に削除します。ゴミ箱に入らないため、元に戻せません。本当に削除してよいか確認してください。'

/**
 * 削除前の確認ダイアログ（#15）。
 *
 * 件数・合計サイズ・「ゴミ箱へ移動します」を必ず出し、恒久削除は赤字で警告する。
 * 削除中は確認ボタンを無効化し、進捗と「中止」を出す（二重実行の防止）。
 */
export function DeleteConfirmDialog({
  request,
  busy,
  progress,
  onClose,
  onConfirm,
  onCancelRunning,
}: {
  request: DeleteRequest | null
  busy: boolean
  progress: DeleteProgress | null
  onClose: () => void
  onConfirm: (permanent: boolean) => void
  onCancelRunning: () => void
}) {
  const [permanent, setPermanent] = useState(request?.permanent ?? false)

  useEffect(() => {
    setPermanent(request?.permanent ?? false)
  }, [request])

  if (!request) return null

  const unit = request.kind === 'works' ? '作品' : 'ファイル'
  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        data-delete-dialog
        data-permanent={permanent ? 'true' : 'false'}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" aria-hidden="true" />
            {formatCount(request.count)} 件の{unit}を削除しますか？
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
            <span>対象 {formatCount(request.count)} 件</span>
            <span aria-hidden="true">·</span>
            <span>合計 {formatBytes(request.totalBytes)}</span>
          </DialogDescription>
        </DialogHeader>

        <div
          className={
            permanent
              ? 'rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive'
              : 'rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground'
          }
          role={permanent ? 'alert' : 'note'}
          data-delete-notice
        >
          {permanent ? PERMANENT_NOTICE : TRASH_NOTICE}
        </div>

        {!busy && (
          <label
            className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"
            htmlFor="delete-permanent"
          >
            <Checkbox
              id="delete-permanent"
              checked={permanent}
              onCheckedChange={(checked) => setPermanent(checked === true)}
              aria-describedby="delete-permanent-hint"
            />
            <span>
              ゴミ箱に入れず完全に削除する（元に戻せません）
              <span id="delete-permanent-hint" className="block text-xs">
                Shift+Delete で開くと最初からチェックが入ります。
              </span>
            </span>
          </label>
        )}

        {busy && (
          <div className="flex flex-col gap-1.5" role="status" aria-live="polite" data-delete-progress>
            <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
              <span>削除中… {progress ? `${formatCount(progress.done)} / ${formatCount(progress.total)}` : ''}</span>
              <span>{percent}%</span>
            </div>
            <Progress value={percent} aria-label="削除の進捗" />
            {progress?.name && (
              <p className="m-0 truncate text-xs text-muted-foreground">{progress.name}</p>
            )}
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
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onConfirm(permanent)}
                data-delete-confirm
              >
                {permanent ? '完全に削除' : 'ゴミ箱へ移動'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 削除結果（成功件数 + 失敗理由のまとめ）。失敗が 0 でも完了を伝える。 */
export function DeleteReportDialog({
  result,
  onClose,
}: {
  result: DeleteResult | null
  onClose: () => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { count: number; ids: number[] }>()
    for (const failure of result?.failed ?? []) {
      const entry = map.get(failure.reason) ?? { count: 0, ids: [] }
      entry.count += 1
      if (entry.ids.length < 3) entry.ids.push(failure.id)
      map.set(failure.reason, entry)
    }
    return [...map.entries()]
  }, [result])

  if (!result) return null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-delete-report>
        <DialogHeader>
          <DialogTitle>
            {result.failed.length > 0 ? '一部のファイルを削除できませんでした' : '削除しました'}
          </DialogTitle>
          <DialogDescription className="tabular-nums">
            {formatCount(result.deleted)} 件を
            {result.permanent ? '完全に削除' : 'ゴミ箱へ移動'}
            しました（{formatBytes(result.deleted_bytes)}）
            {result.failed.length > 0 && ` / ${formatCount(result.failed.length)} 件はスキップ`}
            {result.cancelled && '（中止しました）'}
          </DialogDescription>
        </DialogHeader>

        {result.failed.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-black/20 p-2">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
              {groups.map(([reason, entry]) => (
                <li key={reason} className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium text-destructive">
                    <AlertTriangle className="size-3.5" aria-hidden="true" />
                    {formatCount(entry.count)} 件: {reason}
                  </span>
                  <span className="pl-5 text-xs text-muted-foreground tabular-nums">
                    例: {entry.ids.map((id) => `#${id}`).join(', ')}
                    {entry.count > entry.ids.length ? ' ほか' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!result.permanent && result.deleted > 0 && (
          <p className="m-0 text-xs text-muted-foreground">
            ゴミ箱から戻す場合は、エクスプローラの「ごみ箱」を開いてください。
          </p>
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
 * 削除直後の Undo トーストの中身（#15 / #115）。
 *
 * 5 秒で自動的に消える。ゴミ箱へ移動した場合だけ表示する（恒久削除は戻せない）。
 * 枠・背景・影・配置は `ToastStack` が持つ。
 */
export function UndoToast({
  undoId,
  count,
  busy,
  onUndo,
  onExpire,
  seconds = 5,
}: {
  undoId: string
  count: number
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
    // undoId が変わったときだけタイマーを張り直す（onExpire は毎回同じ関数を渡す）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoId, seconds])

  return (
    <div data-undo-toast>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <Trash2 className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="m-0 flex-1 text-xs">
          {formatCount(count)} 件をゴミ箱へ移動しました
        </p>
        <Button
          size="xs"
          variant="secondary"
          disabled={busy}
          onClick={onUndo}
          data-undo-button
        >
          <Undo2 data-icon="inline-start" />
          取り消す
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
