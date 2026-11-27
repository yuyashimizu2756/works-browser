import type { WatchChanged, WatchPending } from '../api'

/**
 * #63: サイドバーの新着バッジ（`root_id` → `added - removed`）。
 *
 * Rust 側と同じく 0 未満にはしない。永続化はせず、アプリを閉じると消える。
 */
export type PendingBadges = Map<number, number>

/** `added - removed` を 0 未満にしない。 */
export function pendingNet(counts: { added: number; removed: number }): number {
  return Math.max(0, counts.added - counts.removed)
}

/** `watch_pending` の戻り値をバッジ用の Map にする（0 件は載せない）。 */
export function pendingBadges(rows: WatchPending[]): PendingBadges {
  const badges: PendingBadges = new Map()
  for (const row of rows) {
    const net = pendingNet(row)
    if (net > 0) badges.set(row.root_id, net)
  }
  return badges
}

/** `watch://changed` の増分を足す（削除が上回ったらバッジを消す）。 */
export function applyWatchChanged(
  current: PendingBadges,
  change: WatchChanged,
): PendingBadges {
  const net = Math.max(0, (current.get(change.root_id) ?? 0) + change.added - change.removed)
  if (net === (current.get(change.root_id) ?? 0)) return current
  const next = new Map(current)
  if (net > 0) next.set(change.root_id, net)
  else next.delete(change.root_id)
  return next
}

/** ルートを開いたのでバッジを消す。 */
export function clearBadge(current: PendingBadges, rootId: number): PendingBadges {
  if (!current.has(rootId)) return current
  const next = new Map(current)
  next.delete(rootId)
  return next
}

/** 「すべて」行に出す合計。 */
export function totalBadges(current: PendingBadges): number {
  let total = 0
  for (const value of current.values()) total += value
  return total
}
