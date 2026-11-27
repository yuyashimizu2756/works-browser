/** ライブラリの並び替え（クライアント側）。ベンチとテストで同じ規則を使う。 */

import type { FileSortKey, FileSummary, SortKey, WorkSummary } from '../api'

/**
 * 「最近見た」「よく見る」の並びに使う、作品ごとの開封情報（#6）。
 * 実アプリは DB（`marks`）、ベンチはメモリ上の実装を渡す。
 */
export type WorkOrderData = {
  lastOpened?: (workId: number) => number | null
  openCount?: (workId: number) => number
}

/** 作品の並び順。DB の `ORDER BY` と同じ向き（更新日・サイズ・件数は新しい/大きい順）。 */
export function sortWorks(
  works: readonly WorkSummary[],
  sort: SortKey,
  order?: WorkOrderData,
): WorkSummary[] {
  const rows = [...works]
  switch (sort) {
    case 'title':
      rows.sort((a, b) => a.title.localeCompare(b.title, 'ja'))
      break
    case 'size':
      rows.sort((a, b) => b.total_bytes - a.total_bytes)
      break
    case 'files':
      rows.sort((a, b) => b.file_count - a.file_count)
      break
    case 'last_opened':
      // 未開封は末尾。同じ時刻なら id の大きい順（SQL の `w.id DESC` と揃える）
      rows.sort((a, b) => {
        const left = order?.lastOpened?.(a.id) ?? null
        const right = order?.lastOpened?.(b.id) ?? null
        if (left === null && right === null) return b.id - a.id
        if (left === null) return 1
        if (right === null) return -1
        return right - left || b.id - a.id
      })
      break
    case 'open_count':
      rows.sort((a, b) => {
        const left = order?.openCount?.(a.id) ?? 0
        const right = order?.openCount?.(b.id) ?? 0
        return right - left || b.id - a.id
      })
      break
    case 'mtime':
    default:
      rows.sort((a, b) => b.mtime - a.mtime)
      break
  }
  return rows
}

/** ファイルモードの並び順。長さは動画だけ値があるので null を末尾へ送る。 */
export function sortFiles(files: readonly FileSummary[], sort: FileSortKey): FileSummary[] {
  const rows = [...files]
  switch (sort) {
    case 'name':
      rows.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
      break
    case 'size':
      rows.sort((a, b) => b.bytes - a.bytes)
      break
    case 'duration':
      rows.sort((a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1))
      break
    case 'mtime':
    default:
      rows.sort((a, b) => b.mtime - a.mtime)
      break
  }
  return rows
}
