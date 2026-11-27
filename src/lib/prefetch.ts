/**
 * #49: 次ページ先読みの判定（グリッド / コンパクトリスト共通）。
 *
 * 表示中の最終行から `rowsAhead` 行以内に読み込み済みの末尾が来たら、
 * 次のページを要求する。`rowsAhead` は「残り 2 画面」を渡す。
 */

/** スクロール領域の高さから 1 画面あたりの行数を見積もる。 */
export function rowsPerScreen(
  viewportHeight: number,
  rowHeight: number,
  fallbackHeight = 600,
): number {
  const height = viewportHeight > 0 ? viewportHeight : fallbackHeight
  return Math.max(1, Math.ceil(height / Math.max(1, rowHeight)))
}

/**
 * 次ページを要求すべきか。
 *
 * `loaded` が 0 のとき（まだ 1 ページも届いていない）は false。
 * 同じページを何度要求しても `useWorkFeed` / `useFileFeed` の pending フラグが
 * 弾くため、ここでは「近づいたか」だけを見る。
 */
export function wantsNextPage(input: {
  lastRowIndex: number
  columns: number
  loaded: number
  /** 末尾まで残り何行になったら要求するか（2 画面分） */
  rowsAhead: number
}): boolean {
  const { lastRowIndex, columns, loaded, rowsAhead } = input
  if (loaded <= 0) return false
  if (columns <= 0) return false
  return (lastRowIndex + Math.max(0, rowsAhead)) * columns >= loaded
}
