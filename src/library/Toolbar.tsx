/**
 * #96 ライブラリのツールバー部品。
 *
 * - 高さ 48px の 1 段（検索 / フィルタ / 並び / 表示切替）
 * - 適用中のフィルタはツールバーの下に削除可能なチップで出す
 * - ポップオーバーは Escape / 外側クリックで閉じる（キーボードでも到達できる）
 *
 * 見た目は `src/index.css` のトークンだけを参照し、画面側で色を直書きしない。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentPropsWithRef, ReactNode, RefObject } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Images,
  LayoutGrid,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { LibraryViewMode } from '../lib/viewMode'
import {
  THUMBNAIL_SHORTCUT,
  VIEW_MODE_LABEL,
  VIEW_MODE_SHORTCUT,
} from '../lib/viewMode'

const CONTROL =
  'h-8 rounded-[var(--radius-control)] border border-[var(--line)] bg-transparent text-[13px] text-[var(--text-secondary)] ' +
  'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] ' +
  'hover:border-[var(--line-strong)] hover:text-[var(--text-primary)] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]'

/** ツールバー本体（48px）と、その下のフィルタチップ。 */
export function ToolbarShell({
  children,
  chips,
  label = 'ツールバー',
}: {
  children: ReactNode
  chips?: ReactNode
  label?: string
}) {
  return (
    <div className="flex-none border-b border-[var(--line)]" aria-label={label}>
      <div className="flex h-12 min-w-0 items-center gap-2 px-4 lg:px-6">{children}</div>
      {chips}
    </div>
  )
}

/** 検索欄（flex 320〜420px）。`/` はショートカットのヒント。 */
export function ToolbarSearch({
  value,
  onChange,
  inputRef,
  placeholder,
  ariaLabel,
  searching = false,
  dataAttr,
  shortcut = '/',
  className,
  onEscape,
}: {
  value: string
  onChange: (value: string) => void
  inputRef?: RefObject<HTMLInputElement | null>
  placeholder: string
  ariaLabel: string
  searching?: boolean
  dataAttr?: Record<string, string | true>
  shortcut?: string
  className?: string
  /** Escape で検索語を消したあとの追加処理（選択解除など）。 */
  onEscape?: () => void
}) {
  return (
    <div
      className={cn(
        'relative flex h-8 min-w-[320px] max-w-[420px] flex-1 basis-[320px] items-center',
        className,
      )}
    >
      <Search
        className="pointer-events-none absolute left-2.5 z-10 size-3.5 text-[var(--text-tertiary)]"
        aria-hidden="true"
      />
      <Input
        ref={inputRef}
        type="search"
        className="h-8 rounded-[var(--radius-control)] border-[var(--line)] bg-[var(--surface)] pr-20 pl-8 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)]"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onChange('')
            onEscape?.()
            event.currentTarget.blur()
          }
        }}
        {...dataAttr}
      />
      <div className="absolute right-1.5 flex items-center gap-1">
        {searching && value.trim() !== '' && (
          <Loader2
            className="size-3.5 animate-spin text-[var(--brand)]"
            aria-label="検索中"
            role="status"
          />
        )}
        {value !== '' && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="検索をクリア"
            onClick={() => {
              onChange('')
              inputRef?.current?.focus()
            }}
          >
            <X />
          </Button>
        )}
        <kbd
          className="rounded border border-[var(--line)] px-1 font-sans text-xs leading-normal text-[var(--text-secondary)]"
          aria-hidden="true"
        >
          {shortcut}
        </kbd>
      </div>
    </div>
  )
}

type ToolbarMenuProps = {
  icon: ReactNode
  label: ReactNode
  ariaLabel: string
  /** 適用中の件数（フィルタ）。 */
  count?: number
  align?: 'start' | 'end'
  role?: 'dialog' | 'menu'
  panelLabel: string
  panelClassName?: string
  className?: string
  children: (close: () => void) => ReactNode
}

/**
 * ツールバーのポップオーバー / メニュー。
 * 外側クリック・Escape で閉じ、トリガーへフォーカスを戻す。
 */
export function ToolbarMenu({
  icon,
  label,
  ariaLabel,
  count,
  align = 'start',
  role = 'dialog',
  panelLabel,
  panelClassName,
  className,
  children,
}: ToolbarMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={cn('relative flex-none', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup={role}
        aria-controls={open ? panelId : undefined}
        data-open={open ? 'true' : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex items-center gap-1.5 border px-2.5',
          CONTROL,
          open && 'border-[var(--line-strong)] bg-[var(--surface)] text-[var(--text-primary)]',
        )}
      >
        <span className="[&_svg]:size-3.5" aria-hidden="true">
          {icon}
        </span>
        {label}
        {count !== undefined && count > 0 && (
          <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--brand)] px-1 text-xs font-semibold text-[var(--brand-contrast)] tabular-nums">
            {count}
          </span>
        )}
        <ChevronDown
          className={cn('size-3 text-[var(--text-tertiary)] transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          id={panelId}
          role={role}
          aria-label={panelLabel}
          data-toolbar-panel
          className={cn(
            'absolute top-[calc(100%+8px)] z-50 rounded-[var(--radius-panel)] border border-[var(--border-strong)] bg-[var(--raised)] text-[13px] text-[var(--text-primary)] shadow-[0_12px_32px_rgba(0,0,0,0.55)]',
            'animate-in fade-in-0 zoom-in-98 duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
            align === 'end' ? 'right-0 origin-top-right' : 'left-0 origin-top-left',
            panelClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** フィルタのポップオーバー（適用件数バッジ付き）。 */
export function FilterMenu({
  count,
  children,
  onClear,
}: {
  count: number
  children: (close: () => void) => ReactNode
  onClear?: () => void
}) {
  return (
    <ToolbarMenu
      icon={<SlidersHorizontal />}
      label="フィルタ"
      ariaLabel={count > 0 ? `フィルタ（${count} 件適用中）` : 'フィルタ'}
      count={count}
      panelLabel="絞り込み"
      panelClassName="w-[340px] p-4"
    >
      {(close) => (
        <>
          <div className="flex flex-col gap-4">{children(close)}</div>
          {onClear && (
            <div className="mt-4 flex items-center justify-between border-t border-[var(--line)] pt-3">
              <span className="text-xs text-[var(--text-secondary)]">
                {count > 0 ? `${count} 件の条件を適用中` : '条件なし'}
              </span>
              <button
                type="button"
                className="text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-40"
                disabled={count === 0}
                onClick={onClear}
              >
                すべて解除
              </button>
            </div>
          )}
        </>
      )}
    </ToolbarMenu>
  )
}

/** フィルタ内の節。見出しは 11px uppercase / letter-spacing .08em。 */
export function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={label}>
      <h3 className="m-0 text-[11px] font-semibold tracking-[0.08em] text-[var(--text-secondary)] uppercase">
        {label}
      </h3>
      {children}
    </section>
  )
}

/** フィルタの選択肢（単一選択 / 複数選択のどちらにも使う）。 */
export function FilterChoice({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors duration-[var(--duration-fast)]',
        active
          ? 'border-[var(--brand)] bg-[var(--brand)] font-medium text-[var(--brand-contrast)]'
          : 'border-[var(--line)] text-[var(--text-secondary)] hover:border-[var(--line-strong)] hover:text-[var(--text-primary)]',
        disabled && 'opacity-40',
      )}
    >
      {children}
    </button>
  )
}

/** オン / オフの行（お気に入り・生成情報検索）。 */
export function FilterToggle({
  active,
  onClick,
  label,
  description,
}: {
  active: boolean
  onClick: () => void
  label: string
  description?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onClick}
      className="flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-1 py-1 text-left transition-colors hover:bg-[var(--muted)]"
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-4 flex-none items-center justify-center rounded-[4px] border transition-colors',
          active
            ? 'border-[var(--brand)] bg-[var(--brand)] text-[var(--brand-contrast)]'
            : 'border-[var(--line-strong)] text-transparent',
        )}
      >
        <Check className="size-3" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-[var(--text-primary)]">{label}</span>
        {description && (
          <span className="text-xs text-[var(--text-secondary)]">{description}</span>
        )}
      </span>
    </button>
  )
}

export type SortOption<T extends string> = { key: T; label: string }

/** 並びメニュー + 昇降トグル 1 つ。 */
export function SortMenu<T extends string>({
  options,
  value,
  onChange,
  dir,
  onToggleDir,
}: {
  options: readonly SortOption<T>[]
  value: T
  onChange: (value: T) => void
  dir: 'asc' | 'desc'
  onToggleDir: () => void
}) {
  const current = options.find((option) => option.key === value)
  return (
    <div className="flex flex-none items-center gap-1">
      <ToolbarMenu
        icon={<ArrowUpDown />}
        label={current?.label ?? '並び'}
        ariaLabel={`並び替え（現在: ${current?.label ?? '未設定'}）`}
        role="menu"
        panelLabel="並び替え"
        align="end"
        panelClassName="w-[220px] p-1.5"
      >
        {(close) => (
          <div role="none" className="flex flex-col">
            {options.map((option) => (
              <button
                key={option.key}
                type="button"
                role="menuitemradio"
                aria-checked={option.key === value}
                onClick={() => {
                  onChange(option.key)
                  close()
                }}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] transition-colors hover:bg-[var(--muted)]',
                  option.key === value
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)]',
                )}
              >
                <Check
                  className={cn('size-3.5', option.key === value ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                {option.label}
              </button>
            ))}
          </div>
        )}
      </ToolbarMenu>
      <button
        type="button"
        aria-label={dir === 'asc' ? '昇順（クリックで降順）' : '降順（クリックで昇順）'}
        title={dir === 'asc' ? '昇順（クリックで降順）' : '降順（クリックで昇順）'}
        aria-pressed={dir === 'asc'}
        onClick={onToggleDir}
        className={cn('inline-flex w-8 items-center justify-center p-0', CONTROL)}
      >
        {dir === 'asc' ? (
          <ArrowUp className="size-3.5" aria-hidden="true" />
        ) : (
          <ArrowDown className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  )
}

const VIEW_MODE_ICON: Record<LibraryViewMode, ReactNode> = {
  works: <LayoutGrid />,
  files: <Images />,
  timeline: <CalendarDays />,
}

/** 右端の表示切替セグメント（作品 / ファイル / タイムライン）。 */
export function ViewModeSegment({
  value,
  onChange,
}: {
  value: LibraryViewMode
  onChange: (mode: LibraryViewMode) => void
}) {
  return (
    <div
      className="flex h-8 flex-none items-center gap-0.5 rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface)] p-0.5"
      role="group"
      aria-label="表示モード"
    >
      {(['works', 'files', 'timeline'] as const).map((mode) => {
        const active = value === mode
        return (
          <button
            key={mode}
            type="button"
            aria-pressed={active}
            title={`${VIEW_MODE_LABEL[mode]}（${VIEW_MODE_SHORTCUT[mode]}）`}
            onClick={() => onChange(mode)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-xs transition-colors duration-[var(--duration-fast)]',
              active
                ? 'bg-[var(--raised)] font-medium text-[var(--text-primary)] shadow-sm'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            <span className="[&_svg]:size-3.5" aria-hidden="true">
              {VIEW_MODE_ICON[mode]}
            </span>
            <span>{VIEW_MODE_LABEL[mode]}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * #120 / #121: サムネイル表示トグルの共通実装。
 *
 * - `compact` … ヘッダーの 32px アイコンボタン（ラベルなし）
 * - `labeled` … ツールバー右端（`Eye` / `EyeOff` + 「サムネ」）
 *
 * ヘッダー / ライブラリ / ファイル / タイムライン / 作品詳細のすべてが同じ
 * `useThumbnailVisible` を共有し、`aria-pressed` は「表示中か」で揃える。
 */
type ThumbnailToggleProps = Omit<
  ComponentPropsWithRef<'button'>,
  'onClick' | 'aria-pressed' | 'children'
> & {
  visible: boolean
  onToggle: () => void
  variant?: 'compact' | 'labeled'
  /** 読み取り用の追加属性（詳細画面の `data-work-thumb-toggle` など）。 */
  dataAttr?: Record<string, string | true>
}

const THUMB_TOGGLE_BASE =
  'inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding ' +
  'transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] ' +
  'text-[var(--text-secondary)] hover:text-[var(--text-primary)] ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] ' +
  'disabled:pointer-events-none disabled:opacity-60'

const THUMB_TOGGLE_VARIANT = {
  compact: 'size-8 rounded-lg hover:bg-[var(--surface)]',
  labeled: 'h-8 flex-none gap-1.5 rounded-[var(--radius-control)] px-1 text-xs',
} as const

export function ThumbnailToggle({
  visible,
  onToggle,
  variant = 'labeled',
  dataAttr,
  className,
  ...rest
}: ThumbnailToggleProps) {
  const iconClass = variant === 'compact' ? 'size-4' : 'size-3.5'
  return (
    <button
      {...rest}
      {...dataAttr}
      type="button"
      aria-pressed={visible}
      aria-label={visible ? 'サムネイルを非表示にする' : 'サムネイルを表示する'}
      title={`サムネイルの表示 / 非表示（${THUMBNAIL_SHORTCUT}）`}
      onClick={onToggle}
      data-thumb-toggle={variant}
      className={cn(THUMB_TOGGLE_BASE, THUMB_TOGGLE_VARIANT[variant], className)}
    >
      {visible ? (
        <Eye className={iconClass} aria-hidden="true" />
      ) : (
        <EyeOff className={iconClass} aria-hidden="true" />
      )}
      {variant === 'labeled' && 'サムネ'}
    </button>
  )
}

export type ActiveFilterChip = {
  key: string
  label: string
  onRemove: () => void
}

/** 適用中のフィルタだけを出す、削除可能なチップ列。 */
export function FilterChipBar({
  chips,
  onClear,
}: {
  chips: ActiveFilterChip[]
  onClear?: () => void
}) {
  if (chips.length === 0) return null
  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-1.5 border-t border-[var(--line)] px-4 py-1.5 lg:px-6"
      aria-label="適用中のフィルタ"
    >
      <span className="mr-1 text-xs font-semibold tracking-[0.08em] text-[var(--text-secondary)] uppercase">
        適用中
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--surface)] pr-1 pl-2.5 text-xs text-[var(--text-secondary)]"
        >
          {chip.label}
          <button
            type="button"
            aria-label={`${chip.label} を解除`}
            onClick={chip.onRemove}
            className="inline-flex size-4 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--raised)] hover:text-[var(--text-primary)]"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="ml-1 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          すべて解除
        </button>
      )}
    </div>
  )
}

/** ツールバー右側の件数（12px tabular）。 */
export function ToolbarCount({ total, unit }: { total: number; unit: string }) {
  return (
    <p className="m-0 hidden flex-none items-baseline gap-1 text-xs text-[var(--text-secondary)] tabular-nums sm:flex">
      <strong className="text-[13px] font-semibold text-[var(--text-primary)] tabular-nums">
        {total.toLocaleString('ja-JP')}
      </strong>
      {unit}
    </p>
  )
}

