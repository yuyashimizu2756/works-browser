import { useEffect, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Keyboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ShieldSettings } from './settings'
import {
  hotkeyFromKeyboardEvent,
  normalizeShieldSettings,
  SHIELD_APPEARANCE_LABEL,
  SHIELD_HOLD_OPTIONS,
} from './settings'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  value: ShieldSettings
  onSave: (next: ShieldSettings) => void
  /** グローバルホットキーの登録に失敗したときのメッセージ（他アプリと衝突など）。 */
  hotkeyError?: string | null
}

/**
 * プライバシーシールドの設定（#22）。
 *
 * 値は保存時に `config.json` へ書かれ、ホットキーは Rust 側で登録し直される。
 */
export function ShieldSettingsDialog({
  open,
  onOpenChange,
  value,
  onSave,
  hotkeyError,
}: Props) {
  const [draft, setDraft] = useState<ShieldSettings>(value)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(value)
    setCapturing(false)
  }, [open, value])

  const onHotkeyKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setCapturing(false)
      return
    }
    const hotkey = hotkeyFromKeyboardEvent(event)
    if (hotkey) {
      setDraft((current) => ({ ...current, hotkey }))
      setCapturing(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>プライバシーシールド</DialogTitle>
          <DialogDescription>
            家族などに画面を覗かれたときに、1 キーで画像・動画・サムネイルを隠します。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">グローバルホットキー</span>
            <button
              type="button"
              onClick={() => setCapturing(true)}
              onKeyDown={capturing ? onHotkeyKeyDown : undefined}
              onBlur={() => setCapturing(false)}
              aria-label="グローバルホットキーを入力"
              className="flex h-8 items-center justify-between gap-2 rounded-lg border border-input bg-black/25 px-2.5 text-left text-xs hover:bg-black/35"
            >
              <span className={capturing ? 'text-muted-foreground' : 'font-mono text-foreground'}>
                {capturing ? 'キーの組み合わせを押してください…' : draft.hotkey}
              </span>
              <Keyboard className="size-3.5 text-muted-foreground" aria-hidden="true" />
            </button>
            <span className="text-xs text-muted-foreground">
              Ctrl / Shift / Alt / Win のいずれか + 英数字・F1〜F12。他のアプリと衝突する場合は
              ここで変更できます。
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">解除の長押し時間</span>
            <select
              value={draft.holdMs}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  holdMs: Number(event.target.value) as ShieldSettings['holdMs'],
                }))
              }
              className="h-8 rounded-lg border border-input bg-black/25 px-2 text-xs text-foreground"
            >
              {SHIELD_HOLD_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              Esc での発動と、シールド中のホットキー解除の両方に使います。
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-foreground">シールド中の見た目</span>
            <select
              value={draft.appearance}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  appearance: event.target.value as ShieldSettings['appearance'],
                }))
              }
              className="h-8 rounded-lg border border-input bg-black/25 px-2 text-xs text-foreground"
            >
              <option value="files">{SHIELD_APPEARANCE_LABEL.files}</option>
              <option value="plain">{SHIELD_APPEARANCE_LABEL.plain}</option>
            </select>
          </label>

          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.startHidden}
              onChange={(event) =>
                setDraft((current) => ({ ...current, startHidden: event.target.checked }))
              }
              className="mt-0.5 size-3.5 accent-[var(--accent-cyan)]"
            />
            <span>
              起動直後から隠した状態で開始する
              <span className="mt-0.5 block text-xs text-muted-foreground">
                次回起動時から有効になります。
              </span>
            </span>
          </label>

          {hotkeyError && (
            <p
              className="m-0 rounded-lg border border-destructive/45 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
              role="alert"
            >
              {hotkeyError}
            </p>
          )}

          <p className="m-0 rounded-lg border border-border bg-muted/35 px-2.5 py-1.5 text-xs leading-relaxed text-muted-foreground">
            物理的に画面を見られた場合は防げません。この機能は「一瞬隠す」ためのものです。
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button onClick={() => onSave(normalizeShieldSettings(draft))}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
