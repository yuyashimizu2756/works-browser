/**
 * シークバー上のスクラブプレビュー（#47）。
 *
 * YouTube のように、シークバー上でマウスを動かした地点のフレームを小さく出す。
 * 実フレームの抽出はプレビュー専用の `<video>` と **1 枚を使い回す canvas** で行い、
 * 本体プレイヤーの再生位置・再生状態には触れない。
 *
 * ここには DOM に依存しない計算（時刻・位置）と、デバウンス / 古い要求の破棄を
 * 受け持つ小さなスケジューラだけを置く（単体テスト対象）。
 */

/** マウスが止まってからフレームを出すまで（Issue #47）。 */
export const SCRUB_PREVIEW_DELAY_MS = 150

/** プレビュー画像の幅（px）。高さは動画のアスペクト比から決める。 */
export const SCRUB_PREVIEW_WIDTH = 160

/** `toDataURL` の品質（WebP）。 */
export const SCRUB_PREVIEW_QUALITY = 0.7

/** カーソルとプレビューの間隔（px）。 */
export const SCRUB_PREVIEW_GAP = 12

/** 画面端から確保する余白（px）。 */
export const SCRUB_PREVIEW_MARGIN = 8

/** 画像の下に出す時刻バーの高さ（px、位置計算用の概算）。 */
export const SCRUB_PREVIEW_CAPTION_HEIGHT = 22

export type ScrubRect = { left: number; width: number }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * シークバー上の `clientX` を再生時刻（秒）に変換する。
 * 範囲外は 0〜`duration` に丸める。長さが未取得（0 以下）なら 0。
 */
export function scrubSecondsAt(clientX: number, rect: ScrubRect, duration: number): number {
  if (!(duration > 0) || !(rect.width > 0) || !Number.isFinite(clientX)) return 0
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
  return ratio * duration
}

export type ScrubFrame = { src: string; width: number; height: number }

/**
 * プレビュー用 `<video>` の現在フレームを data URL にする。
 *
 * `canvas` は呼び出し側で 1 枚を使い回す（毎回 `createElement` しない）。
 * 動画がまだデコードできていない・canvas が使えない・WebP 非対応などの場合は
 * `null` を返し、呼び出し側はプレビューを出さない。
 */
export function captureScrubFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  width = SCRUB_PREVIEW_WIDTH,
  quality = SCRUB_PREVIEW_QUALITY,
): ScrubFrame | null {
  const sourceWidth = video.videoWidth
  const sourceHeight = video.videoHeight
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null

  const height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth))
  canvas.width = width
  canvas.height = height

  let context: CanvasRenderingContext2D | null = null
  try {
    context = canvas.getContext('2d')
  } catch {
    return null
  }
  if (!context) return null

  try {
    context.drawImage(video, 0, 0, width, height)
    const src = canvas.toDataURL('image/webp', quality)
    // WebP 非対応の環境では PNG にフォールバックする（どちらも data URL）
    if (!src.startsWith('data:image/')) return null
    return { src, width, height }
  } catch {
    return null
  }
}

export type ScrubPreviewPosition = { left: number; top: number }

/**
 * カーソル付近の表示位置。右端 / 上端に近いときは左右・上下を反転する。
 */
export function scrubPreviewPosition(
  x: number,
  y: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): ScrubPreviewPosition {
  const maxLeft = Math.max(
    SCRUB_PREVIEW_MARGIN,
    viewport.width - size.width - SCRUB_PREVIEW_MARGIN,
  )
  let left = x + SCRUB_PREVIEW_GAP
  if (left > maxLeft) left = x - SCRUB_PREVIEW_GAP - size.width

  const maxTop = Math.max(
    SCRUB_PREVIEW_MARGIN,
    viewport.height - size.height - SCRUB_PREVIEW_MARGIN,
  )
  let top = y - SCRUB_PREVIEW_GAP - size.height
  if (top < SCRUB_PREVIEW_MARGIN) top = y + SCRUB_PREVIEW_GAP

  return {
    left: clamp(left, SCRUB_PREVIEW_MARGIN, maxLeft),
    top: clamp(top, SCRUB_PREVIEW_MARGIN, maxTop),
  }
}

export type ScrubSeeker = {
  /** 最新の要求として記録し、`delayMs` 後に 1 回だけ `seek` する。 */
  request(seconds: number): void
  /** 予約を取り消し、進行中の seek も無効にする（pointerleave / 再生開始など）。 */
  cancel(): void
  /** そのトークンの seek が最新か（古い `seeked` を捨てる）。 */
  isCurrent(token: number): boolean
}

/**
 * 150ms デバウンス + 最新要求だけを処理するスケジューラ。
 *
 * `request` のたびにトークンを進めるので、遅れて届いた `seeked` は
 * `isCurrent(token)` が false になり破棄できる。
 */
export function createScrubSeeker(
  seek: (seconds: number, token: number) => void,
  delayMs = SCRUB_PREVIEW_DELAY_MS,
): ScrubSeeker {
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest = 0

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    request(seconds: number) {
      clear()
      latest += 1
      const token = latest
      timer = setTimeout(() => {
        timer = null
        // 予約後に新しい要求が来ていたら、この seek は捨てる
        if (token !== latest) return
        seek(seconds, token)
      }, delayMs)
    },
    cancel() {
      clear()
      latest += 1
    },
    isCurrent(token: number) {
      return token === latest
    },
  }
}
