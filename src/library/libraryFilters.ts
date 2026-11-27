import type { SortKey, WorkKindFilter } from '../api'
import type { SortDir } from './sortPrefs'
import { readSortPreference } from './sortPrefs'

/**
 * #120: ライブラリの絞り込み状態。
 *
 * 作品詳細へ移動すると `LibraryView` はアンマウントされるため、画面ローカルの
 * `useState` だけでは「選んでいたルート」などが失われます。離脱時にこの形で
 * 履歴（`LibrarySnapshot`）へ写し、戻ったときの初期値にします。
 *
 * ファイルモードのルートは作品モードとは独立して選べるため、別のキーで持ちます。
 */
export type LibraryFilters = {
  search: string
  kind: WorkKindFilter
  rootId: number | null
  tagId: number | null
  minRating: number | null
  favorite: boolean
  metaSearch: boolean
  sort: SortKey
  sortDir: SortDir
  /** ファイルモードのルート絞り込み（#21）。 */
  fileRootId: number | null
}

/** 初回表示・「すべて」を選んだときの素直な初期値。 */
export function defaultLibraryFilters(): LibraryFilters {
  const { sort, dir } = readSortPreference()
  return {
    search: '',
    kind: 'all',
    rootId: null,
    tagId: null,
    minRating: null,
    favorite: false,
    metaSearch: false,
    sort,
    sortDir: dir,
    fileRootId: null,
  }
}

/**
 * ルートを選ぶ。作品モードとファイルモードのルートは同じ操作で揃える
 * （サイドバーの `Ctrl+1..9` / クリックは両方に効く）。
 * `null`（すべて）もそのまま両方へ反映する。
 */
export function withRootFilter(filters: LibraryFilters, rootId: number | null): LibraryFilters {
  return { ...filters, rootId, fileRootId: rootId }
}

/**
 * 作品モードの「すべて解除」。並び順とファイルモードのルートは保つ
 * （ファイルモードの絞り込みは別のポップオーバーで解除する）。
 */
export function clearWorkFilters(filters: LibraryFilters): LibraryFilters {
  return {
    ...filters,
    search: '',
    kind: 'all',
    rootId: null,
    tagId: null,
    minRating: null,
    favorite: false,
    metaSearch: false,
  }
}

/** 2 つの絞り込みが同じ内容か（テスト・履歴の重複判定用）。 */
export function sameLibraryFilters(a: LibraryFilters, b: LibraryFilters): boolean {
  return (
    a.search === b.search &&
    a.kind === b.kind &&
    a.rootId === b.rootId &&
    a.tagId === b.tagId &&
    a.minRating === b.minRating &&
    a.favorite === b.favorite &&
    a.metaSearch === b.metaSearch &&
    a.sort === b.sort &&
    a.sortDir === b.sortDir &&
    a.fileRootId === b.fileRootId
  )
}
