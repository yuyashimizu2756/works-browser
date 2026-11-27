import { describe, expect, it } from 'vitest'
import {
  effectiveVolume,
  initialVolumeState,
  INITIAL_MUTED,
  INITIAL_VOLUME,
  UNMUTE_VOLUME,
  volumeAfterMuteToggle,
  volumeAfterSlider,
} from '../src/lib/volume'

describe('音量の初期値', () => {
  it('起動時は必ず音量 0・ミュート', () => {
    expect(INITIAL_VOLUME).toBe(0)
    expect(INITIAL_MUTED).toBe(true)
    expect(initialVolumeState()).toEqual({ volume: 0, muted: true })
  })

  it('ミュート中は実効音量も 0', () => {
    expect(effectiveVolume({ volume: 0.8, muted: true })).toBe(0)
    expect(effectiveVolume({ volume: 0.8, muted: false })).toBe(0.8)
  })
})

describe('ミュート解除', () => {
  it('音量 0 から解除すると既定音量まで上がる', () => {
    expect(volumeAfterMuteToggle({ volume: 0, muted: true })).toEqual({
      volume: UNMUTE_VOLUME,
      muted: false,
    })
  })

  it('音量が残っていればそのまま解除する', () => {
    expect(volumeAfterMuteToggle({ volume: 0.4, muted: true })).toEqual({
      volume: 0.4,
      muted: false,
    })
  })

  it('ミュートに戻すときは音量を保つ', () => {
    expect(volumeAfterMuteToggle({ volume: 0.4, muted: false })).toEqual({
      volume: 0.4,
      muted: true,
    })
  })
})

describe('音量スライダー', () => {
  it('0 にするとミュートになる', () => {
    expect(volumeAfterSlider(0)).toEqual({ volume: 0, muted: true })
  })

  it('0 より大きければミュート解除', () => {
    expect(volumeAfterSlider(0.35)).toEqual({ volume: 0.35, muted: false })
  })

  it('0〜1 に丸める', () => {
    expect(volumeAfterSlider(1.7)).toEqual({ volume: 1, muted: false })
    expect(volumeAfterSlider(-0.5)).toEqual({ volume: 0, muted: true })
  })
})
