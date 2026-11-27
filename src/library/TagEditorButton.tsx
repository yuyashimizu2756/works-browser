/**
 * 「タグ」ボタン + タグ編集ダイアログ（#49 で分離）。
 *
 * ダイアログ本体（`TagEditor`）は React.lazy で初回クリックまで読み込まない。
 * 見た目・操作は従来どおり（ボタンは同じ `Button`、ダイアログは同じ `TagEditor`）。
 */
import { lazy, Suspense, useState } from 'react'
import { Tag as TagIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

const TagEditor = lazy(() =>
  import('./TagEditor').then((module) => ({ default: module.TagEditor })),
)

type ButtonProps = {
  workIds: number[]
  onChanged?: () => void
  disabled?: boolean
  label?: string
  variant?: 'ghost' | 'outline' | 'secondary'
  size?: 'xs' | 'sm'
}

/** 「タグ」ボタン + ダイアログ。作品詳細 / 選択バーのマウント用。 */
export function TagEditorButton({
  workIds,
  onChanged,
  disabled = false,
  label = 'タグ',
  variant = 'ghost',
  size = 'sm',
}: ButtonProps) {
  const [open, setOpen] = useState(false)
  // 一度開いたら閉じてもマウントしたままにする（入力途中の下書きを失わない）。
  const [loaded, setLoaded] = useState(false)

  const handleOpenChange = (next: boolean) => {
    if (next) setLoaded(true)
    setOpen(next)
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        data-tag-open
        disabled={disabled || workIds.length === 0}
        onClick={() => handleOpenChange(true)}
      >
        <TagIcon data-icon="inline-start" />
        {label}
      </Button>
      {loaded && (
        <Suspense fallback={null}>
          <TagEditor
            open={open}
            onOpenChange={handleOpenChange}
            workIds={workIds}
            onChanged={onChanged}
            disabled={disabled}
          />
        </Suspense>
      )}
    </>
  )
}
