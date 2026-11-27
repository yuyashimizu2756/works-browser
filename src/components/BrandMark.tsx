import { cn } from 'cn'

/**
 * #96 ブランドマーク。余計な色を使わず、罫線とアクセント 1 色だけで構成する。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex size-7 flex-none items-center justify-center rounded-[var(--radius-control)] border border-[var(--line-strong)] bg-[var(--surface)]',
        className,
      )}
    >
      <span className="absolute size-3 -translate-x-[3px] -translate-y-[3px] rounded-[3px] border border-[var(--text-secondary)]/45" />
      <span className="absolute size-3 translate-x-[3px] translate-y-[3px] rounded-[3px] bg-[var(--brand)]" />
      {/* #108: 2px のアクセントドット。マークの輪郭に埋もれないよう背景色で抜く。 */}
      <span className="absolute -top-0.5 -right-0.5 size-0.5 rounded-full bg-[var(--brand)] shadow-[0_0_0_2px_var(--bg)]" />
    </span>
  )
}
