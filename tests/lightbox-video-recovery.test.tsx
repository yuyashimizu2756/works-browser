/**
 * #26: 自動再生できない・シークできない動画の扱い。
 *
 * - `play()` の reject → `canplay` で 1 回だけ再試行
 * - それでも駄目 → 中央の再生ボタン
 * - `video.seekable.length === 0` → シークバーを無効化して理由を出す
 * - `<video>` の error → 「この形式は再生できません」+ 外部プレイヤー
 */
import { fireEvent, render, waitFor, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lightbox } from '../src/library/Lightbox'
import { makeFile } from './fixtures'

vi.mock('../src/api', () => ({
  api: {
    getFilePosition: vi.fn(async () => null),
    saveFilePosition: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    filePath: vi.fn(async () => 'D:\\Works\\root-1\\work-1\\clip.mp4'),
  },
}))

import { api } from '../src/api'

function renderVideo() {
  const file = makeFile({
    id: 7,
    kind: 'video',
    name: 'clip.mp4',
    duration_ms: 120_000,
  })
  const view = render(
    createElement(Lightbox, {
      files: [file],
      index: 0,
      hasMore: false,
      loadingMore: false,
      onRequestMore: () => undefined,
      onIndexChange: () => undefined,
      onClose: () => undefined,
      bench: false,
    }),
  )
  const video = view.container.querySelector(
    'video:not([data-scrub-preview-video])',
  ) as HTMLVideoElement
  Object.defineProperty(video, 'duration', { configurable: true, value: 120 })
  return { ...view, file, video }
}

function ranges(length: number, end = 0): TimeRanges {
  return { length, start: () => 0, end: () => end } as TimeRanges
}

let play: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play')
  play.mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('#26 play() の再試行', () => {
  it('1 回目の reject は canplay で 1 回だけ再試行する', async () => {
    play
      .mockRejectedValueOnce(new DOMException('play blocked', 'NotAllowedError'))
      .mockResolvedValue(undefined)
    const { video } = renderVideo()

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))

    // canplay が来るまでは再試行しない
    expect(play).toHaveBeenCalledTimes(1)
    fireEvent(video, new Event('canplay'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-play-retry]')).toBeNull(),
    )
  })

  it('再試行も失敗したら中央に再生ボタンを出し、押すと再生する', async () => {
    play.mockRejectedValue(new Error('play blocked'))
    const { video } = renderVideo()

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    fireEvent(video, new Event('canplay'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))

    const retry = await screen.findByRole('button', { name: '再生' })
    expect(document.querySelector('[data-lightbox-play-retry]')).not.toBeNull()

    play.mockResolvedValueOnce(undefined)
    fireEvent.click(retry)
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-play-retry]')).toBeNull(),
    )
    expect(play).toHaveBeenCalledTimes(3)
  })
})

describe('#26 シーク不可の分岐', () => {
  it('seekable が空ならシークバーを無効化し、理由を出す', async () => {
    const { container, video } = renderVideo()
    Object.defineProperty(video, 'seekable', { configurable: true, value: ranges(0) })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    fireEvent(video, new Event('loadedmetadata'))

    await waitFor(() => expect(screen.getByLabelText('再生位置')).toBeDisabled())
    expect(document.querySelector('[data-lightbox-seek-disabled]')?.textContent).toContain(
      'この動画はシークできません',
    )
    // シーク不可ならスクラブプレビュー用の <video> も作らない
    expect(container.querySelector('video[data-scrub-preview-video]')).toBeNull()
  })

  it('seekable があればシークバーは有効のまま', async () => {
    const { video } = renderVideo()
    Object.defineProperty(video, 'seekable', { configurable: true, value: ranges(1, 120) })
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() => expect(screen.getByLabelText('再生位置')).not.toBeDisabled())
    expect(document.querySelector('[data-lightbox-seek-disabled]')).toBeNull()
  })
})

describe('#26 形式非対応', () => {
  it('error で理由とエラーコードを残し、外部プレイヤーで開ける', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { video } = renderVideo()
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 })
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 })
    Object.defineProperty(video, 'error', {
      configurable: true,
      value: { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' } as MediaError,
    })

    fireEvent(video, new Event('error'))

    expect(screen.getByText('この形式は再生できません')).toBeInTheDocument()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('動画を読み込めませんでした'),
      expect.objectContaining({
        width: 1920,
        height: 1080,
        errorCode: 4,
        codec: expect.stringContaining('H.264'),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: '外部プレイヤーで開く' }))
    await waitFor(() => expect(api.openFile).toHaveBeenCalledWith(7))
  })
})
