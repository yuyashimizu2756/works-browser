/**
 * #12: ミュート解除時の音声出力の再初期化。
 *
 * WebView2 では `muted = false` だけでは音が出ないことがあるため、
 * 再生中に `play()` をやり直し、`pause()` → `play()` で音声出力を作り直す。
 * 停止中は勝手に再生しない（`play()` を呼ばない）。
 */
import { describe, expect, it, vi } from 'vitest'
import { reinitializeAudioOutput } from '../src/lib/audioOutput'
import type { AudioReinitTarget } from '../src/lib/audioOutput'

function makeVideo(paused: boolean) {
  const calls: string[] = []
  const video: AudioReinitTarget = {
    paused,
    currentTime: 0,
    playbackRate: 1,
    dataset: {} as DOMStringMap,
    play: vi.fn(() => {
      calls.push('play')
      return Promise.resolve()
    }),
    pause: vi.fn(() => {
      calls.push('pause')
      // pause() で位置・速度がリセットされる環境を模す（復元の確認用）
      video.currentTime = 0
      video.playbackRate = 1
    }),
  }
  return { video, calls }
}

describe('#12 音声出力の再初期化', () => {
  it('再生中は play() → pause() → play() を 1 回ずつ行い、位置と速度を保つ', () => {
    const { video, calls } = makeVideo(false)
    video.currentTime = 42
    video.playbackRate = 1.5

    expect(reinitializeAudioOutput(video)).toBe(true)

    expect(calls).toEqual(['play', 'pause', 'play'])
    expect(video.currentTime).toBe(42)
    expect(video.playbackRate).toBe(1.5)
    expect(video.dataset.audioReinit).toBe('1')
  })

  it('停止中は何もせず、play() を呼ばない（勝手に再生しない）', () => {
    const { video, calls } = makeVideo(true)
    video.currentTime = 42
    video.playbackRate = 1.5

    expect(reinitializeAudioOutput(video)).toBe(false)

    expect(calls).toEqual([])
    expect(video.dataset.audioReinit).toBeUndefined()
    expect(video.currentTime).toBe(42)
    expect(video.playbackRate).toBe(1.5)
  })

  it('play() が拒否されても例外を投げない', async () => {
    const video: AudioReinitTarget = {
      paused: false,
      currentTime: 0,
      playbackRate: 1,
      dataset: {} as DOMStringMap,
      play: vi.fn(() => Promise.reject(new Error('AbortError'))),
      pause: vi.fn(),
    }

    expect(() => reinitializeAudioOutput(video)).not.toThrow()
    // 拒否された Promise を握りつぶしている（unhandled rejection にしない）
    await Promise.resolve()
  })
})
