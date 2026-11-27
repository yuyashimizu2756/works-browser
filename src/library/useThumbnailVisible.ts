import { useCallback, useState } from 'react'

/**
 * サムネイル表示トグル（#21 の「サムネ非表示」）。
 *
 * このフックを経由しないとサムネイルを読みに行かない、というのが約束:
 * - `WorkCard` / `FileTile` は `thumbnailsVisible === false` のとき `convertFileSrc` を呼ばない
 * - ホバープレビューも無効になる
 * - `ThumbStatus` は非表示中に `generate_thumbs` をキックせず、購読も張らない
 *
 * 状態の保存は `preferences.ts`（`config.json`）が行う。
 */
export function useThumbnailVisible(defaultVisible = false) {
  const [thumbnailsVisible, setThumbnailsVisible] = useState(defaultVisible)

  const toggleThumbnails = useCallback(() => {
    setThumbnailsVisible((current) => !current)
  }, [])

  return { thumbnailsVisible, setThumbnailsVisible, toggleThumbnails }
}
