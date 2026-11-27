/**
 * ライブラリの選択ロジック（#27）。
 *
 * 作品グリッド / コンパクトリスト / ファイルモード / 作品詳細で同じ挙動にするため、
 * コンポーネントから切り出した純粋関数。UI は返ってきた `Map` をそのまま state に入れる。
 *
 * - 素のクリック / Ctrl+クリック … 1 件だけトグル（他は保つ）
 * - Shift+クリック … アンカーから範囲選択（Ctrl 併用で追加）
 * - Ctrl+A … 絞り込み結果の全件を選択
 */

export type Selectable = { id: number }

export type SelectModifiers = {
  ctrl: boolean
  shift: boolean
}

export type SelectionResult<T extends Selectable> = {
  selection: Map<number, T>
  anchorId: number | null
}

/**
 * クリック 1 回分の選択状態を計算する。
 *
 * `ordered` は画面に並んでいる順（仮想スクロールの読み込み済み範囲）で、
 * Shift 範囲選択はこの配列の添字で決める。
 */
export function selectWorks<T extends Selectable>(
  current: ReadonlyMap<number, T>,
  clicked: T,
  modifiers: SelectModifiers,
  ordered: readonly T[],
  anchorId: number | null,
): SelectionResult<T> {
  if (modifiers.shift && anchorId !== null) {
    const from = ordered.findIndex((item) => item.id === anchorId)
    const to = ordered.findIndex((item) => item.id === clicked.id)
    if (from !== -1 && to !== -1) {
      const start = Math.min(from, to)
      const end = Math.max(from, to)
      const selection = modifiers.ctrl ? new Map(current) : new Map<number, T>()
      for (let index = start; index <= end; index += 1) {
        const item = ordered[index]
        selection.set(item.id, item)
      }
      // Shift 範囲ではアンカーを動かさない（続けて広げられるように）
      return { selection, anchorId }
    }
  }

  const selection = new Map(current)
  if (selection.has(clicked.id)) selection.delete(clicked.id)
  else selection.set(clicked.id, clicked)
  return { selection, anchorId: clicked.id }
}

/** 絞り込み結果の全件を選択する（Ctrl+A）。 */
export function selectAllWorks<T extends Selectable>(works: readonly T[]): Map<number, T> {
  return new Map(works.map((item) => [item.id, item]))
}

/** 矩形選択（ドラッグ）。`additive` なら既存の選択に足す。 */
export function marqueeSelect<T extends Selectable>(
  current: ReadonlyMap<number, T>,
  picked: readonly T[],
  additive: boolean,
): Map<number, T> {
  const selection = additive ? new Map(current) : new Map<number, T>()
  for (const item of picked) selection.set(item.id, item)
  return selection
}

/** 選択中の合計サイズ（作品は `total_bytes`、ファイルは `bytes`）。 */
export function selectedBytes<T extends { total_bytes?: number; bytes?: number }>(
  selection: ReadonlyMap<number, T>,
): number {
  let total = 0
  for (const item of selection.values()) total += item.total_bytes ?? item.bytes ?? 0
  return total
}
