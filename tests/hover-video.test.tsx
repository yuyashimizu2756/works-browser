import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import {
  HOVER_VIDEO_DELAY_MS,
  HOVER_VIDEO_DURATION_MS,
  useHoverVideoPreview,
} from '../src/library/useHoverVideoPreview'

// mediaSrc は Tauri の内側でしか URL を作れないので、テストでは固定の URL を返す
vi.mock('../src/library/mediaSrc', () => ({
  mediaSrc: (fileId: number | null | undefined) =>
    fileId === null || fileId === undefined ? null : `wbm://localhost/${fileId}`,
}))

function Harness({ fileId, enabled }: { fileId: number; enabled: boolean }) {
  const preview = useHoverVideoPreview(fileId, enabled)
  return (
    <div>
      <span
        data-testid={`thumb-${fileId}`}
        onPointerEnter={preview.startPreview}
        onPointerLeave={preview.stopPreview}
      >
        <span ref={preview.videoHostRef} data-testid={`video-host-${fileId}`} />
      </span>
      <span data-testid={`playing-${fileId}`}>{preview.playing ? 'yes' : 'no'}</span>
    </div>
  )
}

function hover(fileId: number) {
  fireEvent.pointerEnter(screen.getByTestId(`thumb-${fileId}`))
}

describe('useHoverVideoPreview', () => {
  let playSpy: MockInstance
  let pauseSpy: MockInstance
  let loadSpy: MockInstance

  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom の HTMLMediaElement は実装されていないので、呼び出しだけ記録する
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  })

  afterEach(() => {
    // フックの後始末（load など）がモックの生きているうちに走るようにする
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('600ms ホバーで再生を始め、ミュート・preload=none を守る', () => {
    render(<Harness fileId={1} enabled />)

    hover(1)
    expect(document.querySelector('video')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS - 1)
    })
    expect(playSpy).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(playSpy).toHaveBeenCalledTimes(1)

    const video = document.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toContain('/1')
    expect(video?.muted).toBe(true)
    expect(video?.preload).toBe('none')
    expect(video?.playsInline).toBe(true)
    expect(screen.getByTestId('playing-1')).toHaveTextContent('yes')
  })

  it('10% 地点から再生する', () => {
    render(<Harness fileId={1} enabled />)
    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS)
    })

    const video = document.querySelector('video')!
    Object.defineProperty(video, 'duration', { value: 40, configurable: true })
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'))
    })

    expect(video.currentTime).toBeCloseTo(4)
  })

  it('5 秒後に停止し、src を取り外して解放する', () => {
    render(<Harness fileId={1} enabled />)
    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS)
    })
    const video = document.querySelector('video')!

    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DURATION_MS)
    })

    expect(pauseSpy).toHaveBeenCalled()
    expect(loadSpy).toHaveBeenCalled()
    expect(video.hasAttribute('src')).toBe(false)
    expect(video.isConnected).toBe(false)
    expect(document.querySelector('video')).toBeNull()
    expect(screen.getByTestId('playing-1')).toHaveTextContent('no')
  })

  it('マウスが外れたら即停止する', () => {
    render(<Harness fileId={1} enabled />)
    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS)
    })
    const video = document.querySelector('video')!

    fireEvent.pointerLeave(screen.getByTestId('thumb-1'))

    expect(pauseSpy).toHaveBeenCalled()
    expect(video.hasAttribute('src')).toBe(false)
    expect(document.querySelector('video')).toBeNull()
  })

  it('動画要素は 1 つだけ使い回す（同時再生しない）', () => {
    render(
      <>
        <Harness fileId={1} enabled />
        <Harness fileId={2} enabled />
      </>,
    )

    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS)
    })
    const first = document.querySelector('video')!
    expect(document.querySelectorAll('video')).toHaveLength(1)
    expect(first.getAttribute('src')).toContain('/1')

    hover(2)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS)
    })

    expect(document.querySelectorAll('video')).toHaveLength(1)
    const second = document.querySelector('video')!
    expect(second).toBe(first)
    expect(second.getAttribute('src')).toContain('/2')
    expect(pauseSpy).toHaveBeenCalled()
    expect(screen.getByTestId('playing-1')).toHaveTextContent('no')
    expect(screen.getByTestId('playing-2')).toHaveTextContent('yes')
  })

  it('サムネ非表示では動画要素を作らない', () => {
    render(<Harness fileId={1} enabled={false} />)

    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS * 2)
    })

    expect(playSpy).not.toHaveBeenCalled()
    expect(document.querySelector('video')).toBeNull()
    expect(screen.getByTestId('playing-1')).toHaveTextContent('no')
  })

  it('prefers-reduced-motion: reduce では再生しない', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })),
    )
    render(<Harness fileId={1} enabled />)

    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS * 2)
    })

    expect(playSpy).not.toHaveBeenCalled()
    expect(document.querySelector('video')).toBeNull()
  })

  it('再生に失敗したらサムネイルのまま（動画を出さない）', async () => {
    playSpy.mockImplementation(() => Promise.reject(new Error('unsupported')))
    render(<Harness fileId={1} enabled />)

    hover(1)
    act(() => {
      vi.advanceTimersByTime(HOVER_VIDEO_DELAY_MS)
    })
    // play() の reject を処理させる
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.querySelector('video')).toBeNull()
    expect(screen.getByTestId('playing-1')).toHaveTextContent('no')
  })
})
