/**
 * #16: ライトボックスの index とスライドショーの遷移（純粋関数）。
 *
 * 表示の丸め（`Math.min`）だけでは、削除後の履歴（`route.fileIndex`）が古いまま残り、
 * 「戻る → 進む」で消えた位置へ戻ってしまう。ここでは
 * 「削除後にどのファイルを見るべきか」を React に依存しない形で決める。
 *
 * スライドショーも同じく、終端で止まる / 追加読み込みする / 待つ を
 * 1 箇所で判定し、画像の 3 秒送りと動画の再生完了の両方から使う。
 */

/** 表示できる位置へ丸める。要素が 1 件も無ければ `null`（＝閉じる）。 */
export function clampLightboxIndex(index: number, length: number): number | null {
  if (!Number.isFinite(length) || length <= 0) return null
  if (!Number.isFinite(index)) return 0
  return Math.min(length - 1, Math.max(0, Math.trunc(index)))
}

export type LightboxDeletion = {
  /** 削除前の並び（グリッド / ライトボックスと同じ順）。 */
  files: readonly { id: number }[]
  /** 表示していた位置（`files` の添字）。 */
  index: number
  /** 削除されたファイルの id。読み込み済みに無い id は無視する。 */
  deletedIds: Iterable<number>
}

/**
 * 削除後に表示すべき index。`null` は「閉じる」（残り 0 件）。
 *
 * - 表示中のファイルが残る → 同じファイルの新しい位置（前方の削除ぶんだけ前へ）
 * - 表示中のファイルが消えた → その直前の残っているファイル（先頭なら 0）
 * - 末尾を超える index は clamp する
 */
export function lightboxIndexAfterDelete({
  files,
  index,
  deletedIds,
}: LightboxDeletion): number | null {
  const deleted = new Set(deletedIds)
  const remaining = files.filter((file) => !deleted.has(file.id))
  if (remaining.length === 0) return null

  const anchorIndex = clampLightboxIndex(index, files.length) ?? 0
  const anchor = files[anchorIndex]
  if (anchor && !deleted.has(anchor.id)) {
    const next = remaining.findIndex((file) => file.id === anchor.id)
    // 念のため: 見つからないときは最後の 1 件に丸める
    return next >= 0 ? next : remaining.length - 1
  }

  // 表示中が消えた → 前方で最後に残るファイルへ（先頭なら 0）
  const before = files.slice(0, anchorIndex).filter((file) => !deleted.has(file.id))
  const previous = before[before.length - 1]
  if (previous) {
    const next = remaining.findIndex((file) => file.id === previous.id)
    if (next >= 0) return next
  }
  return 0
}

/** スライドショーが次に取る行動。 */
export type SlideshowAction = 'next' | 'load-more' | 'wait' | 'stop'

/**
 * スライドショーの 1 ステップ（画像は 3 秒ごと、動画は再生完了ごと）。
 *
 * - 次がある → `next`
 * - 末尾でまだ読めるページがある → `load-more`
 * - 末尾で読み込み中 → `wait`（止めない・二重に要求しない）
 * - 末尾で読み込み切った → `stop`（自動送りを解除する）
 */
export function slideshowAction(input: {
  index: number
  count: number
  hasMore: boolean
  loadingMore: boolean
}): SlideshowAction {
  if (input.count <= 0) return 'stop'
  if (input.index + 1 < input.count) return 'next'
  if (!input.hasMore) return 'stop'
  return input.loadingMore ? 'wait' : 'load-more'
}
