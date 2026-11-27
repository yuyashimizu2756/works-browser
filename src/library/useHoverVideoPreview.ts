import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaSrc } from './mediaSrc'

/** ホバーしてからプレビューを始めるまで（#21 のサムネイル切替と同じ待ち時間）。 */
export const HOVER_VIDEO_DELAY_MS = 600
/** 1 回のプレビューで再生する長さ。 */
export const HOVER_VIDEO_DURATION_MS = 5_000
/** 再生を始める位置（動画の尺に対する割合）。 */
export const HOVER_VIDEO_START_RATIO = 0.1

type Session = {
  release: () => void
}

/**
 * 動画要素はアプリ全体で 1 つだけ作って使い回す（#46）。
 * 複数カードを素早くホバーしても同時再生は 1 本に保つ。
 */
let sharedVideo: HTMLVideoElement | null = null
/** いま再生中のセッション。次のホバーが始まるときに確実に止めるための番人。 */
let activeSession: Session | null = null

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 使い回す `<video>` を作る。音は絶対に出さないので `muted` /
 * `defaultMuted` をここで固定し、外すコードは書かない。
 */
function getSharedVideo(): HTMLVideoElement {
  if (sharedVideo) return sharedVideo
  const video = document.createElement('video')
  video.muted = true
  video.defaultMuted = true
  video.playsInline = true
  video.preload = 'none'
  video.controls = false
  video.loop = false
  video.setAttribute('muted', '')
  video.setAttribute('playsinline', '')
  video.setAttribute('preload', 'none')
  video.setAttribute('aria-hidden', 'true')
  video.className = 'pointer-events-none absolute inset-0 h-full w-full object-cover'
  sharedVideo = video
  return video
}

/**
 * 作品カード / ファイルタイルのホバー動画プレビュー（#46）。
 *
 * - 600ms ホバーで `mediaSrc(fileId)`（`wbm` プロトコル・Range 配信）を再生する
 * - 再生位置は動画の 10% 地点、5 秒で停止する（ループしない）
 * - 常に無音（`muted` 固定）・`playsInline`・`preload="none"`
 * - 停止時は `pause()` → `src` を外す → `load()` でリソースを解放する
 * - 動画要素はモジュール全体で 1 つだけ（同時再生 1 本）
 * - `enabled = false`（サムネ非表示 / シールド中 / ベンチ）と
 *   `prefers-reduced-motion: reduce` では何もしない
 * - 再生に失敗したら何も出さない（呼び出し側はサムネイルのまま）
 *
 * 返す `videoHostRef` はカード内の重ね表示用の要素。共有 `<video>` は
 * 再生中だけこの要素へ差し込む。
 */
export function useHoverVideoPreview(fileId: number | null | undefined, enabled: boolean) {
  const [playing, setPlaying] = useState(false)
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const releaseRef = useRef<(() => void) | null>(null)
  const timerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const videoHostRef = useCallback((node: HTMLSpanElement | null) => {
    hostRef.current = node
  }, [])

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const release = releaseRef.current
    releaseRef.current = null
    if (release) release()
  }, [])

  const start = useCallback(() => {
    if (!enabled || fileId === null || fileId === undefined) return
    if (prefersReducedMotion()) return
    const src = mediaSrc(fileId)
    if (!src) return

    // 同じカードで pointerenter が続いても待ち時間は 1 回だけ
    stop()

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      const host = hostRef.current
      if (!mountedRef.current || !host) return

      // 別のカードが再生中なら先に止める（同時再生は 1 本だけ）
      const previous = activeSession
      activeSession = null
      previous?.release()

      const video = getSharedVideo()
      let released = false
      let stopTimer: number | null = null
      let session: Session

      const onMetadata = () => {
        if (released) return
        const duration = video.duration
        if (Number.isFinite(duration) && duration > 0) {
          try {
            video.currentTime = duration * HOVER_VIDEO_START_RATIO
          } catch {
            // メタデータ前後でシークできなくても、そのまま再生を続ける
          }
        }
      }

      const release = () => {
        if (released) return
        released = true
        if (stopTimer !== null) {
          window.clearTimeout(stopTimer)
          stopTimer = null
        }
        video.removeEventListener('loadedmetadata', onMetadata)
        video.removeEventListener('error', onError)
        video.pause()
        video.removeAttribute('src')
        video.load()
        video.remove()
        if (activeSession === session) activeSession = null
        if (releaseRef.current === release) releaseRef.current = null
        if (mountedRef.current) setPlaying(false)
      }

      const onError = () => {
        // 失敗時は何も出さない（カードはサムネイルのまま）
        release()
      }

      session = { release }
      releaseRef.current = release
      activeSession = session

      video.addEventListener('loadedmetadata', onMetadata)
      video.addEventListener('error', onError)
      // 念のため毎回ミュートを立て直す。ここから `muted = false` にする経路は無い
      video.muted = true
      video.preload = 'none'
      try {
        video.currentTime = 0
      } catch {
        // まだ src が無い状態でも問題ない
      }
      host.appendChild(video)
      video.src = src
      setPlaying(true)
      onMetadata()

      const started = (() => {
        try {
          return video.play()
        } catch {
          onError()
          return null
        }
      })()
      if (started && typeof started.catch === 'function') {
        started.catch(onError)
      }
      if (released) return

      stopTimer = window.setTimeout(release, HOVER_VIDEO_DURATION_MS)
    }, HOVER_VIDEO_DELAY_MS)
  }, [enabled, fileId, stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stop()
    }
  }, [stop])

  // サムネ非表示 / シールド中へ切り替わったら即座に止める
  useEffect(() => {
    if (!enabled) stop()
  }, [enabled, stop])

  return { playing, videoHostRef, startPreview: start, stopPreview: stop }
}
