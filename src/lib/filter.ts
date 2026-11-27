/**
 * ライブラリの絞り込み（クライアント側）。
 *
 * 実データは SQL（`find_works` / `find_files`）が担当するが、ベンチの合成データと
 * テストでは同じ条件をここで適用する。検索語はタイトル / パスの部分一致で、
 * ASCII の大文字小文字を無視する（SQL 側の `LIKE` と同じ）。
 */

import type {
  FileKindFilter,
  FileSummary,
  WorkKindFilter,
  WorkSummary,
} from '../api'

export type WorkFilterInput = {
  search?: string
  kind?: WorkKindFilter
  rootId?: number | null
}

export type FileFilterInput = {
  search?: string
  kind?: FileKindFilter
  rootId?: number | null
  workId?: number | null
}

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

/** 1 作品が条件に一致するか。 */
export function matchesWork(work: WorkSummary, filter: WorkFilterInput): boolean {
  const needle = normalize(filter.search)
  if (needle) {
    const title = work.title.toLowerCase()
    const relPath = work.rel_path.toLowerCase()
    if (!title.includes(needle) && !relPath.includes(needle)) return false
  }
  if (filter.kind === 'video' && work.kind === 'image') return false
  if (filter.kind === 'image' && work.kind !== 'image') return false
  if (filter.rootId != null && work.root_id !== filter.rootId) return false
  return true
}

/** 条件に一致する作品だけを残す（元の配列は変更しない）。 */
export function filterWorks(
  works: readonly WorkSummary[],
  filter: WorkFilterInput,
): WorkSummary[] {
  return works.filter((work) => matchesWork(work, filter))
}

/** 1 ファイルが条件に一致するか。 */
export function matchesFile(file: FileSummary, filter: FileFilterInput): boolean {
  const needle = normalize(filter.search)
  if (needle) {
    const name = file.name.toLowerCase()
    const relPath = file.rel_path.toLowerCase()
    if (!name.includes(needle) && !relPath.includes(needle)) return false
  }
  if (filter.kind === 'video' && file.kind !== 'video') return false
  if (filter.kind === 'image' && file.kind !== 'image') return false
  if (filter.rootId != null && file.root_id !== filter.rootId) return false
  if (filter.workId != null && file.work_id !== filter.workId) return false
  return true
}

/** 条件に一致するファイルだけを残す（元の配列は変更しない）。 */
export function filterFiles(
  files: readonly FileSummary[],
  filter: FileFilterInput,
): FileSummary[] {
  return files.filter((file) => matchesFile(file, filter))
}
