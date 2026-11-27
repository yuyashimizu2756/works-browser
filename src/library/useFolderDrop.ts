import { useEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'

type Options = {
  /** false にすると購読しない（ベンチ / ブラウザ単体）。 */
  enabled?: boolean
  /** ドラッグ中は true、離れた / 外れたら false。 */
  onDragActiveChange: (active: boolean) => void
  /** ドロップされたパス（フォルダ / ファイルの両方が来る）。 */
  onDrop: (paths: string[]) => void
}

/**
 * Tauri v2 の drag-drop イベントを購読する（#25）。
 *
 * エクスプローラからフォルダをウィンドウに落とすと `drop` が来る。
 * パスがファイルかフォルダかはここでは判定せず、Rust の `inspect_root_paths`
 * に任せる（フォルダだけを残す）。
 */
export function useFolderDrop({ enabled = true, onDragActiveChange, onDrop }: Options) {
  useEffect(() => {
    if (!enabled || !isTauri()) return

    let disposed = false
    let unlisten: (() => void) | null = null

    // #49: `@tauri-apps/api/webview`（window / dpi を含む約 16KB）は初期チャンクから外し、
    // マウント後に非同期で読み込む。ドロップ購読は数 ms 遅れても取りこぼさない。
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return
          const payload = event.payload
          if (payload.type === 'enter' || payload.type === 'over') {
            onDragActiveChange(true)
          } else if (payload.type === 'leave') {
            onDragActiveChange(false)
          } else if (payload.type === 'drop') {
            onDragActiveChange(false)
            if (payload.paths.length > 0) onDrop(payload.paths)
          }
        }),
      )
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {
        // ブラウザ単体などで購読できないときは黙って諦める
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled, onDragActiveChange, onDrop])
}
