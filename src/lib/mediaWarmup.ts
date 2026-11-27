/**
 * #32: 起動後 1 本目の動画が再生されない問題の対策（ウォームアップ）。
 *
 * WebView2 は起動後に最初の `<video>` を再生するときだけ、メディアの初期化に
 * 時間がかかったり `play()` が拒否されたりすることがある。起動時に非表示の
 * `<video>` で短い無音メディアを `play()` → `pause()` しておき、実際の動画を
 * 開くときにはパイプラインを初期化済みにしておく。
 *
 * 失敗しても起動は止めない（本命の診断ログで原因を追えるようにする）。
 */

export type MediaWarmupResult = 'played' | 'failed' | 'skipped'

/** ウォームアップ用の無音 WebM（16x16・約 1 秒）。`public/warmup.webm`。 */
const WARMUP_FILE = 'warmup.webm'

export type MediaWarmupOptions = {
  /** 既定は `public/warmup.webm`。テスト用に差し替えられる。 */
  source?: string
  /** `play()` が返らない環境で待ち続けないための上限。 */
  timeoutMs?: number
}

/**
 * ウォームアップを 1 回だけ始める（StrictMode の二重実行でも 1 本に抑える）。
 * 起動時に App から呼ぶ。
 */
let started: Promise<MediaWarmupResult> | null = null

export function startMediaWarmup(): Promise<MediaWarmupResult> {
  if (!started) started = warmupMediaPipeline()
  return started
}

/**
 * ウォームアップの結果を `playback.log` 用の 1 行にする。
 * `event=media-warmup` で再生失敗の行と区別できる。
 */
export function formatWarmupLogLine(
  result: MediaWarmupResult,
  at: Date = new Date(),
): string {
  return `${at.toISOString()} event=media-warmup result=${result} file="warmup.webm"`
}

/** 非表示の `<video>` で無音メディアを play → pause する。 */
export function warmupMediaPipeline(
  options: MediaWarmupOptions = {},
): Promise<MediaWarmupResult> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return Promise.resolve('skipped')
  }

  const video = document.createElement('video')
  // 自動再生ポリシーに引っかからないよう、必ずミュートで短い素材を使う。
  video.muted = true
  video.defaultMuted = true
  video.playsInline = true
  video.preload = 'auto'
  video.setAttribute('aria-hidden', 'true')
  video.tabIndex = -1
  // レイアウトに影響を与えない（スクショ回帰にも映らない）。
  video.style.position = 'fixed'
  video.style.left = '-9999px'
  video.style.top = '0'
  video.style.width = '1px'
  video.style.height = '1px'
  video.style.opacity = '0'
  video.style.pointerEvents = 'none'
  video.src = options.source ?? `${import.meta.env.BASE_URL}${WARMUP_FILE}`

  return new Promise<MediaWarmupResult>((resolve) => {
    let settled = false
    let timer: number | null = null

    const cleanup = () => {
      try {
        video.pause()
      } catch {
        // まだ再生が始まっていない / すでに破棄済み
      }
      try {
        video.removeAttribute('src')
      } catch {
        // 属性を外すだけで十分（読み込みは要素の破棄で止まる）
      }
      video.remove()
    }

    const finish = (result: MediaWarmupResult) => {
      if (settled) return
      settled = true
      if (timer !== null) window.clearTimeout(timer)
      video.removeEventListener('error', onError)
      cleanup()
      resolve(result)
    }

    const onError = () => finish('failed')
    video.addEventListener('error', onError, { once: true })

    timer = window.setTimeout(() => finish('failed'), options.timeoutMs ?? 3_000)

    try {
      document.body.appendChild(video)
      const attempt = video.play()
      if (!attempt || typeof attempt.then !== 'function') {
        finish('skipped')
        return
      }
      attempt.then(() => finish('played')).catch(() => finish('failed'))
    } catch {
      finish('failed')
    }
  })
}
