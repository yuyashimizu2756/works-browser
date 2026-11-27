import type { SortKey, WorkKindFilter } from '../api'
import { defaultDirFor } from './sortPrefs'

/**
 * スマートフォルダ（保存検索、#69）に保存する絞り込み条件。
 *
 * DB にはこの型をそのまま JSON 文字列で持たせる（`query_json`）。
 * キーを足すときは既定値と [`parseSmartFolderQuery`] の丸めも一緒に更新する。
 */
export type SmartFolderQuery = {
  /** タイトル・パスの検索語（前後の空白は落とす）。 */
  search: string
  kind: WorkKindFilter
  rootId: number | null
  tagId: number | null
  /** 最低評価（1〜5）。未指定は null。 */
  minRating: number | null
  favorite: boolean
  /** 検索語を生成情報（プロンプト・モデル等）にも当てるか。 */
  metaSearch: boolean
  sort: SortKey
  /** `asc` | `desc`。 */
  dir: 'asc' | 'desc'
}

/** 保存前の生の状態（型が崩れていても受け付けられるように緩く取る）。 */
export type SmartFolderFilterInput = {
  search?: unknown
  kind?: unknown
  rootId?: unknown
  tagId?: unknown
  minRating?: unknown
  favorite?: unknown
  metaSearch?: unknown
  sort?: unknown
  dir?: unknown
}

const KINDS: readonly WorkKindFilter[] = ['all', 'video', 'image']
const SORTS: readonly SortKey[] = [
  'mtime',
  'created',
  'title',
  'size',
  'files',
  'last_opened',
  'open_count',
]

export function isWorkKindFilter(value: unknown): value is WorkKindFilter {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

export function isFileSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORTS as readonly string[]).includes(value)
}

function normalizeId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const id = Math.trunc(value)
  return id > 0 ? id : null
}

/** 最低評価は 1〜5 の整数だけ受け付ける（範囲外・小数は未指定に丸める）。 */
export function normalizeMinRating(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rating = Math.trunc(value)
  return rating >= 1 && rating <= 5 ? rating : null
}

/** 現在の UI 状態から、保存する条件を組み立てる（不正値は既定へ丸める）。 */
export function buildSmartFolderQuery(input: SmartFolderFilterInput = {}): SmartFolderQuery {
  const kind = isWorkKindFilter(input.kind) ? input.kind : 'all'
  const sort = isFileSortKey(input.sort) ? input.sort : 'mtime'
  const dir =
    input.dir === 'asc' || input.dir === 'desc' ? input.dir : defaultDirFor(sort)
  return {
    search: typeof input.search === 'string' ? input.search.trim() : '',
    kind,
    rootId: normalizeId(input.rootId),
    tagId: normalizeId(input.tagId),
    minRating: normalizeMinRating(input.minRating),
    favorite: input.favorite === true,
    metaSearch: input.metaSearch === true,
    sort,
    dir,
  }
}

/**
 * DB の `query_json` を読む。壊れている・知らない形式なら「条件なし」に落とす
 * （保存済みの条件が 1 件壊れても一覧全体が使えなくならないように）。
 */
export function parseSmartFolderQuery(queryJson: string): SmartFolderQuery {
  try {
    const parsed: unknown = JSON.parse(queryJson)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return buildSmartFolderQuery()
    }
    return buildSmartFolderQuery(parsed as SmartFolderFilterInput)
  } catch {
    return buildSmartFolderQuery()
  }
}

/** 保存用の JSON 文字列（キー順は固定なので差分が出にくい）。 */
export function stringifySmartFolderQuery(query: SmartFolderQuery): string {
  return JSON.stringify(buildSmartFolderQuery(query))
}

/** 条件の同一性判定用キー（適用中の強調に使う）。 */
export function smartFolderKey(query: SmartFolderQuery): string {
  const normalized = buildSmartFolderQuery(query)
  return [
    normalized.search,
    normalized.kind,
    normalized.rootId ?? '',
    normalized.tagId ?? '',
    normalized.minRating ?? '',
    normalized.favorite ? 'fav' : '',
    normalized.metaSearch ? 'meta' : '',
    normalized.sort,
    normalized.dir,
  ].join('\u0000')
}

/** 保存した条件と、いまの絞り込みが同じか。 */
export function smartFolderMatches(saved: SmartFolderQuery, current: SmartFolderQuery): boolean {
  return smartFolderKey(saved) === smartFolderKey(current)
}
