import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  SCRUB_PREVIEW_DELAY_MS,
  createScrubSeeker,
  scrubPreviewPosition,
  scrubSecondsAt,
} from '../src/library/scrubPreview'
import { Lightbox } from '../src/library/Lightbox'
import { makeFile } from './fixtures'

// 実フレーム抽出は jsdom では検証できない（canvas が無い）ので、
// 「要求が届いたらフレームを返す」ところだけ差し替える。
vi.mock('../src/library/scrubPreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/library/scrubPreview')>()
  return {
    ...actual,
    captureScrubFrame: vi.fn(() => ({
      src: 'data:image/webp;base64,AAAA',
      width: 160,
      height: 90,
    })),
  }
})

vi.mock('../src/api', () => ({
  api: {
    getFilePosition: vi.fn(async () => null),
    saveFilePosition: vi.fn(async () => undefined),
  },
}))

/** jsdom の `<video>` は再生できないので、play / pause だけスタブする。 */
const originalPlay = HTMLMediaElement.prototype.play
const originalPause = HTMLMediaElement.prototype.pause

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
  HTMLMediaElement.prototype.pause = vi.fn()
})

afterAll(() => {
  HTMLMediaElement.prototype.play = originalPlay
  HTMLMediaElement.prototype.pause = originalPause
})

afterEach(() => {
  vi.useRealTimers()
})

function stubRect(element: Element, rect: Partial<DOMRect>) {
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    }) as DOMRect
}

/** 動画 1 件だけのライトボックスを開き、長さ 120 秒としてメタデータを読ませる。 */
function renderVideoLightbox() {
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
  const mainVideo = view.container.querySelector(
    'video:not([data-scrub-preview-video])',
  ) as HTMLVideoElement
  Object.defineProperty(mainVideo, 'duration', { configurable: true, value: 120 })
  fireEvent(mainVideo, new Event('loadedmetadata'))
  return { ...view, file }
}

describe('scrubSecondsAt（clientX → 秒）', () => {
  const rect = { left: 100, width: 1000 }

  it('0% / 50% / 100% を秒に変換する', () => {
    expect(scrubSecondsAt(100, rect, 120)).toBe(0)
    expect(scrubSecondsAt(600, rect, 120)).toBe(60)
    expect(scrubSecondsAt(1100, rect, 120)).toBe(120)
  })

  it('範囲外は 0〜duration に丸める', () => {
    expect(scrubSecondsAt(-500, rect, 120)).toBe(0)
    expect(scrubSecondsAt(9999, rect, 120)).toBe(120)
  })

  it('長さや幅が無いときは 0', () => {
    expect(scrubSecondsAt(600, rect, 0)).toBe(0)
    expect(scrubSecondsAt(600, { left: 100, width: 0 }, 120)).toBe(0)
  })
})

describe('createScrubSeeker（150ms デバウンス）', () => {
  it('150ms 待ってから最新の要求だけを seek する', () => {
    vi.useFakeTimers()
    const seek = vi.fn()
    const seeker = createScrubSeeker(seek)

    seeker.request(10)
    vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS - 1)
    expect(seek).not.toHaveBeenCalled()

    seeker.request(20)
    vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS - 1)
    expect(seek).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(seek).toHaveBeenCalledTimes(1)
    expect(seek).toHaveBeenLastCalledWith(20, 2)
  })

  it('古い要求の seeked は最新でないので捨てられる', () => {
    vi.useFakeTimers()
    const seek = vi.fn()
    const seeker = createScrubSeeker(seek)

    seeker.request(10)
    vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS)
    const oldToken = seek.mock.calls[0][1]
    expect(seeker.isCurrent(oldToken)).toBe(true)

    // 古い seek の seeked が届く前に新しい要求が来た
    seeker.request(20)
    expect(seeker.isCurrent(oldToken)).toBe(false)

    vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS)
    expect(seek).toHaveBeenCalledTimes(2)
    expect(seeker.isCurrent(seek.mock.calls[1][1])).toBe(true)
  })

  it('cancel 後は seek せず、進行中の seek も無効になる', () => {
    vi.useFakeTimers()
    const seek = vi.fn()
    const seeker = createScrubSeeker(seek)

    seeker.request(10)
    vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS)
    const token = seek.mock.calls[0][1]

    seeker.cancel()
    expect(seeker.isCurrent(token)).toBe(false)

    seeker.request(30)
    seeker.cancel()
    vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS * 2)
    expect(seek).toHaveBeenCalledTimes(1)
  })
})

describe('scrubPreviewPosition（画面端で反転）', () => {
  const size = { width: 160, height: 112 }
  const viewport = { width: 1000, height: 800 }

  it('通常はカーソルの右に出し、右端では左へ反転する', () => {
    expect(scrubPreviewPosition(200, 400, size, viewport).left).toBe(212)
    const flipped = scrubPreviewPosition(950, 400, size, viewport)
    expect(flipped.left).toBeLessThan(950)
    expect(flipped.left + size.width).toBeLessThanOrEqual(viewport.width)
  })
})

describe('Lightbox のスクラブプレビュー', () => {
  it('プレビュー用の <video> は 1 つだけ（本体とは別要素）', () => {
    const { container } = renderVideoLightbox()
    const previews = container.querySelectorAll('video[data-scrub-preview-video]')
    expect(previews).toHaveLength(1)
    expect(container.querySelectorAll('video')).toHaveLength(2)

    const previewVideo = previews[0] as HTMLVideoElement
    expect(previewVideo.muted).toBe(true)
    expect(previewVideo.preload).toBe('metadata')
    expect(previewVideo).toHaveClass('hidden')
    // #25: canvas を taint させない（`wbm` は ACAO: * を返す）
    expect(previewVideo.crossOrigin).toBe('anonymous')
    expect(previewVideo.getAttribute('crossorigin')).toBe('anonymous')
    // 本体の動画とは別要素であること
    expect(previewVideo).not.toBe(container.querySelector('video:not([data-scrub-preview-video])'))
  })

  it('シークバー上で止めるとフレームと時刻を出し、pointerleave で消える', () => {
    vi.useFakeTimers()
    const { container } = renderVideoLightbox()

    const slider = screen.getByLabelText('再生位置')
    stubRect(slider, { left: 100, top: 100, width: 1000, height: 6 })

    const previewVideo = container.querySelector(
      'video[data-scrub-preview-video]',
    ) as HTMLVideoElement

    expect(container.querySelector('[data-scrub-preview]')).toBeNull()

    fireEvent.pointerMove(slider, { clientX: 600, clientY: 300 })
    act(() => {
      vi.advanceTimersByTime(SCRUB_PREVIEW_DELAY_MS)
    })
    // プレビュー video の seek が終わったらフレームを描く
    fireEvent(previewVideo, new Event('seeked'))

    const preview = container.querySelector('[data-scrub-preview]')
    expect(preview).not.toBeNull()
    expect(preview?.querySelector('[data-scrub-preview-image]')).not.toBeNull()
    expect(preview?.textContent).toContain('1:00')
    // 本体の再生位置には触れない
    const mainVideo = container.querySelector(
      'video:not([data-scrub-preview-video])',
    ) as HTMLVideoElement
    expect(mainVideo.currentTime).toBe(0)

    // マウスが外れたら消える
    fireEvent.pointerOut(slider, { relatedTarget: document.body })
    expect(container.querySelector('[data-scrub-preview]')).toBeNull()
  })
})
