/**
 * 動画プレイヤーの音量（#5）。
 *
 * 起動時は必ずミュート・音量 0。ユーザーが明示的に解除するまで音を出さない。
 * 解除したときに音量 0 のままだと無音で混乱するため、既定音量まで上げる。
 */

/** 起動時の音量（0 = 無音）。 */
export const INITIAL_VOLUME = 0
/** 起動時はミュート。 */
export const INITIAL_MUTED = true
/** ミュート解除時に音量 0 だった場合の既定値。 */
export const UNMUTE_VOLUME = 0.6

export type VolumeState = {
  volume: number
  muted: boolean
}

/** 初期状態を返す（Lightbox の useState 初期値とテストで共有）。 */
export function initialVolumeState(): VolumeState {
  return { volume: INITIAL_VOLUME, muted: INITIAL_MUTED }
}

/**
 * ミュートボタンを押した後の状態。
 * 解除時は音量 0 のままだと無音なので `UNMUTE_VOLUME` まで上げる。
 */
export function volumeAfterMuteToggle(state: VolumeState): VolumeState {
  const muted = !state.muted
  if (!muted && state.volume <= 0) return { muted, volume: UNMUTE_VOLUME }
  return { muted, volume: state.volume }
}

/** 音量スライダーを動かした後の状態。0 にしたらミュート扱い。 */
export function volumeAfterSlider(value: number): VolumeState {
  const volume = Math.min(1, Math.max(0, value))
  return { volume, muted: volume <= 0 }
}

/** `<video>` に実際に渡す音量（ミュート中は 0）。 */
export function effectiveVolume(state: VolumeState): number {
  return state.muted ? 0 : state.volume
}
