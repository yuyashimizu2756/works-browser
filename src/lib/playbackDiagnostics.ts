/**
 * #32: 起動後 1 本目の動画が再生されない問題の診断。
 *
 * `play()` の reject は `name`（`NotAllowedError` / `NotSupportedError` /
 * `AbortError`）で原因の当たりが付く。あわせて `readyState` / `networkState` /
 * `error.code` / `muted` / `volume` / `paused` と、自動再生の可否を左右する
 * `navigator.userActivation` / `document.hasFocus()` を 1 つにまとめる。
 *
 * ここは DOM に依存しない整形を中心に置き、単体テストで確認する。実際の
 * 書き込みは Rust の `playback_log(line)`（`%APPDATA%\works-browser\playback.log`）。
 */
import { api } from '../api'

/** 診断を残すきっかけ。 */
export type PlaybackDiagnosticEvent = 'play-reject' | 'ready-timeout' | 'media-error'

export type PlaybackSnapshot = {
  readyState: number
  networkState: number
  errorCode: number | null
  errorMessage: string | null
  muted: boolean
  volume: number
  paused: boolean
}

export type UserActivationSnapshot = {
  isActive: boolean
  hasBeenActive: boolean
}

export type PlaybackDiagnostic = PlaybackSnapshot & {
  /** ISO 8601（UTC）。`playback.log` の行頭にも同じ値を使う。 */
  at: string
  event: PlaybackDiagnosticEvent
  fileId: number | null
  fileName: string | null
  /** `play()` の reject 名。timeout / media-error では null。 */
  playName: string | null
  /** `play()` の reject message。timeout / media-error では null。 */
  playMessage: string | null
  userActivation: UserActivationSnapshot | null
  hasFocus: boolean
}

/** `mediaFailureInfo` と同じく、必要なプロパティだけを受け取る。 */
export type PlaybackVideoLike = {
  readyState: number
  networkState: number
  error: { code: number; message?: string } | null
  muted: boolean
  volume: number
  paused: boolean
}

export type PlaybackFileLike = { id: number; name: string }

const EVENT_LABEL: Record<PlaybackDiagnosticEvent, string> = {
  'play-reject': 'play() が拒否されました',
  'ready-timeout': '3 秒たっても再生の準備ができません（readyState < 3）',
  'media-error': '動画を読み込めませんでした（メディアエラー）',
}

/** `play()` の reject から、ログに残す name / message を取り出す。 */
export function describePlayRejection(cause: unknown): { name: string; message: string } {
  if (typeof cause === 'object' && cause !== null) {
    const record = cause as { name?: unknown; message?: unknown }
    const name =
      typeof record.name === 'string' && record.name.length > 0 ? record.name : 'Error'
    const message =
      typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : String(cause)
    return { name, message }
  }
  return { name: 'Error', message: String(cause) }
}

/** `navigator.userActivation`（未実装の環境では null）。 */
export function readUserActivation(): UserActivationSnapshot | null {
  if (typeof navigator === 'undefined') return null
  const activation = navigator.userActivation as UserActivation | undefined
  if (!activation) return null
  return {
    isActive: Boolean(activation.isActive),
    hasBeenActive: Boolean(activation.hasBeenActive),
  }
}

/** `document.hasFocus()`（未実装の環境では false）。 */
export function readHasFocus(): boolean {
  if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') {
    return false
  }
  try {
    return document.hasFocus()
  } catch {
    return false
  }
}

/** `<video>` の現在値を、そのままログに書ける形にする。 */
export function playbackSnapshot(video: PlaybackVideoLike): PlaybackSnapshot {
  return {
    readyState: video.readyState,
    networkState: video.networkState,
    errorCode: video.error?.code ?? null,
    errorMessage: video.error?.message ?? null,
    muted: video.muted,
    volume: Number.isFinite(video.volume) ? video.volume : 0,
    paused: video.paused,
  }
}

/** 失敗 1 件分の診断を作る（時刻は呼び出し時点）。 */
export function createPlaybackDiagnostic(input: {
  event: PlaybackDiagnosticEvent
  file: PlaybackFileLike | null
  video: PlaybackVideoLike
  cause?: unknown
  at?: Date
}): PlaybackDiagnostic {
  const rejection =
    input.event === 'play-reject' && input.cause !== undefined
      ? describePlayRejection(input.cause)
      : null
  return {
    at: (input.at ?? new Date()).toISOString(),
    event: input.event,
    fileId: input.file?.id ?? null,
    fileName: input.file?.name ?? null,
    playName: rejection?.name ?? null,
    playMessage: rejection?.message ?? null,
    userActivation: readUserActivation(),
    hasFocus: readHasFocus(),
    ...playbackSnapshot(input.video),
  }
}

/** ログの値を 1 行に収める（空白・引用符・改行を壊さない）。 */
function quote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}"`
}

/**
 * `playback.log` に追記する 1 行。`key=value` を空白区切りで並べる。
 * `playName` / `playMessage` が無い場合は `null` と書く（列をずらさない）。
 */
export function formatPlaybackLogLine(entry: PlaybackDiagnostic): string {
  const activation = entry.userActivation
    ? `${entry.userActivation.isActive}/${entry.userActivation.hasBeenActive}`
    : 'null'
  const fields = [
    `event=${entry.event}`,
    `fileId=${entry.fileId ?? 'null'}`,
    `file=${entry.fileName === null ? 'null' : quote(entry.fileName)}`,
    `playName=${entry.playName ?? 'null'}`,
    `playMessage=${entry.playMessage === null ? 'null' : quote(entry.playMessage)}`,
    `readyState=${entry.readyState}`,
    `networkState=${entry.networkState}`,
    `errorCode=${entry.errorCode ?? 'null'}`,
    `errorMessage=${entry.errorMessage === null ? 'null' : quote(entry.errorMessage)}`,
    `muted=${entry.muted}`,
    `volume=${entry.volume.toFixed(2)}`,
    `paused=${entry.paused}`,
    `userActivation=${activation}`,
    `hasFocus=${entry.hasFocus}`,
  ]
  return `${entry.at} ${fields.join(' ')}`
}

/** 「診断情報をコピー」でクリップボードへ渡す複数行のテキスト。 */
export function formatPlaybackDiagnosticText(entry: PlaybackDiagnostic): string {
  const activation = entry.userActivation
    ? `isActive=${entry.userActivation.isActive}, hasBeenActive=${entry.userActivation.hasBeenActive}`
    : '取得できません'
  const lines = [
    `再生診断: ${EVENT_LABEL[entry.event]}`,
    `時刻: ${entry.at}`,
    `ファイル: ${entry.fileName ?? '(不明)'} (ID ${entry.fileId ?? '-'})`,
    entry.playName === null
      ? null
      : `play(): ${entry.playName}${entry.playMessage === null ? '' : ` — ${entry.playMessage}`}`,
    `readyState: ${entry.readyState}`,
    `networkState: ${entry.networkState}`,
    `error.code: ${entry.errorCode ?? 'null'}`,
    `error.message: ${entry.errorMessage ?? 'null'}`,
    `muted: ${entry.muted}`,
    `volume: ${entry.volume.toFixed(2)}`,
    `paused: ${entry.paused}`,
    `userActivation: ${activation}`,
    `document.hasFocus(): ${entry.hasFocus}`,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

/**
 * `play()` の再試行を 2 フレーム後に行う。
 *
 * WebView2 では `loadedmetadata` の直後はまだ描画・音声の準備が整っておらず、
 * 同じタスクで `play()` をやり直しても拒否されることがある。2 フレーム待つと
 * コンポジットが 1 回進むため、初回の取りこぼしを拾いやすい。
 * `requestAnimationFrame` が無い環境（jsdom / 一部の headless）では
 * 16ms のタイマー 2 回で代用する。
 *
 * 戻り値はキャンセル関数（ファイルを変えた / 閉じたときに呼ぶ）。
 */
export function scheduleAfterTwoFrames(callback: () => void): () => void {
  let cancelled = false
  let first = 0
  let second = 0
  const hasRaf =
    typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'

  if (hasRaf) {
    first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        if (!cancelled) callback()
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(first)
      if (second) window.cancelAnimationFrame(second)
    }
  }

  first = window.setTimeout(() => {
    second = window.setTimeout(() => {
      if (!cancelled) callback()
    }, 16)
  }, 16)
  return () => {
    cancelled = true
    window.clearTimeout(first)
    if (second) window.clearTimeout(second)
  }
}

/** 診断をログへ追記する。書けなくても再生は止めない。 */
export async function logPlaybackDiagnostic(entry: PlaybackDiagnostic): Promise<void> {
  await logPlaybackLine(formatPlaybackLogLine(entry))
}

/** 整形済みの 1 行をそのまま追記する（ウォームアップ結果など）。 */
export async function logPlaybackLine(line: string): Promise<void> {
  try {
    await api.playbackLog?.(line)
  } catch {
    // ログが書けない環境（ベンチ / ブラウザ単体）でも閲覧は続けられる
  }
}
