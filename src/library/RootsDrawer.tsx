import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { FolderOpen, FolderPlus, HardDrive, History, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { api } from '../api'
import type { RootInfo, RootSuggestionsInfo, ScanProgress } from '../api'
import { describeError, formatBytes, formatDate } from '../lib/format'
import { rootAccentFor } from './accents'
import type { PendingRoots } from './rootPicker'

const DEPTHS = [
  { value: 1, label: '第 1 階層（作品/ファイル）' },
  { value: 2, label: '第 2 階層（作品/サブ/ファイル）' },
  { value: 0, label: 'フラット（ルート直下）' },
]

type Props = {
  open: boolean
  onClose: () => void
  roots: RootInfo[]
  rootAccents: Map<number, string>
  /** フォルダを追加して、そのまま走査する（#25）。 */
  onAdd: (paths: string[], depth: number) => Promise<void>
  onScan: (rootId: number) => Promise<void>
  scanningRoot: number | null
  progress: ScanProgress | null
  onCancel: () => void
  /** ダイアログ / ドロップで受け取った、深さを選ぶ前の候補。 */
  pending: PendingRoots | null
  /** 候補（最近・ドライブ・既知）を検証して `pending` に積む。 */
  onStagePaths: (paths: string[], source: 'picker' | 'drop') => Promise<void>
  /** OS のフォルダ選択ダイアログを開く。 */
  onPickFolders: () => void
  onClearPending: () => void
}

/** 走査ルートの追加・走査をまとめた右サイドのダイアログ。ライブラリの高さを変えない。 */
export function RootsDrawer({
  open,
  onClose,
  roots,
  rootAccents,
  onAdd,
  onScan,
  scanningRoot,
  progress,
  onCancel,
  pending,
  onStagePaths,
  onPickFolders,
  onClearPending,
}: Props) {
  const [depth, setDepth] = useState(1)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [suggestions, setSuggestions] = useState<RootSuggestionsInfo | null>(null)

  const refreshSuggestions = useCallback(async () => {
    try {
      setSuggestions(await api.rootSuggestions())
    } catch {
      // 候補は無くても追加できるので、失敗は無視する
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshSuggestions()
  }, [open, refreshSuggestions])

  const handleAddPending = async () => {
    if (!pending || pending.checks.length === 0) return
    setBusy(true)
    setLocalError(null)
    try {
      await onAdd(
        pending.checks.map((check) => check.path),
        depth,
      )
    } catch (cause) {
      setLocalError(describeError(cause))
    } finally {
      setBusy(false)
      void refreshSuggestions()
    }
  }

  const handleManualSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = manualPath.trim()
    if (!trimmed) return
    setBusy(true)
    setLocalError(null)
    try {
      await onAdd([trimmed], depth)
      setManualPath('')
    } catch (cause) {
      setLocalError(describeError(cause))
    } finally {
      setBusy(false)
      void refreshSuggestions()
    }
  }

  const handleSuggestion = (path: string) => {
    setLocalError(null)
    void onStagePaths([path], 'picker').catch((cause: unknown) =>
      setLocalError(describeError(cause)),
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-0 right-0 left-auto h-full w-[min(480px,100%)] max-w-none translate-x-0 translate-y-0 content-start gap-3 overflow-y-auto rounded-none border-l border-border bg-popover p-4 pb-7 sm:max-w-none"
        aria-label="走査ルート"
      >
        <DialogHeader className="flex-row items-start justify-between gap-2.5">
          <div>
            <p className="mb-0.5 text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              works-browser
            </p>
            <DialogTitle className="text-[1.05rem] leading-snug font-semibold">走査ルート</DialogTitle>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="閉じる">
            <X />
          </Button>
        </DialogHeader>

        <DialogDescription className="text-xs text-muted-foreground">
          フォルダを選ぶだけで追加と走査を行います。パスの入力は不要です。走査中もライブラリは操作できます。
        </DialogDescription>

        <Button className="w-full" onClick={onPickFolders} disabled={busy}>
          <FolderOpen data-icon="inline-start" />
          フォルダを選ぶ（複数可）
        </Button>
        <p className="m-0 text-xs text-muted-foreground">
          OS のフォルダ選択ダイアログが開きます。エクスプローラからこのウィンドウへ
          ドラッグ&ドロップしても追加できます。
        </p>

        {pending && (
          <section
            className="flex flex-col gap-2 rounded-xl border border-primary/45 bg-primary/10 p-2.5"
            aria-label="追加するフォルダの確認"
          >
            <p className="m-0 text-[13px] font-semibold">
              {pending.source === 'drop' ? 'ドロップされたフォルダ' : '追加するフォルダ'}（
              {pending.checks.length}）
            </p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {pending.checks.map((check) => (
                <li key={check.path} className="flex flex-col gap-1">
                  <code className="text-xs break-all text-foreground">{check.path}</code>
                  {check.warning && (
                    <p className="m-0 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs whitespace-pre-line text-warning">
                      {check.warning}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {pending.skippedFiles > 0 && (
              <p className="m-0 text-xs text-destructive">
                {pending.skippedFiles} 件のファイルは追加できません。フォルダをドロップしてください。
              </p>
            )}
            <label className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
              <span>作品の単位</span>
              <select
                className="h-8 rounded-lg border border-input bg-black/25 px-2 text-xs text-foreground"
                value={depth}
                aria-label="作品の単位（深さ）"
                onChange={(event) => setDepth(Number(event.target.value))}
              >
                {DEPTHS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button size="sm" onClick={() => void handleAddPending()} disabled={busy}>
                <FolderPlus data-icon="inline-start" />
                {busy ? '追加中…' : '追加してスキャン'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onClearPending} disabled={busy}>
                キャンセル
              </Button>
            </div>
          </section>
        )}

        {localError && (
          <p
            className="m-0 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs whitespace-pre-line text-destructive"
            role="alert"
          >
            {localError}
          </p>
        )}

        {suggestions && (
          <div className="flex flex-col gap-2">
            <SuggestionGroup
              icon={<FolderOpen className="size-3" aria-hidden="true" />}
              label="候補"
              items={suggestions.known}
              onPick={handleSuggestion}
            />
            <SuggestionGroup
              icon={<History className="size-3" aria-hidden="true" />}
              label="最近追加したフォルダ"
              items={suggestions.recent}
              onPick={handleSuggestion}
            />
            <SuggestionGroup
              icon={<HardDrive className="size-3" aria-hidden="true" />}
              label="ドライブ"
              items={suggestions.drives}
              onPick={handleSuggestion}
            />
          </div>
        )}

        <Separator />

        {roots.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            まだルートがありません。上の「フォルダを選ぶ」から追加してください。
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {roots.map(({ root, works, files, total_bytes, last_scan_at }) => {
              const accent = rootAccentFor(rootAccents, root.id)
              return (
                <li
                  key={root.id}
                  className="flex items-center justify-between gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2"
                  style={{ boxShadow: `inset 2px 0 0 ${accent}` }}
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="m-0 flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: accent }}
                        aria-hidden="true"
                      />
                      {root.label}
                      <Badge
                        variant="outline"
                        className="h-[1.15rem] border-border px-1.5 text-xs font-medium text-muted-foreground"
                      >
                        深さ {root.depth}
                      </Badge>
                      {root.duplicate_of !== null && (
                        <Badge
                          variant="outline"
                          className="h-[1.15rem] border-[color-mix(in_oklch,var(--warning)_55%,var(--border))] px-1.5 text-xs text-warning"
                        >
                          重複 #{root.duplicate_of}
                        </Badge>
                      )}
                    </p>
                    <code className="text-xs break-all text-muted-foreground">{root.path}</code>
                    <p className="m-0 text-xs text-muted-foreground">
                      作品 {works} / ファイル {files} / {formatBytes(total_bytes)} / 最終走査{' '}
                      {formatDate(last_scan_at)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0"
                    type="button"
                    disabled={scanningRoot !== null}
                    onClick={() => {
                      setLocalError(null)
                      void onScan(root.id).catch((cause: unknown) =>
                        setLocalError(describeError(cause)),
                      )
                    }}
                  >
                    {scanningRoot === root.id ? '走査中…' : '走査'}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {progress && (
          <div
            className="flex flex-col gap-1.5 rounded-xl border border-border bg-card px-2.5 py-2"
            role="status"
            aria-live="polite"
          >
            <Progress
              value={100}
              aria-label="走査の進捗"
              className="h-1.5 bg-black/40 [&_[data-slot=progress-indicator]]:animate-[scan-bar_1.2s_linear_infinite] [&_[data-slot=progress-indicator]]:bg-[linear-gradient(90deg,transparent,var(--primary),var(--accent-2),transparent)]"
            />
            <p className="m-0 text-xs text-muted-foreground">
              {progress.phase === 'finalizing' ? '集計中…' : '走査中…'} / {progress.files} ファイル /{' '}
              {progress.works} 作品 / {formatBytes(progress.bytes)}
            </p>
            <Button variant="ghost" size="xs" className="self-start" onClick={onCancel}>
              キャンセル
            </Button>
          </div>
        )}

        <details className="border-t border-border pt-2 text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">
            詳細（パスを直接入力）
          </summary>
          <form
            className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1.5"
            onSubmit={handleManualSubmit}
          >
            <Input
              className="bg-black/25"
              type="text"
              placeholder="D:\ComfyUI\output"
              aria-label="フォルダのパス"
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              spellCheck={false}
            />
            <Button type="submit" size="sm" disabled={busy || !manualPath.trim()}>
              追加
            </Button>
            <select
              className="col-span-2 h-8 rounded-lg border border-input bg-black/25 px-2 text-xs text-foreground"
              value={depth}
              aria-label="作品の単位（深さ）"
              onChange={(event) => setDepth(Number(event.target.value))}
            >
              {DEPTHS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </form>
          <p className="mt-1.5 mb-0 leading-relaxed text-muted-foreground">
            コピーしたパスを貼り付ける用途です。通常は上の「フォルダを選ぶ」かドラッグ&ドロップを使ってください。
          </p>
        </details>

        <details className="border-t border-border pt-2 text-[13px]">
          <summary className="cursor-pointer text-muted-foreground">作品の単位（深さ）</summary>
          <p className="mt-1.5 mb-0 leading-relaxed text-muted-foreground">
            深さ 1 は直下フォルダを 1 作品、深さ 2 は 2 階層目までを 1 作品にまとめます。深さ 0
            はルート直下のファイルだけを 1 作品として扱います。
          </p>
        </details>
      </DialogContent>
    </Dialog>
  )
}

function SuggestionGroup({
  icon,
  label,
  items,
  onPick,
}: {
  icon: ReactNode
  label: string
  items: string[]
  onPick: (path: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 flex items-center gap-1 text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        {icon}
        {label}
      </p>
      <div className="flex flex-wrap gap-1">
        {items.map((path) => (
          <Button
            key={path}
            variant="outline"
            size="xs"
            className="max-w-full"
            title={path}
            onClick={() => onPick(path)}
          >
            <span className="truncate">{path}</span>
          </Button>
        ))}
      </div>
    </div>
  )
}
