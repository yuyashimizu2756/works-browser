/**
 * #8: ライトボックスからの操作（お気に入り・評価・タグ・メタ・スライドショー・メニュー）。
 *
 * ライトボックスを直接描画し、キーボードと上部バーの両方から
 * 「作品単位のマークが保存される」「既存キーと衝突しない」ことを確認する。
 * #10 の音量は同じファイルで `<video>` の実プロパティまで確認する。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag, WorkMark } from '../src/api'
import { Lightbox } from '../src/library/Lightbox'
import { emptyMark, setTagData } from '../src/library/tagData'
import type { TagData } from '../src/library/tagData'
import { matchesShortcut, shortcutKeys } from '../src/lib/shortcuts'
import { makeFile } from './fixtures'

const MARK_CHANGED = 'works-browser:mark-changed'

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
  return { data, marks, saved, tags }
}

function renderLightbox(overrides: Partial<Parameters<typeof Lightbox>[0]> = {}) {
  const files = overrides.files ?? [makeFile({ id: 11, name: 'a.png' }), makeFile({ id: 12 })]
  const props = {
    files,
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
  vi.stubGlobal('HTMLMediaElement', window.HTMLMediaElement)
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
})

afterEach(() => {
  setTagData(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('#8 上部バーとキーボード', () => {
  it('新しいキーがショートカット定義にあり、既存キーと重ならない', () => {
    expect(shortcutKeys('detail-favorite')).toBe('Shift+F')
    expect(shortcutKeys('detail-rate')).toBe('1〜5')
    expect(shortcutKeys('detail-unrated')).toBe('Shift+0')
    expect(shortcutKeys('detail-tags')).toBe('T')
    expect(shortcutKeys('detail-meta')).toBe('I')
    expect(shortcutKeys('detail-slideshow')).toBe('S')

    expect(
      matchesShortcut('detail-favorite', { key: 'F', shiftKey: true }),
    ).toBe(true)
    // `F` 単独は全画面のまま（お気に入りにはならない）
    expect(matchesShortcut('detail-favorite', { key: 'F' })).toBe(false)
    // 評価の 1〜5 は Shift 付きでは反応しない
    expect(matchesShortcut('detail-rate', { key: '3' })).toBe(true)
    expect(matchesShortcut('detail-rate', { key: '3', shiftKey: true })).toBe(false)
    // `0`（原寸 / 先頭）は未評価に使わない
    expect(matchesShortcut('detail-unrated', { key: '0' })).toBe(false)
    expect(matchesShortcut('detail-unrated', { code: 'Digit0', shiftKey: true })).toBe(true)
  })

  it('Shift+F でお気に入り、1〜5 と Shift+0 で評価が保存される', async () => {
    const fake = createFakeTagData()
    setTagData(fake.data)
    const changed = vi.fn()
    window.addEventListener(MARK_CHANGED, changed)
    renderLightbox()

    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
        'data-lightbox-favorite',
        'false',
      ),
    )
    // #13: マークの読み込みが終わるまでは操作できない
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
        'data-lightbox-marks-loaded',
        'true',
      ),
    )

    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', shiftKey: true })
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
        'data-lightbox-favorite',
        'true',
      ),
    )
    expect(fake.saved.at(-1)).toMatchObject({ favorite: true })

    fireEvent.keyDown(window, { key: '3', code: 'Digit3' })
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
        'data-lightbox-rating',
        '3',
      ),
    )

    fireEvent.keyDown(window, { key: '0', code: 'Digit0', shiftKey: true })
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-marks]')).toHaveAttribute(
        'data-lightbox-rating',
        '',
      ),
    )
    expect(changed).toHaveBeenCalled()
    window.removeEventListener(MARK_CHANGED, changed)
  })

  it('T で既存の TagEditor が開き、I でメタ情報パネルがトグルする', async () => {
    renderLightbox()
    fireEvent.keyDown(window, { key: 't', code: 'KeyT' })
    await waitFor(() => expect(document.querySelector('[data-tag-editor]')).not.toBeNull())

    // タグ編集が開いている間の Esc はライトボックスを閉じない
    const onClose = vi.fn()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-tag-editor]')).toBeNull())

    expect(document.querySelector('[data-meta-panel]')).toBeNull()
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI' })
    await waitFor(() => expect(document.querySelector('[data-meta-panel]')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'i', code: 'KeyI' })
    await waitFor(() => expect(document.querySelector('[data-meta-panel]')).toBeNull())
  })

  it('S でスライドショーが始まり、3 秒で次のファイルへ送る', async () => {
    vi.useFakeTimers()
    const props = renderLightbox()
    fireEvent.keyDown(window, { key: 's', code: 'KeyS' })
    expect(document.querySelector('[data-lightbox]')).toHaveAttribute('data-slideshow', 'true')

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(props.onIndexChange).toHaveBeenCalledWith(1)
  })

  it('⋯ メニューからパスをコピーし、ゴミ箱へは既存フローへ渡す', async () => {
    const onDeleteFile = vi.fn()
    const file = makeFile({ id: 11, rel_path: 'work-1/001.png' })
    renderLightbox({ files: [file], onDeleteFile })

    fireEvent.click(screen.getByLabelText('その他の操作'))
    await waitFor(() => expect(document.querySelector('[data-lightbox-menu]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-lightbox-copy-path]') as HTMLElement)
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('D:\\Works\\root-1\\work-1\\001.png'),
    )

    fireEvent.click(screen.getByLabelText('その他の操作'))
    fireEvent.click(document.querySelector('[data-lightbox-trash]') as HTMLElement)
    expect(onDeleteFile).toHaveBeenCalledWith(file)
  })
})

describe('#10 音量・ミュート', () => {
  it('解除で音量 0.6 になり、遅れて届いた loadedmetadata でも戻らない', async () => {
    const props = renderLightbox({
      files: [makeFile({ id: 21, kind: 'video', name: 'v.mp4', duration_ms: 10_000 })],
      index: 0,
    })
    expect(props.workId).toBe(7)

    const video = document.querySelector<HTMLVideoElement>(
      'video:not([data-scrub-preview-video])',
    )!
    expect(video).not.toBeNull()
    // 既定はミュート・音量 0
    expect(video.muted).toBe(true)
    expect(video.volume).toBe(0)
    expect(video.dataset.videoMuted).toBe('true')
    expect(video.dataset.videoVolume).toBe('0.00')

    fireEvent.click(screen.getByLabelText('ミュート解除'))
    await waitFor(() => expect(video.muted).toBe(false))
    expect(video.volume).toBeCloseTo(0.6, 5)
    expect(video.dataset.videoMuted).toBe('false')
    expect(video.dataset.videoVolume).toBe('0.60')

    // メタデータが解除より後に届いても、古いミュートを再適用しない
    fireEvent(video, new Event('loadedmetadata'))
    expect(video.muted).toBe(false)
    expect(video.volume).toBeCloseTo(0.6, 5)
  })

  it('音量スライダーを 0 にするとミュートに戻る', async () => {
    renderLightbox({
      files: [makeFile({ id: 22, kind: 'video', name: 'v2.mp4', duration_ms: 10_000 })],
    })
    const video = document.querySelector<HTMLVideoElement>(
      'video:not([data-scrub-preview-video])',
    )!
    const slider = screen.getByLabelText('音量')
    fireEvent.change(slider, { target: { value: '0.35' } })
    await waitFor(() => expect(video.muted).toBe(false))
    expect(video.volume).toBeCloseTo(0.35, 5)

    fireEvent.change(slider, { target: { value: '0' } })
    await waitFor(() => expect(video.muted).toBe(true))
    expect(video.volume).toBe(0)
  })
})

describe('#12 解除時の音声再初期化', () => {
  function mediaVideo(): HTMLVideoElement {
    return document.querySelector<HTMLVideoElement>('video:not([data-scrub-preview-video])')!
  }

  const videoFile = (id: number) =>
    makeFile({ id, kind: 'video', name: `v${id}.mp4`, duration_ms: 10_000 })

  it('再生中の解除で play() を再実行し、位置と速度を保持する', async () => {
    renderLightbox({ files: [videoFile(31)] })
    const video = mediaVideo()
    const play = vi.mocked(window.HTMLMediaElement.prototype.play)
    const pause = vi.mocked(window.HTMLMediaElement.prototype.pause)
    play.mockClear()
    pause.mockClear()
    // jsdom の `paused` は常に true なので、再生中を再現する
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false })
    video.currentTime = 42
    fireEvent.change(screen.getByLabelText('再生速度'), { target: { value: '1.5' } })
    expect(video.playbackRate).toBe(1.5)

    fireEvent.click(screen.getByLabelText('ミュート解除'))

    await waitFor(() => expect(video.dataset.audioReinit).toBe('1'))
    expect(video.muted).toBe(false)
    expect(video.volume).toBeCloseTo(0.6, 5)
    // 「状態反映後の play()」と「pause() → play() のフォールバック」で 2 回
    expect(play).toHaveBeenCalledTimes(2)
    expect(pause).toHaveBeenCalledTimes(1)
    expect(video.currentTime).toBeCloseTo(42, 5)
    expect(video.playbackRate).toBeCloseTo(1.5, 5)
  })

  it('停止中は解除しても play() を呼ばない（勝手に再生しない）', async () => {
    renderLightbox({ files: [videoFile(32)] })
    const video = mediaVideo()
    const play = vi.mocked(window.HTMLMediaElement.prototype.play)
    play.mockClear()

    fireEvent.click(screen.getByLabelText('ミュート解除'))

    await waitFor(() => expect(video.muted).toBe(false))
    expect(play).not.toHaveBeenCalled()
    expect(video.dataset.audioReinit).toBeUndefined()
  })

  it('シールド中は解除しても再初期化しない', async () => {
    renderLightbox({ files: [videoFile(33)], shielded: true })
    const video = mediaVideo()
    const play = vi.mocked(window.HTMLMediaElement.prototype.play)
    play.mockClear()
    Object.defineProperty(video, 'paused', { configurable: true, get: () => false })

    fireEvent.click(screen.getByLabelText('ミュート解除'))

    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-audio-notice]')).not.toBeNull(),
    )
    expect(play).not.toHaveBeenCalled()
    expect(video.dataset.audioReinit).toBeUndefined()
  })

  it('解除時に「音声を有効化しました（音量 60%）」を通知する', async () => {
    renderLightbox({ files: [videoFile(34)] })
    fireEvent.click(screen.getByLabelText('ミュート解除'))
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-audio-notice]')?.textContent).toBe(
        '音声を有効化しました（音量 60%）',
      ),
    )
  })
})
