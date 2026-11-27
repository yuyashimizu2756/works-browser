import type { FileSortKey, SortKey } from '../api'

export type SortDir = 'asc' | 'desc'

const STORAGE_KEY = 'works-browser.sort'

/** キーごとの既定の向き（更新日=新しい順、名前=昇順 など）。 */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  mtime: 'desc',
  created: 'desc',
  title: 'asc',
  size: 'desc',
  files: 'desc',
  last_opened: 'desc',
  open_count: 'desc',
}

export function defaultDirFor(sort: SortKey): SortDir {
  return DEFAULT_DIR[sort] ?? 'desc'
}

/** ファイルモード（#87）のキーごとの既定の向き。 */
const DEFAULT_FILE_DIR: Record<FileSortKey, SortDir> = {
  mtime: 'desc',
  name: 'asc',
  size: 'desc',
  duration: 'desc',
}

export function defaultFileDirFor(sort: FileSortKey): SortDir {
  return DEFAULT_FILE_DIR[sort] ?? 'desc'
}

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && value in DEFAULT_DIR
}

export function isSortDir(value: unknown): value is SortDir {
  return value === 'asc' || value === 'desc'
}

/** 保存された並び順を読む（壊れていても既定にフォールバック）。 */
export function readSortPreference(): { sort: SortKey; dir: SortDir } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { sort: 'mtime', dir: defaultDirFor('mtime') }
    const parsed = JSON.parse(raw) as { sort?: unknown; dir?: unknown }
    const sort = isSortKey(parsed.sort) ? parsed.sort : 'mtime'
    const dir = isSortDir(parsed.dir) ? parsed.dir : defaultDirFor(sort)
    return { sort, dir }
  } catch {
    return { sort: 'mtime', dir: defaultDirFor('mtime') }
  }
}

export function writeSortPreference(sort: SortKey, dir: SortDir): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ sort, dir }))
  } catch {
    // 保存できない環境ではそのまま動かす
  }
}

export function flipDir(dir: SortDir): SortDir {
  return dir === 'asc' ? 'desc' : 'asc'
}
