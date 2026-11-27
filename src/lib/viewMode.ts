import type { FileKindFilter, FileSortKey } from '../api'
import type { ShieldAppearance } from '../library/shield/settings'

/**
 * ライブラリの表示モード（#21）。
 *
 * - `works` … 作品カードのグリッド（既定）
 * - `files` … `files` を直接並べるファイルモード
 * - `timeline` … 作品を更新日のローカル日付でまとめるタイムライン（#81）
 *
 * サムネイル非表示はモードではなく独立トグルで、どのモードにも被さる
 * （`useThumbnailVisible`）。非表示中は作品 / ファイルモードはコンパクトなリストになり、
 * タイムラインはサムネイルを要求しないカード表示のままになる。
 */
export type LibraryViewMode = 'works' | 'files' | 'timeline'

export const VIEW_MODE_LABEL: Record<LibraryViewMode, string> = {
  works: '作品',
  files: 'ファイル',
  timeline: 'タイムライン',
}

/**
 * ヘッダーのボタン / README に出すショートカット（Windows なので Ctrl のみ）。
 *
 * #88: ルート絞り込み（#55）の `Ctrl+1..9` と衝突しないよう、表示モードは
 * `Alt+1` / `Alt+2` / `Alt+3` に移した。タイムラインは従来の `Ctrl+Shift+T` も
 * 受け付ける（`SHORTCUT_DEFINITIONS` の `view-timeline`）。
 */
export const VIEW_MODE_SHORTCUT: Record<LibraryViewMode, string> = {
  works: 'Alt+1',
  files: 'Alt+2',
  timeline: 'Alt+3',
}

export const THUMBNAIL_SHORTCUT = 'Ctrl+Shift+H'

/** ファイルモードの並び替え。 */
export const FILE_SORTS: { key: FileSortKey; label: string }[] = [
  { key: 'mtime', label: '更新日' },
  { key: 'name', label: '名前' },
  { key: 'size', label: 'サイズ' },
  { key: 'duration', label: '長さ' },
]

/** ファイルモードの種類フィルタ。 */
export const FILE_KIND_FILTERS: { key: FileKindFilter; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'video', label: '動画のみ' },
  { key: 'image', label: '画像のみ' },
]

/**
 * 表示モードを順に切り替える（`works` → `files` → `timeline` → `works`）。
 *
 * ヘッダーのタブは直接モードを指定するが、トグル操作（将来のキーバインドや
 * メニュー）でも同じ遷移になるよう純粋関数にしておく。
 */
export function nextViewMode(mode: LibraryViewMode): LibraryViewMode {
  if (mode === 'works') return 'files'
  if (mode === 'files') return 'timeline'
  return 'works'
}

/** ベンチ用: `?mode=files` / `?mode=timeline` でそのモードから開く。 */
export function initialViewModeFromUrl(search = window.location.search): LibraryViewMode | null {
  const mode = new URLSearchParams(search).get('mode')
  if (mode === 'works' || mode === 'files' || mode === 'timeline') return mode
  return null
}

/** ベンチ用: `?thumbs=hidden` でサムネ非表示から開く。 */
export function initialThumbnailsFromUrl(search = window.location.search): boolean | null {
  const raw = new URLSearchParams(search).get('thumbs')
  if (raw === 'hidden' || raw === '0' || raw === 'false') return false
  if (raw === 'shown' || raw === '1' || raw === 'true') return true
  return null
}

/**
 * ベンチ / headless 用: `?shield=1`（または `plain` / `files`）で
 * シールド中の画面から開く。`plain` / `files` は見た目の上書きにも使う。
 */
export function initialShieldFromUrl(search = window.location.search): {
  active: boolean
  appearance: ShieldAppearance | null
} {
  const raw = new URLSearchParams(search).get('shield')
  if (raw === 'plain' || raw === 'files') return { active: true, appearance: raw }
  if (raw === '1' || raw === 'true' || raw === 'hidden') {
    return { active: true, appearance: null }
  }
  return { active: false, appearance: null }
}
