/**
 * 再生音量の保存（#8）。
 *
 * 既定は **毎回ミュート**。設定画面で「音量を保存する」を有効にしたときだけ、
 * 直近の音量とミュート状態を localStorage に残して次回の再生に使う。
 *
 * `config.json` が正だが、ライトボックスは起動直後に同期で初期値が要るため、
 * 設定画面が保存時に localStorage へ写す（`preferences.ts` と同じ方式）。
 */

const REMEMBER_KEY = 'works-browser.remember-volume'
const VOLUME_KEY = 'works-browser.playback-volume'

export type PlaybackPreference = {
  volume: number
  muted: boolean
}

/** 既定（毎回ミュート）。 */
export const DEFAULT_PLAYBACK: PlaybackPreference = { volume: 0, muted: true }

/** 設定画面の「音量を保存する」を localStorage に反映する。 */
export function setRememberVolume(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(REMEMBER_KEY, '1')
    else {
      window.localStorage.removeItem(REMEMBER_KEY)
      window.localStorage.removeItem(VOLUME_KEY)
    }
  } catch {
    // ストレージが使えない環境では毎回ミュートのまま
  }
}

export function isRememberVolumeEnabled(): boolean {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) === '1'
  } catch {
    return false
  }
}

/** 再生開始時の音量。保存が無効なら毎回ミュート。 */
export function readPlaybackPreference(): PlaybackPreference {
  if (!isRememberVolumeEnabled()) return DEFAULT_PLAYBACK
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY)
    if (!raw) return DEFAULT_PLAYBACK
    const parsed = JSON.parse(raw) as Partial<PlaybackPreference>
    const volume =
      typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
        ? Math.min(1, Math.max(0, parsed.volume))
        : 0
    const muted = parsed.muted !== false || volume === 0
    return { volume, muted }
  } catch {
    return DEFAULT_PLAYBACK
  }
}

/** 音量・ミュートの変更を保存する（「保存する」が無効なら何もしない）。 */
export function rememberPlayback(volume: number, muted: boolean) {
  if (!isRememberVolumeEnabled()) return
  try {
    const safeVolume = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0))
    window.localStorage.setItem(
      VOLUME_KEY,
      JSON.stringify({ volume: safeVolume, muted: muted || safeVolume === 0 }),
    )
  } catch {
    // 保存できなくても再生は続けられる
  }
}
