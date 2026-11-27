/**
 * #32: 再生診断の整形とウォームアップ。
 *
 * - `play()` の reject 名 / message と現在値を 1 行のログにする
 * - クリップボード用の複数行テキストにする
 * - 2 フレーム後の再試行を 1 回だけ予約・キャンセルできる
 * - 非表示の `<video>` で play → pause する（失敗しても起動を止めない）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPlaybackDiagnostic,
  describePlayRejection,
  formatPlaybackDiagnosticText,
  formatPlaybackLogLine,
  scheduleAfterTwoFrames,
} from '../src/lib/playbackDiagnostics'
import type { PlaybackDiagnostic } from '../src/lib/playbackDiagnostics'
import { formatWarmupLogLine, warmupMediaPipeline } from '../src/lib/mediaWarmup'

const ENTRY: PlaybackDiagnostic = {
  at: '2026-11-27T03:04:05.006Z',
  event: 'play-reject',
  fileId: 7,
  fileName: 'clip 1.mp4',
  playName: 'NotAllowedError',
  playMessage: 'play "blocked"\nline2',
  readyState: 1,
  networkState: 2,
  errorCode: null,
  errorMessage: null,
  muted: true,
  volume: 0,
  paused: true,
  userActivation: { isActive: false, hasBeenActive: true },
  hasFocus: false,
}

describe('describePlayRejection', () => {
  it('DOMException の name / message をそのまま使う', () => {
    expect(
      describePlayRejection(new DOMException('play blocked', 'NotAllowedError')),
    ).toEqual({ name: 'NotAllowedError', message: 'play blocked' })
  })

  it('Error 以外の値でも 1 行にできる', () => {
    expect(describePlayRejection('boom')).toEqual({ name: 'Error', message: 'boom' })
    expect(describePlayRejection({ name: 'AbortError', message: 'interrupted' })).toEqual({
      name: 'AbortError',
      message: 'interrupted',
    })
  })
})

describe('formatPlaybackLogLine', () => {
  it('時刻・ファイル・play() の reject・現在値を 1 行に並べる', () => {
    expect(formatPlaybackLogLine(ENTRY)).toBe(
      '2026-11-27T03:04:05.006Z event=play-reject fileId=7 file="clip 1.mp4" ' +
        'playName=NotAllowedError playMessage="play \\"blocked\\"\\nline2" ' +
        'readyState=1 networkState=2 errorCode=null errorMessage=null muted=true ' +
        'volume=0.00 paused=true userActivation=false/true hasFocus=false',
    )
  })

  it('timeout / media-error では play() の値が null になる', () => {
    const line = formatPlaybackLogLine({
      ...ENTRY,
      event: 'ready-timeout',
      playName: null,
      playMessage: null,
      readyState: 2,
      errorCode: 4,
      errorMessage: 'MEDIA_ELEMENT_ERROR: Format error',
    })
    expect(line).toContain('event=ready-timeout')
    expect(line).toContain('playName=null playMessage=null')
    expect(line).toContain('readyState=2')
    expect(line).toContain('errorCode=4')
    expect(line).toContain('errorMessage="MEDIA_ELEMENT_ERROR: Format error"')
  })
})

describe('formatPlaybackDiagnosticText', () => {
  it('バナー / クリップボード用に理由と値を並べる', () => {
    const text = formatPlaybackDiagnosticText(ENTRY)
    expect(text).toContain('再生診断: play() が拒否されました')
    expect(text).toContain('ファイル: clip 1.mp4 (ID 7)')
    expect(text).toContain('play(): NotAllowedError — play "blocked"')
    expect(text).toContain('readyState: 1')
    expect(text).toContain('networkState: 2')
    expect(text).toContain('error.code: null')
    expect(text).toContain('muted: true')
    expect(text).toContain('volume: 0.00')
    expect(text).toContain('paused: true')
    expect(text).toContain('userActivation: isActive=false, hasBeenActive=true')
    expect(text).toContain('document.hasFocus(): false')
  })
})

describe('createPlaybackDiagnostic', () => {
  it('失敗時点の video の値を写し、reject 名を取り出す', () => {
    const diagnostic = createPlaybackDiagnostic({
      event: 'play-reject',
      file: { id: 11, name: 'a.mp4' },
      video: {
        readyState: 0,
        networkState: 1,
        error: { code: 2, message: 'network' },
        muted: false,
        volume: 0.35,
        paused: true,
      },
      cause: new DOMException('nope', 'NotAllowedError'),
      at: new Date('2026-01-02T03:04:05.000Z'),
    })
    expect(diagnostic).toMatchObject({
      at: '2026-01-02T03:04:05.000Z',
      event: 'play-reject',
      fileId: 11,
      fileName: 'a.mp4',
      playName: 'NotAllowedError',
      playMessage: 'nope',
      readyState: 0,
      networkState: 1,
      errorCode: 2,
      errorMessage: 'network',
      muted: false,
      volume: 0.35,
      paused: true,
    })
  })
})

describe('scheduleAfterTwoFrames', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('2 フレーム後に 1 回だけ呼ぶ', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    scheduleAfterTwoFrames(callback)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('キャンセルしたら呼ばない', () => {
    vi.useFakeTimers()
    const callback = vi.fn()
    const cancel = scheduleAfterTwoFrames(callback)
    cancel()
    vi.advanceTimersByTime(100)
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('warmupMediaPipeline', () => {
  let play: ReturnType<typeof vi.spyOn>
  let pause: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('起動時のウォームアップ結果をログ用の 1 行にする', () => {
    expect(formatWarmupLogLine('played', new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z event=media-warmup result=played file="warmup.webm"',
    )
  })

  it('非表示の <video> を play → pause して片付ける', async () => {
    await expect(warmupMediaPipeline({ source: 'blob:warmup' })).resolves.toBe('played')
    expect(play).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('video[aria-hidden="true"]')).toBeNull()
  })

  it('play() が拒否されても起動を止めない', async () => {
    play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
    await expect(warmupMediaPipeline({ source: 'blob:warmup' })).resolves.toBe('failed')
    expect(pause).toHaveBeenCalled()
    expect(document.querySelector('video[aria-hidden="true"]')).toBeNull()
  })
})
