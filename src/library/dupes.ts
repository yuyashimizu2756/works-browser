/**
 * #67: 重複グループの UI 用ヘルパー。
 *
 * 「残す 1 枚」は Rust 側が提案する（画素数 → バイト数 → 新しい順）。
 * ダイアログで選び直したときは `keeperId` を渡して上書きする。
 */
import type { DupFile, DupGroup } from '@/api'

/** グループのキーパー（残す 1 枚）。`keeperId` があればそれを優先する。 */
export function keeperOf(group: DupGroup, keeperId?: number | null): DupFile | null {
  if (keeperId !== null && keeperId !== undefined) {
    const picked = group.files.find((file) => file.id === keeperId)
    if (picked) return picked
  }
  return group.files.find((file) => file.keeper) ?? group.files[0] ?? null
}

/** 削除してよいファイル id（キーパー以外）。 */
export function removalIds(group: DupGroup, keeperId?: number | null): number[] {
  const keeper = keeperOf(group, keeperId)
  if (!keeper) return []
  return group.files.filter((file) => file.id !== keeper.id).map((file) => file.id)
}

/** キーパー以外の合計バイト数（空く容量）。 */
export function wastedBytes(group: DupGroup, keeperId?: number | null): number {
  const keeper = keeperOf(group, keeperId)
  if (!keeper) return 0
  return group.files.reduce(
    (total, file) => (file.id === keeper.id ? total : total + Math.max(0, file.bytes)),
    0,
  )
}

/** 複数グループの合計（空く容量）。 */
export function totalWasted(groups: DupGroup[]): number {
  return groups.reduce((total, group) => total + group.wasted_bytes, 0)
}
