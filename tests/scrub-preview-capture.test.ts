/**
 * #25: プレビュー用 `<video>` のフレーム抽出。canvas が taint されている
 * （crossOrigin 不一致）・`toDataURL` が投げる場合でも、例外を外へ出さず
 * `null` を返してプレビューを出さないことを確認する。
 */
import { describe, expect, it, vi } from 'vitest'
import { captureScrubFrame } from '../src/library/scrubPreview'

function fakeVideo(width = 320, height = 180): HTMLVideoElement {
  return { videoWidth: width, videoHeight: height } as unknown as HTMLVideoElement
}

function fakeCanvas(options: {
  context?: Partial<CanvasRenderingContext2D> | null
  contextThrows?: boolean
  toDataURL?: () => string
}): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => {
      if (options.contextThrows) throw new Error('context unavailable')
      if (options.context === null) return null
      return options.context ?? { drawImage: () => undefined }
    },
    toDataURL: options.toDataURL ?? (() => 'data:image/webp;base64,AAAA'),
  } as unknown as HTMLCanvasElement
}

describe('captureScrubFrame', () => {
  it('フレームを WebP の data URL にする', () => {
    const drawImage = vi.fn()
    const canvas = fakeCanvas({ context: { drawImage } })
    const frame = captureScrubFrame(fakeVideo(), canvas, 160, 0.7)

    expect(frame).toEqual({
      src: 'data:image/webp;base64,AAAA',
      width: 160,
      height: 90,
    })
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(canvas.width).toBe(160)
    expect(canvas.height).toBe(90)
  })

  it('動画のサイズが未取得なら null', () => {
    expect(captureScrubFrame(fakeVideo(0, 0), fakeCanvas({}))).toBeNull()
  })

  it('getContext が投げても null（例外を外へ出さない）', () => {
    expect(captureScrubFrame(fakeVideo(), fakeCanvas({ contextThrows: true }))).toBeNull()
  })

  it('getContext が null なら null', () => {
    expect(captureScrubFrame(fakeVideo(), fakeCanvas({ context: null }))).toBeNull()
  })

  it('tainted canvas の toDataURL 失敗（SecurityError）を握りつぶして null', () => {
    const canvas = fakeCanvas({
      toDataURL: () => {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError')
      },
    })
    expect(captureScrubFrame(fakeVideo(), canvas)).toBeNull()
  })

  it('drawImage が投げても null', () => {
    const canvas = fakeCanvas({
      context: {
        drawImage: () => {
          throw new Error('draw failed')
        },
      },
    })
    expect(captureScrubFrame(fakeVideo(), canvas)).toBeNull()
  })

  it('data URL でない戻り値はプレビューに出さない', () => {
    const canvas = fakeCanvas({ toDataURL: () => 'about:blank' })
    expect(captureScrubFrame(fakeVideo(), canvas)).toBeNull()
  })
})
