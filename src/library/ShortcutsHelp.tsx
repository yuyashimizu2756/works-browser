/**
 * ショートカット一覧（#82 / #116）。
 *
 * `?`（Shift+/）で開き、分類ごとにキーと説明を表示する。Esc で閉じる。
 * 一覧の中身は `src/lib/shortcuts.ts` の `SHORTCUT_DEFINITIONS` をそのまま描画するので、
 * 実際のキー処理と表記がずれない。
 *
 * 入力欄・選択欄・contenteditable にフォーカスがあるときは開かない
 * （判定は `shouldOpenHelp` = `isEditableTarget` と同じ入力ガード）。
 * 他のダイアログ（設定・比較・削除の確認など）が開いている間も重ねて開かない。
 *
 * #116: 1280×800 でも最終行が切れないように、ダイアログ自体の高さを
 * `min(85vh, 760px)` で制限し、**本文だけ**を内部スクロールにする。
 * ヘッダー（タイトル・閉じる）とフッター（スクロールのヒント）は固定し、
 * 本文の見出しは `sticky` で現在地が分かるようにする。スクロールできることは
 * 下端のフェードでも示し、PageDown / ↑↓ でも動かせる（入力欄では無効）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  isEditableTarget,
  SHORTCUT_GROUPS,
  shortcutsInGroup,
  shouldOpenHelp,
} from '../lib/shortcuts'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const KBD_CLASS =
  'rounded border border-border bg-black/25 px-1.5 py-0.5 font-mono text-xs leading-normal whitespace-nowrap text-foreground'

/** 本文のキーボードスクロール量（行の高さ 34px に対して 1.5 行弱）。 */
const ARROW_SCROLL_STEP = 48
/** 下端からこの距離まで来たら「続き」のフェードを消す。 */
const SCROLL_END_EPSILON = 4

/**
 * `?help=1` で初期表示から開く（`visual:check` のスクショ用）。
 * 通常の `?` と同じ `ShortcutsDialog` をそのまま使う。
 */
export function helpOpenFromUrl(search = window.location.search): boolean {
  return new URLSearchParams(search).get('help') === '1'
}

/** 一覧そのもの（テスト・将来の「ヘルプ」ボタンからも使えるように分離）。 */
export function ShortcutsDialog({ open, onOpenChange }: DialogProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** 本文が最下端までスクロールされたか（フェードを消す判定）。 */
  const [atEnd, setAtEnd] = useState(false)

  const updateAtEnd = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setAtEnd(
      element.scrollHeight - element.scrollTop - element.clientHeight <= SCROLL_END_EPSILON,
    )
  }, [])

  // 開くたびに本文を先頭へ戻し、リサイズでもフェードの状態を測り直す。
  useEffect(() => {
    if (!open) return
    const element = scrollRef.current
    if (element) element.scrollTop = 0
    updateAtEnd()
    window.addEventListener('resize', updateAtEnd)
    return () => window.removeEventListener('resize', updateAtEnd)
  }, [open, updateAtEnd])

  // PageDown / PageUp / ↑↓ / Home / End で本文だけを動かす。
  // 入力欄にフォーカスがあるときは何もしない（一覧を開く判定と同じガード）。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.altKey || event.metaKey) return
      if (isEditableTarget(event.target)) return

      const element = scrollRef.current
      if (!element) return
      const maxScroll = element.scrollHeight - element.clientHeight
      if (maxScroll <= 0) return

      const clamp = (value: number) => Math.max(0, Math.min(maxScroll, value))
      const page = Math.max(120, element.clientHeight - ARROW_SCROLL_STEP)
      switch (event.key) {
        case 'PageDown':
          element.scrollTop = clamp(element.scrollTop + page)
          break
        case 'PageUp':
          element.scrollTop = clamp(element.scrollTop - page)
          break
        case 'ArrowDown':
          element.scrollTop = clamp(element.scrollTop + ARROW_SCROLL_STEP)
          break
        case 'ArrowUp':
          element.scrollTop = clamp(element.scrollTop - ARROW_SCROLL_STEP)
          break
        case 'Home':
          element.scrollTop = 0
          break
        case 'End':
          element.scrollTop = maxScroll
          break
        default:
          return
      }
      event.preventDefault()
      updateAtEnd()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, updateAtEnd])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(85vh,760px)] w-full flex-col gap-0 sm:max-w-2xl"
        data-shortcuts-dialog
      >
        <DialogHeader className="shrink-0 gap-2 border-b border-border/60 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="size-4 text-primary" aria-hidden="true" />
            キーボードショートカット
          </DialogTitle>
          <DialogDescription>
            一覧・詳細・比較ビューで使えるキーです。入力欄にフォーカスがあるときは開きません。
            Esc で閉じます。
          </DialogDescription>
        </DialogHeader>

        {/*
         * 本文は flex アイテム自身をスクロール領域にする（`h-full` の入れ子は
         * 高さが解決されず、中身がダイアログの外へはみ出す）。
         * 下端のフェードは本文の最後に置いた sticky で、スクロール中だけ見える。
         */}
        <div
          ref={scrollRef}
          data-shortcuts-scroll
          onScroll={updateAtEnd}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {/* 余白はグリッド側に持たせる。スクロール領域に padding があると、
              見出しが padding 分下に貼り付いて上端に前の行が覗く。 */}
          <div className="grid gap-x-6 gap-y-6 pt-4 pb-6 sm:grid-cols-2">
            {SHORTCUT_GROUPS.map((group) => {
              const definitions = shortcutsInGroup(group.id)
              if (definitions.length === 0) return null
              return (
                <section
                  key={group.id}
                  data-shortcut-group={group.id}
                  aria-labelledby={`shortcuts-heading-${group.id}`}
                  className="flex flex-col gap-2"
                >
                  <h3
                    id={`shortcuts-heading-${group.id}`}
                    className="sticky top-0 z-10 m-0 bg-[var(--raised)] py-2 text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase"
                  >
                    {group.label}
                  </h3>
                  <dl className="m-0 flex flex-col">
                    {definitions.map((definition) => (
                      <div
                        key={definition.id}
                        data-shortcut={definition.id}
                        className="flex items-baseline justify-between gap-3 border-b border-border/40 py-2 last:border-b-0"
                      >
                        <dt className="m-0 text-xs text-muted-foreground">
                          {definition.description}
                        </dt>
                        <dd className="m-0 flex-none">
                          <kbd className={KBD_CLASS}>{definition.keys}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )
            })}
          </div>

          {/*
           * 下端に「続きがある」ことを示すフェード。本文の最後に置いた sticky なので、
           * スクロール中は下端に貼り付き、最下端では消える（`-mt-12` で高さは 0）。
           * 高さはトークンの 48px（`--space-12`）に合わせる。
           */}
          <div
            aria-hidden="true"
            data-shortcuts-fade
            className={`pointer-events-none sticky bottom-0 -mt-12 h-12 bg-gradient-to-t from-[var(--raised)] via-[var(--raised)]/95 to-transparent transition-opacity duration-[var(--duration-fast)] ${
              atEnd ? 'opacity-0' : 'opacity-100'
            }`}
          />
        </div>

        <div
          data-shortcuts-footer
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-4 text-xs text-muted-foreground"
        >
          <span className="flex flex-wrap items-center gap-1.5">
            <kbd className={KBD_CLASS}>PageDown</kbd>
            <kbd className={KBD_CLASS}>↑</kbd>
            <kbd className={KBD_CLASS}>↓</kbd>
            <span>で本文をスクロール</span>
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className={KBD_CLASS}>Esc</kbd>
            <span>で閉じる</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** App に 1 つ置くだけの入口。`?` の購読と開閉状態を持つ。 */
export function ShortcutsHelp() {
  // `?help=1` は visual:check 用（通常は `?` で開く）。
  const [open, setOpen] = useState(() => helpOpenFromUrl())

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      // 設定・比較・削除の確認などのダイアログ表示中は重ねない
      if (document.querySelector('[role="dialog"]')) return
      if (!shouldOpenHelp(event, event.target)) return
      event.preventDefault()
      setOpen(true)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return <ShortcutsDialog open={open} onOpenChange={setOpen} />
}
