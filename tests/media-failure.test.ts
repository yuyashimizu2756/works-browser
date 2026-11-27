/**
 * #26: 動画の再生失敗・シーク可否の判定。
 *
 * `console.warn` に残す内容（サイズ・コーデック・エラーコード）と、
 * `video.seekable.length === 0` の分岐を純粋関数として確認する。
 */
import { describe, expect, it } from 'vitest'
import {
  codecHint,
  hasSeekableRange,
  mediaFailureInfo,
} from '../src/lib/mediaFailure'

function ranges(length: number, end = 0): TimeRanges {
  return {
    length,
    start: () => 0,
    end: () => end,
  } as TimeRanges
}

describe('codecHint', () => {
  it('拡張子からコーデックの当たりを返す', () => {
    expect(codecHint('clip.mp4')).toContain('H.264')
    expect(codecHint('clip.WEBM')).toContain('VP9')
    expect(codecHint('clip.mkv')).toContain('Matroska')
    expect(codecHint('no-extension')).toBe('不明')
  })
})

describe('hasSeekableRange', () => {
  it('シーク可能な範囲があれば true', () => {
    expect(
      hasSeekableRange({ seekable: ranges(1, 120), duration: 120, readyState: 1 }),
    ).toBe(true)
  })

  it('メタデータ前に seekable が空でも、まだ判定しない（true）', () => {
    expect(
      hasSeekableRange({ seekable: ranges(0), duration: 120, readyState: 0 }),
    ).toBe(true)
  })

  it('メタデータ後（readyState >= 1）に seekable 0 なら false', () => {
    expect(
      hasSeekableRange({ seekable: ranges(0), duration: 120, readyState: 1 }),
    ).toBe(false)
    expect(
      hasSeekableRange({ seekable: null, duration: 0, readyState: 2 }),
    ).toBe(true)
  })

  it('end() が 0 を返す範囲はシーク不可とみなす', () => {
    expect(
      hasSeekableRange({ seekable: ranges(1, 0), duration: 120, readyState: 1 }),
    ).toBe(false)
  })
})

describe('mediaFailureInfo', () => {
  it('サイズ・コーデック・エラーコードを 1 つにまとめる', () => {
    const info = mediaFailureInfo(
      {
        id: 42,
        name: 'clip.mp4',
        bytes: 12_345_678,
        duration_ms: 60_000,
        width: 640,
        height: 360,
      },
      {
        videoWidth: 1920,
        videoHeight: 1080,
        readyState: 2,
        networkState: 3,
        error: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' } as MediaError,
        seekable: ranges(1, 60),
      },
      new Error('NotSupportedError'),
    )

    expect(info).toMatchObject({
      fileId: 42,
      file: 'clip.mp4',
      bytes: 12_345_678,
      durationMs: 60_000,
      width: 1920,
      height: 1080,
      errorCode: 4,
      errorMessage: 'MEDIA_ELEMENT_ERROR: Format error',
      readyState: 2,
      networkState: 3,
      seekableLength: 1,
    })
    expect(info.codec).toContain('H.264')
    expect(info.cause).toContain('NotSupportedError')
  })

  it('デコード前でもファイルの記録サイズを使う', () => {
    const info = mediaFailureInfo(
      { id: 7, name: 'clip.webm', bytes: 1, duration_ms: null, width: 800, height: 600 },
      {
        videoWidth: 0,
        videoHeight: 0,
        readyState: 0,
        networkState: 0,
        error: null,
        seekable: ranges(0),
      },
    )
    expect(info.width).toBe(800)
    expect(info.height).toBe(600)
    expect(info.errorCode).toBeNull()
    expect(info.seekableLength).toBe(0)
    expect(info.cause).toBeNull()
  })
})
