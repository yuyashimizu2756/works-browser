/**
 * #32: 起動後 1 本目の動画が再生されない問題の診断 UI。
 *
 * - `play()` の reject 名 / message と現在値をバナーに出す
 * - 同じ内容を `playback_log`（Rust）へ 1 行で渡す
 * - 「診断情報をコピー」でクリップボードへ
 * - focus / pointerdown で、再生要求が残っているときだけ再試行する
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    playbackLog: vi.fn(async () => undefined),
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

let play: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play')
  play.mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  delete (navigator as unknown as { clipboard?: unknown }).clipboard
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('#32 再生失敗のバナーとログ', () => {
  it('play() の reject 名・message・現在値をバナーに出し、ログへ 1 行渡す', async () => {
    play.mockRejectedValue(new DOMException('play blocked', 'NotAllowedError'))
    const { video } = renderVideo()
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    Object.defineProperty(video, 'networkState', { configurable: true, value: 2 })

    fireEvent(video, new Event('loadedmetadata'))

    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-playback-diagnostic]')).not.toBeNull(),
    )
    const banner = document.querySelector('[data-lightbox-playback-diagnostic]')!
    expect(banner.textContent).toContain('再生を開始できませんでした')
    expect(banner.textContent).toContain('NotAllowedError')
    expect(banner.textContent).toContain('play blocked')
    expect(banner.textContent).toContain('readyState 1')
    expect(banner.textContent).toContain('networkState 2')
    expect(banner.textContent).toContain('error.code null')
    expect(banner.textContent).toContain('muted true')
    expect(banner.textContent).toContain('volume 0.00')
    expect(banner.textContent).toContain('paused true')

    await waitFor(() => expect(api.playbackLog).toHaveBeenCalled())
    const line = vi.mocked(api.playbackLog).mock.calls[0][0]
    expect(line).toContain('event=play-reject')
    expect(line).toContain('fileId=7')
    expect(line).toContain('file="clip.mp4"')
    expect(line).toContain('playName=NotAllowedError')
    expect(line).toContain('playMessage="play blocked"')
    expect(line).toContain('readyState=1')
    expect(line).toContain('networkState=2')
    expect(line).toContain('muted=true')
    expect(line).toContain('volume=0.00')
    expect(line).toContain('paused=true')
    expect(line).toContain('userActivation=')
    expect(line).toContain('hasFocus=')
  })

  it('「診断情報をコピー」でクリップボードへ複数行の診断を渡す', async () => {
    play.mockRejectedValue(new DOMException('play blocked', 'NotAllowedError'))
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { video } = renderVideo()
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-playback-diagnostic]')).not.toBeNull(),
    )

    fireEvent.click(document.querySelector('[data-lightbox-diagnostic-copy]')!)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const text = writeText.mock.calls[0][0]
    expect(text).toContain('play(): NotAllowedError — play blocked')
    expect(text).toContain('readyState: 1')
    expect(text).toContain('muted: true')
    expect(await screen.findByText('診断情報をコピーしました')).toBeInTheDocument()
  })
})

describe('#32 再生要求が残っているときの再試行', () => {
  it('window の focus で、失敗した再生をもう一度だけ試す', async () => {
    play
      .mockRejectedValueOnce(new DOMException('play blocked', 'NotAllowedError'))
      .mockResolvedValue(undefined)
    const { video } = renderVideo()
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-playback-diagnostic]')).not.toBeNull(),
    )

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-playback-diagnostic]')).toBeNull(),
    )
  })

  it('ユーザーが一時停止したあとは focus で勝手に再開しない', async () => {
    play.mockRejectedValue(new DOMException('play blocked', 'NotAllowedError'))
    const { video } = renderVideo()
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-playback-diagnostic]')).not.toBeNull(),
    )

    // 明示的な一時停止（再生要求を捨てる）
    fireEvent(video, new Event('pause'))
    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('pointerdown'))
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 60))
    })
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('再試行も失敗したら中央の再生ボタンを出し、診断は残す', async () => {
    play.mockRejectedValue(new DOMException('still blocked', 'NotAllowedError'))
    const { video } = renderVideo()
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })

    fireEvent(video, new Event('loadedmetadata'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
    fireEvent(video, new Event('canplay'))
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2))

    expect(screen.getByRole('button', { name: '再生' })).toBeInTheDocument()
    const banner = document.querySelector('[data-lightbox-playback-diagnostic]')
    expect(banner?.textContent).toContain('still blocked')
  })
})
