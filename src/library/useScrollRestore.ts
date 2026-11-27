import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

/** ページ読み込みで高さが伸びる間に合わせるフレーム数（約 3 秒）。 */
const MAX_FRAMES = 180

/**
 * 表示モードを切り替えたときにスクロール位置を戻す（#81）。
 *
 * 作品 / ファイル / タイムラインは別コンポーネントなので、モードを変えると
 * スクロール要素が作り直される。呼び出し側（`LibraryView`）がモードごとの
 * `scrollTop` を覚えておき、マウント直後にその位置へ戻す。
 *
 * データは 1 ページずつ届くため、まだ高さが足りない間は `scrollTop` が
 * 末尾に丸められる。そのまま数フレーム粘って、ページが増えたら再度合わせる。
 * ユーザーがホイール・ドラッグ・キー操作をした時点で復元は中止する
 * （勝手にスクロールを奪わない）。
 */
export function useScrollRestore<T extends HTMLElement>(
  elementRef: RefObject<T | null>,
  target: number | undefined,
) {
  // マウント時の値だけを使う（スクロール中に再適用しない）
  const targetRef = useRef(target ?? 0)

  useEffect(() => {
    const initial = targetRef.current
    const element = elementRef.current
    if (!element || initial <= 0) return

    let cancelled = false
    let frame = 0
    let raf = 0

    const cancel = () => {
      cancelled = true
    }
    element.addEventListener('wheel', cancel, { passive: true })
    element.addEventListener('touchstart', cancel, { passive: true })
    element.addEventListener('pointerdown', cancel)
    element.addEventListener('keydown', cancel)

    const step = () => {
      if (cancelled) return
      const node = elementRef.current
      if (!node) return
      node.scrollTop = initial
      if (Math.abs(node.scrollTop - initial) <= 1) return
      frame += 1
      if (frame <= MAX_FRAMES) raf = window.requestAnimationFrame(step)
    }
    raf = window.requestAnimationFrame(step)

    return () => {
      cancelled = true
      window.cancelAnimationFrame(raf)
      element.removeEventListener('wheel', cancel)
      element.removeEventListener('touchstart', cancel)
      element.removeEventListener('pointerdown', cancel)
      element.removeEventListener('keydown', cancel)
    }
  }, [elementRef])
}
