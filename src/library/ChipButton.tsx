import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'

/** 絞り込み・並び替えのチップ。アクセント色は「選択中の状態」表現にだけ使う。 */
export function ChipButton({
  active,
  children,
  ...props
}: ComponentProps<typeof Button> & { active?: boolean }) {
  return (
    <Button
      size="xs"
      variant="outline"
      aria-pressed={active}
      className={
        active
          ? 'rounded-full border-[var(--accent-cyan)] bg-[color-mix(in_oklch,var(--accent-cyan)_14%,transparent)] text-[var(--accent-cyan)] hover:bg-[color-mix(in_oklch,var(--accent-cyan)_20%,transparent)] hover:text-[var(--accent-cyan)]'
          : 'rounded-full border-border text-muted-foreground hover:text-foreground'
      }
      {...props}
    >
      {children}
    </Button>
  )
}
