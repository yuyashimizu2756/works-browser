import { useEffect, useRef } from 'react'

type Options = {
  onBack: () => void
  onForward: () => void
  /** false のときは購読しない（シールド中など）。 */
  enabled?: boolean
}

/**
 * #33: マウスのサイドボタン（戻る / 進む）と `Alt+←` / `Alt+→` を同じハンドラにつなぐ。
 *
 * WebView2（Chromium）はサイドボタンを `mousedown` の `button === 3`（戻る）/
 * `4`（進む）として通知する。`preventDefault()` でブラウザ側の履歴移動を抑止し、
 * アプリ内の履歴（`useNavStack`）だけを使う。
 *
 * `auxclick` は同じ操作でも発火するため購読しない（二重発火防止）。
 */
export function useMouseNavButtons({ onBack, onForward, enabled = true }: Options) {
  // 再購読を避けるため、ハンドラは ref 経由で最新を呼ぶ
  const backRef = useRef(onBack)
  const forwardRef = useRef(onForward)
  backRef.current = onBack
  forwardRef.current = onForward

  useEffect(() => {
    if (!enabled) return

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 3) {
        event.preventDefault()
        backRef.current()
      } else if (event.button === 4) {
        event.preventDefault()
        forwardRef.current()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        backRef.current()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        forwardRef.current()
      }
    }

    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [enabled])
}
