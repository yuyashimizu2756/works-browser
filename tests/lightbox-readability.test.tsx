/**
 * #15: ライトボックスの可読性。
 *
 * - 未評価の星は黒背景でコントラスト 4.5:1 以上（`white/60` = 7.37:1）
 * - 動画のキー案内（Space / ←→ / Shift+←→ / Esc）を出す（画像はズーム案内のまま）
 * - 通知は 1 本のキューで、同時に出ても 1 行（高さが変わらない）
 * - スライドショーのボタンは下部バーに 1 つだけ
 * - 位置（N / 全体）は幅 800 でも残し、サイズ・日付だけ省く
 */
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Lightbox } from '../src/library/Lightbox'
import { emptyMark, setTagData } from '../src/library/tagData'
import type { TagData } from '../src/library/tagData'
import { makeFile } from './fixtures'

function memoryTagData(): TagData {
  return {
    listTags: async () => [],
    createTag: async (name, color) => ({ id: 1, name, color, created_at: 0, works: 0 }),
    deleteTag: async () => {},
    getWorkTags: async () => [],
    setWorkTags: async () => [],
    tagSuggestions: async () => [],
    getWorkMark: async (workId) => emptyMark(workId),
    setWorkMark: async (workId, mark) => ({ ...emptyMark(workId), ...mark }),
    recordOpen: async (workId) => emptyMark(workId),
  }
}

/** WCAG 2.1 の相対輝度コントラスト比。 */
function luminance([r, g, b]: [number, number, number]): number {
  const linear = (value: number) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

function renderLightbox(kind: 'image' | 'video' = 'video') {
  const props = {
    files: [
      makeFile({
        id: kind === 'video' ? 21 : 11,
        kind,
        name: kind === 'video' ? 'v.mp4' : 'a.png',
        duration_ms: kind === 'video' ? 10_000 : null,
      }),
    ],
    index: 0,
    hasMore: false,
    loadingMore: false,
    onRequestMore: vi.fn(),
    onIndexChange: vi.fn(),
    onClose: vi.fn(),
    bench: false,
    workId: 7,
    rootRealPath: null,
  }
  render(<Lightbox {...props} />)
  return props
}

beforeEach(() => {
  setTagData(memoryTagData())
  vi.stubGlobal('HTMLMediaElement', window.HTMLMediaElement)
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  setTagData(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#15 ライトボックスの可読性', () => {
  it('未評価の星は white/60（黒背景で 7.37:1）を使う', () => {
    renderLightbox('image')
    const star = document.querySelector('[data-rating-value="1"]') as HTMLElement
    expect(star.className).toContain('text-white/60')
    // `white/60` を黒背景に合成した値（153,153,153）は 4.5:1 を超える
    const composited: [number, number, number] = [153, 153, 153]
    const ratio = contrast(composited, [0, 0, 0])
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(Number(ratio.toFixed(2))).toBe(7.37)
  })

  it('動画はキー案内を出し、画像はズーム案内のまま', () => {
    const { unmount } = render(
      <Lightbox
        files={[makeFile({ id: 21, kind: 'video', name: 'v.mp4', duration_ms: 10_000 })]}
        index={0}
        hasMore={false}
        loadingMore={false}
        onRequestMore={vi.fn()}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
        bench={false}
      />,
    )
    const hint = document.querySelector('[data-lightbox-key-hint]')
    expect(hint?.textContent).toBe(
      'Space 再生 / ←→ ±5秒 / Shift+←→ 前後 / Esc 閉じる',
    )
    unmount()

    renderLightbox('image')
    expect(document.querySelector('[data-lightbox-key-hint]')).toBeNull()
    expect(document.body.textContent).toContain('ホイールでズーム / 0 で原寸 / F で全画面')
  })

  it('通知は 1 本のキューで、音声と操作が重なっても 1 行だけ', async () => {
    vi.useFakeTimers()
    renderLightbox('video')

    // 音声の通知 → スライドショーの通知を続けて出す
    fireEvent.click(document.querySelector('[data-lightbox-mute]') as HTMLElement)
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })

    const notices = document.querySelectorAll('[data-lightbox-notice]')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toHaveAttribute('data-lightbox-notice-tone', 'audio')

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    const next = document.querySelectorAll('[data-lightbox-notice]')
    expect(next).toHaveLength(1)
    expect(next[0]).toHaveAttribute('data-lightbox-notice-tone', 'info')
    expect(next[0]?.textContent).toContain('スライドショーを開始しました')
  })

  it('スライドショーのボタンは下部バーに 1 つだけ', () => {
    renderLightbox('video')
    expect(document.querySelectorAll('[data-lightbox-slideshow-bar]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-lightbox-slideshow]')).toHaveLength(0)
    expect(document.querySelectorAll('[aria-label*="スライドショー"]')).toHaveLength(1)
  })

  it('位置（N / 全体）は常に表示し、サイズ・日付だけ広い画面に出す', () => {
    renderLightbox('image')
    const position = document.querySelector('[data-lightbox-position]') as HTMLElement
    expect(position.textContent).toContain('1 / 1')
    expect(position.className).not.toContain('hidden')

    const meta = document.querySelector('[data-lightbox-file-meta]') as HTMLElement
    expect(meta.className).toContain('hidden')
    expect(meta.className).toContain('xl:flex')
  })
})
