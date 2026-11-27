/**
 * #100: デザイン検証用の空状態プレビュー。
 *
 * `?bench=N&empty=roots|smart|search|thumbs` のときだけ、空状態のショットを
 * 撮れるようベンチ側のデータを差し替える（通常起動・通常のベンチには影響しない）。
 */
export type EmptyPreview = 'roots' | 'smart' | 'search' | 'thumbs'

const EMPTY_PREVIEWS: readonly EmptyPreview[] = ['roots', 'smart', 'search', 'thumbs']

/** URL の `?empty=` を読む。未指定・未知の値は null。 */
export function emptyPreviewFromUrl(search = window.location.search): EmptyPreview | null {
  const raw = new URLSearchParams(search).get('empty')
  if (raw === null) return null
  return EMPTY_PREVIEWS.includes(raw as EmptyPreview) ? (raw as EmptyPreview) : null
}

/** 検索 0 件のショット用の、どの作品にも一致しない検索語。 */
export const EMPTY_SEARCH_QUERY = '該当なし-empty-state'

/** `?q=` で検索語を指定して開く（空状態のショット・共有用）。 */
export function initialSearchFromUrl(search = window.location.search): string | null {
  const raw = new URLSearchParams(search).get('q')
  const value = raw?.trim() ?? ''
  return value === '' ? null : value
}
