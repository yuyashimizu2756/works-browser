import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import {
  SCRUB_PREVIEW_CAPTION_HEIGHT,
  SCRUB_PREVIEW_WIDTH,
  captureScrubFrame,
  createScrubSeeker,
  scrubPreviewPosition,
  scrubSecondsAt,
} from './scrubPreview'

export type ScrubPreview = {
  /** 抽出したフレーム（WebP の data URL）。 */
  src: string
  /** プレビュー地点の再生時刻（秒）。 */
  seconds: number
  /** `position: fixed` の左位置。 */
  left: number
  /** `position: fixed` の上位置。 */
  top: number
}

type Options = {
  /** 動画かつプレビュー可能な状態か（ベンチ / シールド / 再生エラー中は false）。 */
  enabled: boolean
  /** 本体プレイヤーが読んだ動画の長さ（秒）。 */
  duration: number
  /** ファイル切替を検出してプレビューを捨てるためのキー。 */
  fileKey: number | null
}

export type ScrubPreviewHandle = {
  preview: ScrubPreview | null
  /** プレビュー専用 `<video>` に付ける ref（本体とは別要素）。 */
  previewVideoRef: RefObject<HTMLVideoElement | null>
  /** シークバーの `pointermove` に渡す。 */
  handlePointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  /** シークバーの `pointerleave` / `pointercancel` に渡す。 */
  handlePointerLeave: () => void
  /** プレビュー `<video>` の `seeked` に渡す。 */
  handleSeeked: () => void
  /** プレビュー `<video>` の `error` に渡す（本体の再生には影響させない）。 */
  handleError: () => void
  /** プレビューを消す（再生開始など）。 */
  cancel: () => void
}

/**
 * シークバー上のスクラブプレビュー（#47）。
 *
 * - プレビュー専用の `<video>`（ミュート固定）を別要素で 1 つだけ使う
 * - 150ms デバウンスし、最新の要求のフレームだけを描く
 * - `seeked` のたびに **1 枚を使い回す canvas** から data URL を作る
 * - 本体の `<video>` の `currentTime` は変更しない
 */
export function useScrubPreview({ enabled, duration, fileKey }: Options): ScrubPreviewHandle {
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const anchorRef = useRef<{ x: number; y: number } | null>(null)
  const frameSecondsRef = useRef(0)
  const frameTokenRef = useRef(0)
  /** コーデック非対応などで一度失敗したら、このファイルでは出さない。 */
  const failedRef = useRef(false)
  /** #25: フレーム抽出の失敗理由は 1 ファイルにつき 1 回だけコンソールへ出す。 */
  const warnedRef = useRef(false)
  const [preview, setPreview] = useState<ScrubPreview | null>(null)

  const seekerRef = useRef<ReturnType<typeof createScrubSeeker> | null>(null)
  if (seekerRef.current === null) {
    seekerRef.current = createScrubSeeker((seconds, token) => {
      const video = previewVideoRef.current
      if (!video) return
      const max = Number.isFinite(video.duration) ? video.duration : seconds
      try {
        video.currentTime = Math.min(Math.max(0, seconds), Math.max(0, max))
      } catch {
        // まだ読み込めていない等。プレビューを出さないだけで本体は続行する
        return
      }
      frameTokenRef.current = token
      frameSecondsRef.current = seconds
    })
  }

  const cancel = useCallback(() => {
    anchorRef.current = null
    seekerRef.current?.cancel()
    setPreview(null)
  }, [])

  // ファイル切替・プレビュー不可（ベンチ / シールド / 再生エラー）で捨てる
  useEffect(() => {
    failedRef.current = false
    warnedRef.current = false
    anchorRef.current = null
    seekerRef.current?.cancel()
    setPreview(null)
  }, [enabled, fileKey])

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || failedRef.current || !(duration > 0)) return
      const rect = event.currentTarget.getBoundingClientRect()
      const seconds = scrubSecondsAt(event.clientX, rect, duration)
      anchorRef.current = { x: event.clientX, y: event.clientY }
      seekerRef.current?.request(seconds)
    },
    [duration, enabled],
  )

  const handlePointerLeave = useCallback(() => {
    cancel()
  }, [cancel])

  const handleSeeked = useCallback(() => {
    if (!enabled || failedRef.current) return
    const anchor = anchorRef.current
    const video = previewVideoRef.current
    if (!anchor || !video) return
    // 古い要求の seeked は捨てる（最新の要求のフレームだけ描く）
    if (!seekerRef.current?.isCurrent(frameTokenRef.current)) return

    if (canvasRef.current === null) canvasRef.current = document.createElement('canvas')
    const frame = captureScrubFrame(video, canvasRef.current, SCRUB_PREVIEW_WIDTH)
    if (!frame) {
      // #25: canvas が taint されている（crossOrigin 不一致）・toDataURL 失敗など。
      // プレビューは出さず、同じファイルでは繰り返し試さない。
      if (!warnedRef.current) {
        warnedRef.current = true
        console.warn('[scrub-preview] フレームを取得できませんでした', {
          currentSrc: video.currentSrc || video.getAttribute('src') || '',
          crossOrigin: video.crossOrigin,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          readyState: video.readyState,
          errorCode: video.error?.code ?? null,
          errorMessage: video.error?.message ?? null,
        })
      }
      return
    }

    const position = scrubPreviewPosition(
      anchor.x,
      anchor.y,
      { width: frame.width, height: frame.height + SCRUB_PREVIEW_CAPTION_HEIGHT },
      { width: window.innerWidth, height: window.innerHeight },
    )
    setPreview({
      src: frame.src,
      seconds: frameSecondsRef.current,
      left: position.left,
      top: position.top,
    })
  }, [enabled])

  const handleError = useCallback(() => {
    failedRef.current = true
    // #25: プレビュー用 `<video>` の読み込み失敗は本体の再生に影響させない。
    // ただし原因（CORS / コーデック / ネットワーク）は追えるように残す。
    const video = previewVideoRef.current
    if (!warnedRef.current) {
      warnedRef.current = true
      console.warn('[scrub-preview] プレビュー動画を読み込めませんでした', {
        currentSrc: video?.currentSrc || video?.getAttribute('src') || '',
        crossOrigin: video?.crossOrigin ?? null,
        errorCode: video?.error?.code ?? null,
        errorMessage: video?.error?.message ?? null,
        networkState: video?.networkState ?? null,
        readyState: video?.readyState ?? null,
      })
    }
    cancel()
  }, [cancel])

  return {
    preview,
    previewVideoRef,
    handlePointerMove,
    handlePointerLeave,
    handleSeeked,
    handleError,
    cancel,
  }
}
