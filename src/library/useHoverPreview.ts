import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkSummary } from '../api'
import { thumbSrc } from './thumbSrc'

/** ホバーしてからプレビューを出し始めるまで（Issue #21）。 */
export const HOVER_DELAY_MS = 600
/** ファイルサムネイルを切り替える間隔。 */
export const HOVER_INTERVAL_MS = 800
/** 1 カードで先読みする枚数の上限。 */
export const MAX_PREVIEW_THUMBS = 4

/**
 * 同時にプレビューできるカードは 1 枚だけ。
 * 速くマウスを動かしても「1 カード 4 枚」以上を先読みしないための番人。
 */
let activeRelease: (() => void) | null = null

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function isTouchLike(): boolean {
  if (navigator.maxTouchPoints > 0) return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

/**
 * 作品カードのホバープレビュー（#21）。
 *
 * - 600ms ホバーで先頭 4 ファイルのサムネイルを先読みし、表示を始める
 * - 800ms ごとに次のファイルへ切り替え、マウスが外れたらカバーへ戻す
 * - `prefers-reduced-motion: reduce` とタッチ環境では何もしない
 * - サムネ非表示（`enabled = false`）では先読みもしない
 */
export function useHoverPreview(work: WorkSummary, enabled: boolean) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const releaseRef = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    const release = releaseRef.current
    releaseRef.current = null
    if (release) release()
    setPreviewSrc(null)
  }, [])

  const start = useCallback(() => {
    if (!enabled || work.preview_thumbs.length === 0) return
    if (prefersReducedMotion() || isTouchLike()) return

    // 直前にホバーしていたカードの先読みを止める
    stop()

    const sources = work.preview_thumbs
      .slice(0, MAX_PREVIEW_THUMBS)
      .map((path) => thumbSrc(path))
      .filter((src): src is string => src !== null)
    if (sources.length === 0) return

    const loaded: string[] = []
    const images: HTMLImageElement[] = []
    let index = 0
    let ready = false
    let begun = false
    let interval: number | null = null
    let delay: number | null = null
    let released = false

    const begin = () => {
      if (!ready || released || begun || loaded.length === 0) return
      begun = true
      index = 0
      setPreviewSrc(loaded[0])
      interval = window.setInterval(() => {
        if (released || loaded.length === 0) return
        index = (index + 1) % loaded.length
        setPreviewSrc(loaded[index])
      }, HOVER_INTERVAL_MS)
    }

    const release = () => {
      if (released) return
      released = true
      if (delay !== null) window.clearTimeout(delay)
      if (interval !== null) window.clearInterval(interval)
      for (const image of images) {
        image.onload = null
        image.onerror = null
      }
      if (activeRelease === release) activeRelease = null
      setPreviewSrc(null)
    }

    releaseRef.current = release
    activeRelease?.()
    activeRelease = release

    for (const src of sources) {
      const image = new Image()
      image.decoding = 'async'
      images.push(image)
      image.onload = () => {
        if (released) return
        if (!loaded.includes(src)) loaded.push(src)
        // 600ms 経過済みなら、読み込めた時点で表示を始める
        begin()
      }
      image.onerror = () => {
        image.onload = null
      }
      image.src = src
    }

    delay = window.setTimeout(() => {
      ready = true
      begin()
    }, HOVER_DELAY_MS)
  }, [enabled, stop, work.preview_thumbs])

  useEffect(() => {
    if (!enabled) stop()
  }, [enabled, stop])

  useEffect(() => stop, [stop])

  return { previewSrc, startPreview: start, stopPreview: stop }
}
