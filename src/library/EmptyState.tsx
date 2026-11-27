import type { LucideIcon } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'

type EmptyStateProps = {
  icon: LucideIcon
  title: string
  description: string
  /** 次の行動は 1 つだけ。 */
  action?: { label: string; onClick: () => void }
  /**
   * `panel` … メイン領域の中央（既定）
   * `sidebar` … 240px のサイドバー向け（左寄せ・小さいアイコン）
   * `notice` … グリッド上部の横長バナー
   */
  variant?: 'panel' | 'sidebar' | 'notice'
  className?: string
}

/**
 * #100: 空状態の共通形。
 *
 * 短い説明と「次の行動」を 1 つだけ置く。アイコンは控えめ（--text-tertiary の
 * 16〜18px）にして、作品や操作ボタンより目立たせない。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'panel',
  className,
}: EmptyStateProps) {
  if (variant === 'notice') {
    return (
      <div
        data-empty-state="thumbs"
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--surface)] px-4 py-3',
          className,
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-8 flex-none items-center justify-center rounded-full bg-[var(--bg)] text-[var(--text-tertiary)]"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{title}</p>
          <p className="m-0 mt-0.5 text-xs leading-relaxed text-[var(--text-secondary)]">
            {description}
          </p>
        </div>
        {action && (
          <Button size="sm" variant="outline" className="flex-none" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
      </div>
    )
  }

  if (variant === 'sidebar') {
    return (
      <div
        data-empty-state={title}
        className={cn('flex flex-col gap-2 px-2 py-1', className)}
      >
        <span
          aria-hidden="true"
          className="flex size-7 items-center justify-center rounded-full bg-[var(--bg)] text-[var(--text-tertiary)]"
        >
          <Icon className="size-3.5" />
        </span>
        <div className="flex flex-col gap-0.5">
          <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{title}</p>
          <p className="m-0 text-xs leading-relaxed text-[var(--text-secondary)]">{description}</p>
        </div>
        {action && (
          <Button
            variant="outline"
            size="sm"
            className="mt-0.5 h-8 w-full justify-start rounded-[var(--radius-control)]"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div
      data-empty-state={title}
      className={cn('flex max-w-[420px] flex-col items-center gap-3 text-center', className)}
    >
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[var(--text-tertiary)]"
      >
        <Icon className="size-4" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{title}</p>
        <p className="m-0 text-xs leading-relaxed text-[var(--text-secondary)]">{description}</p>
      </div>
      {action && (
        <Button size="sm" variant="outline" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
