/**
 * #12: ミュート解除時の音声出力の再初期化。
 *
 * WebView2（Chromium）では、ミュートのまま自動再生を始めた `<video>` は
 * 音声出力が初期化されず、`muted = false` にしただけでは音が出ないことがある。
 * `pause()` → `play()` で音声パイプラインが初期化され、その場で音が出る。
 *
 * 勝手に再生しない方針（#5）を守るため、**再生中だけ**行う。停止中は何もしない。
 */

/** 再初期化に必要な `<video>` の最小インターフェース（テストで差し替え可能）。 */
export type AudioReinitTarget = {
  readonly paused: boolean
  currentTime: number
  playbackRate: number
  readonly dataset: DOMStringMap
  play: () => Promise<void> | void
  pause: () => void
}

/**
 * 再生中の `<video>` の音声出力を再初期化する。
 *
 * 1. 状態反映後の `play()` をやり直す
 * 2. WebView2 向けフォールバックとして、同一フレームで `pause()` → `play()` を 1 回行う
 *
 * 位置と速度は `pause()` の前後で退避・復元し、`data-audio-reinit="1"` を付ける
 * （実機で「再初期化が走ったか」を確認するため）。停止中は `false` を返して何もしない。
 */
export function reinitializeAudioOutput(video: AudioReinitTarget): boolean {
  if (video.paused) return false
  const position = video.currentTime
  const speed = video.playbackRate
  // 1) ミュート解除の状態反映後に play() を再実行する（エラーは握りつぶす）
  void Promise.resolve(video.play()).catch(() => undefined)
  // 2) それでも駄目な環境向け: pause() → play() で音声出力を作り直す
  video.pause()
  video.currentTime = position
  video.playbackRate = speed
  video.dataset.audioReinit = '1'
  void Promise.resolve(video.play()).catch(() => undefined)
  return true
}
