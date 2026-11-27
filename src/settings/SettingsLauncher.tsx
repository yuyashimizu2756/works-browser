/**
 * ヘッダーの「設定」アイコン（#49 で `SettingsDialog` から分離、#96 polish でヘッダーへ移動）。
 *
 * ダイアログ本体（および Radix Dialog・設定 API 呼び出し）は
 * `React.lazy` で初回クリックまで読み込まない。`?settings=1` で起動したときだけ最初から読み込む。
 */
import { lazy, Suspense, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openSettingsFromUrl } from './model'

const SettingsDialog = lazy(() =>
  import('./SettingsDialog').then((module) => ({ default: module.SettingsDialog })),
)

export function SettingsLauncher() {
  const [open, setOpen] = useState(() => openSettingsFromUrl())
  const [loaded, setLoaded] = useState(open)

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="設定"
            className="text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
            onClick={() => {
              setLoaded(true)
              setOpen(true)
            }}
          >
            <Settings2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          <span className="font-medium">設定</span>
          <span className="text-background/65">· ルート・除外・ffmpeg</span>
        </TooltipContent>
      </Tooltip>
      {loaded && (
        <Suspense fallback={null}>
          <SettingsDialog open={open} onOpenChange={setOpen} />
        </Suspense>
      )}
    </>
  )
}
