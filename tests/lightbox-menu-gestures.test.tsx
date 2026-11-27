/**
 * #16: `⋯` メニューの閉じ方（Esc / 外側クリック）とフォーカス、タグ入力中のキー。
 *
 * レビュー指摘:
 * - メニューの Esc・外側クリックでフォーカスが戻ることが未検証だった
 * - タグ入力中に `t` / `1` がライトボックスのショートカットとして発火しないことが未検証だった
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag, WorkMark } from '../src/api'
import { Lightbox } from '../src/library/Lightbox'
import { emptyMark, setTagData } from '../src/library/tagData'
import type { TagData } from '../src/library/tagData'
import { makeFile } from './fixtures'

function createFakeTagData() {
  const marks = new Map<number, WorkMark>()
  const tags: Tag[] = [{ id: 1, name: '猫', color: '#22d3ee', created_at: 0, works: 0 }]
  const saved: { favorite: boolean; rating: number | null; note?: string | null }[] = []
  const data: TagData = {
    listTags: async () => tags,
    createTag: async (name, color) => {
      const tag: Tag = { id: tags.length + 1, name, color, created_at: 0, works: 0 }
      tags.push(tag)
      return tag
    },
    deleteTag: async () => {},
    getWorkTags: async () => [],
    setWorkTags: async () => [],
    tagSuggestions: async () => [],
    getWorkMark: async (workId) => marks.get(workId) ?? emptyMark(workId),
    setWorkMark: async (workId, mark) => {
      saved.push(mark)
      const next: WorkMark = { ...emptyMark(workId), ...mark }
      marks.set(workId, next)
      return next
    },
    recordOpen: async (workId) => marks.get(workId) ?? emptyMark(workId),
  }
  return { data, saved }
}

function renderLightbox(overrides: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const props = {
    files: [makeFile({ id: 11, name: 'a.png' }), makeFile({ id: 12, name: 'b.png' })],
    index: 0,
    hasMore: false,
    loadingMore: false,
    onRequestMore: vi.fn(),
    onIndexChange: vi.fn(),
    onClose: vi.fn(),
    bench: false,
    workId: 7,
    rootRealPath: 'D:\\Works\\root-1',
    ...overrides,
  }
  render(<Lightbox {...props} />)
  return props
}

beforeEach(() => {
  setTagData(createFakeTagData().data)
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  setTagData(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#16 `⋯` メニューの閉じ方', () => {
  it('Esc でメニューだけ閉じ、開いたボタンへフォーカスが戻る', async () => {
    const props = renderLightbox()
    const trigger = screen.getByLabelText('その他の操作')
    fireEvent.click(trigger)
    await waitFor(() => expect(document.querySelector('[data-lightbox-menu]')).not.toBeNull())

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })

    await waitFor(() => expect(document.querySelector('[data-lightbox-menu]')).toBeNull())
    // ライトボックス自体は閉じない（1 段だけ閉じる）
    expect(props.onClose).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('外側クリックでメニューを閉じ、フォーカスが開いたボタンへ戻る', async () => {
    renderLightbox()
    const trigger = screen.getByLabelText('その他の操作')
    fireEvent.click(trigger)
    await waitFor(() => expect(document.querySelector('[data-lightbox-menu]')).not.toBeNull())

    // メディア本体（メニューの外側）を押す
    fireEvent.pointerDown(document.querySelector('[data-lightbox-topbar]') as HTMLElement)

    await waitFor(() => expect(document.querySelector('[data-lightbox-menu]')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('メニュー内のクリックでは閉じない（メニューの外側だけ）', async () => {
    renderLightbox()
    fireEvent.click(screen.getByLabelText('その他の操作'))
    const menu = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-lightbox-menu]')
      expect(found).not.toBeNull()
      return found!
    })
    fireEvent.pointerDown(menu)
    expect(document.querySelector('[data-lightbox-menu]')).not.toBeNull()
  })
})

describe('#16 タグ入力中のキー', () => {
  it('タグ名の入力中は t / 1 がライトボックスの操作にならない', async () => {
    renderLightbox()
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
        'data-lightbox-marks-loaded',
        'true',
      ),
    )

    fireEvent.keyDown(window, { key: 't', code: 'KeyT' })
    const input = await waitFor(() => {
      const found = document.querySelector<HTMLInputElement>('[data-tag-name]')
      expect(found).not.toBeNull()
      return found!
    })
    input.focus()
    expect(document.activeElement).toBe(input)

    // 入力中の `1` は評価に、`t` はタグ（メニュー等）に使われない
    fireEvent.keyDown(input, { key: '1', code: 'Digit1' })
    fireEvent.keyDown(input, { key: 't', code: 'KeyT' })

    expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
      'data-lightbox-rating',
      '',
    )
    expect(document.querySelector('[data-lightbox-menu]')).toBeNull()
    expect(document.querySelector('[data-tag-editor]')).not.toBeNull()
    // フォーカスは入力欄に残る（ライトボックスのキー処理に奪われない）
    expect(document.activeElement).toBe(input)
  })
})

describe('#16 スライドショーの終端', () => {
  it('読み込み切った終端では止まる（次を要求しない）', async () => {
    vi.useFakeTimers()
    const props = renderLightbox({ index: 1 })
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    expect(document.querySelector('[data-lightbox]')).toHaveAttribute('data-slideshow', 'true')

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(document.querySelector('[data-lightbox]')).toHaveAttribute('data-slideshow', 'false')
    expect(props.onIndexChange).not.toHaveBeenCalled()
    expect(props.onRequestMore).not.toHaveBeenCalled()
  })

  it('hasMore の終端では追加読み込みし、止まらない', async () => {
    vi.useFakeTimers()
    const props = renderLightbox({ index: 1, hasMore: true })
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    const before = props.onRequestMore.mock.calls.length

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(props.onRequestMore.mock.calls.length).toBe(before + 1)
    expect(props.onIndexChange).not.toHaveBeenCalled()
    expect(document.querySelector('[data-lightbox]')).toHaveAttribute('data-slideshow', 'true')
  })

  it('追加読み込み中は要求も送りもしない（待つ）', async () => {
    vi.useFakeTimers()
    const props = renderLightbox({ index: 1, hasMore: true, loadingMore: true })
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    const before = props.onRequestMore.mock.calls.length

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(props.onRequestMore.mock.calls.length).toBe(before)
    expect(props.onIndexChange).not.toHaveBeenCalled()
    expect(document.querySelector('[data-lightbox]')).toHaveAttribute('data-slideshow', 'true')
  })

  it('動画の再生完了で次のファイルへ送る', async () => {
    const props = renderLightbox({
      files: [
        makeFile({ id: 31, kind: 'video', name: 'v.mp4', duration_ms: 10_000 }),
        makeFile({ id: 32, name: 'b.png' }),
      ],
      index: 0,
    })
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    const video = document.querySelector<HTMLVideoElement>(
      'video:not([data-scrub-preview-video])',
    )!
    fireEvent(video, new Event('ended'))

    expect(props.onIndexChange).toHaveBeenCalledWith(1)
    expect(props.onRequestMore).not.toHaveBeenCalled()
  })

  it('動画が最後なら再生完了で停止する', async () => {
    const props = renderLightbox({
      files: [
        makeFile({ id: 41, name: 'a.png' }),
        makeFile({ id: 42, kind: 'video', name: 'v.mp4', duration_ms: 10_000 }),
      ],
      index: 1,
    })
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    const video = document.querySelector<HTMLVideoElement>(
      'video:not([data-scrub-preview-video])',
    )!
    fireEvent(video, new Event('ended'))

    expect(props.onIndexChange).not.toHaveBeenCalled()
    expect(document.querySelector('[data-lightbox]')).toHaveAttribute('data-slideshow', 'false')
  })
})
