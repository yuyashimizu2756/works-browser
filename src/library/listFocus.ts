/**
 * `j` / `k` のフォーカス移動（#71）。
 *
 * 仮想スクロールのグリッドは可視行だけが DOM にあるため、表示中の
 * `[data-work-id]` / `[data-file-id]` を順に辿る。末尾に達したら
 * `onBoundary`（次のページの読み込み）を呼び、少し待ってから再試行する。
 */

type Options = {
  /** 対象セレクタ（`[data-work-id]` または `[data-file-id]`）。 */
  selector: string
  delta: 1 | -1
  /** 末尾で次のページを要求する（未指定なら末尾に留まる）。 */
  onBoundary?: () => void
  /** ページ読み込み後の再試行までの待ち時間（ms）。 */
  retryMs?: number
}

function items(selector: string): HTMLElement[] {
  if (typeof document === 'undefined') return []
  const region = document.querySelector('[data-shortcut-region]') ?? document
  return Array.from(region.querySelectorAll<HTMLElement>(selector))
}

/** フォーカスを 1 つ進める / 戻す。移動できたら true。 */
export function focusAdjacentItem({
  selector,
  delta,
  onBoundary,
  retryMs = 200,
}: Options): boolean {
  const current = items(selector)
  if (current.length === 0) return false

  const active = document.activeElement as HTMLElement | null
  const activeItem = active?.closest<HTMLElement>(selector) ?? null
  const index = activeItem ? current.indexOf(activeItem) : -1
  const next = index < 0 ? (delta > 0 ? 0 : current.length - 1) : index + delta

  if (next < 0) {
    current[0]?.focus()
    current[0]?.scrollIntoView?.({ block: 'nearest' })
    return true
  }

  if (next >= current.length) {
    if (!onBoundary) {
      const last = current[current.length - 1]
      last?.focus()
      last?.scrollIntoView?.({ block: 'nearest' })
      return true
    }
    onBoundary()
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        const grown = items(selector)
        // 追加読み込み後は「直前の末尾の次」ではなく、新しい末尾へ進む
        const target = grown[Math.min(grown.length - 1, next)]
        target?.focus()
        target?.scrollIntoView?.({ block: 'nearest' })
      }, retryMs)
    }
    return false
  }

  const target = current[next]
  target.focus()
  target.scrollIntoView?.({ block: 'nearest' })
  return true
}

/** フォーカス中の行の `data-work-id`（ファイル行は所属作品の id を持つ）。 */
export function focusedWorkId(): number | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement as HTMLElement | null
  const node = active?.closest<HTMLElement>('[data-work-id]') ?? null
  if (!node) return null
  const id = Number(node.dataset.workId)
  return Number.isFinite(id) && id > 0 ? id : null
}
