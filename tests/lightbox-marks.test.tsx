/**
 * #13: マーク保存の整合性（ライトボックス / 作品詳細ヘッダ）。
 *
 * - 読み込みが終わるまでは操作できない（既存の評価を `rating: null` で消さない）
 * - 保存に失敗したら楽観更新を戻す
 * - 書き込み開始後に届いた GET では巻き戻らない
 * - 長押し（`event.repeat`）で連打しない
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag, WorkMark } from '../src/api'
import { Lightbox } from '../src/library/Lightbox'
import { WorkMarksBar } from '../src/library/WorkMarksBar'
import {
  emptyMark,
  MARK_CHANGED_EVENT,
  setTagData,
} from '../src/library/tagData'
import type { TagData } from '../src/library/tagData'
import { makeFile } from './fixtures'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function markOf(workId: number, patch: Partial<WorkMark> = {}): WorkMark {
  return { ...emptyMark(workId), ...patch }
}

function createTagData(options: {
  getWorkMark?: (workId: number) => Promise<WorkMark>
  recordOpen?: (workId: number) => Promise<WorkMark>
  setWorkMark?: TagData['setWorkMark']
} = {}) {
  const tags: Tag[] = [{ id: 1, name: '猫', color: '#22d3ee', created_at: 0, works: 0 }]
  const data: TagData = {
    listTags: async () => tags,
    createTag: async (name, color) => ({
      id: tags.length + 1,
      name,
      color,
      created_at: 0,
      works: 0,
    }),
    deleteTag: async () => {},
    getWorkTags: async () => [],
    setWorkTags: async () => [],
    tagSuggestions: async () => [],
    getWorkMark: options.getWorkMark ?? (async (workId) => markOf(workId)),
    setWorkMark: options.setWorkMark ?? (async (workId, next) => markOf(workId, next)),
    recordOpen: options.recordOpen ?? (async (workId) => markOf(workId)),
  }
  return data
}

function renderLightbox() {
  const props = {
    files: [makeFile({ id: 11, name: 'a.png' })],
    index: 0,
    hasMore: false,
    loadingMore: false,
    onRequestMore: vi.fn(),
    onIndexChange: vi.fn(),
    onClose: vi.fn(),
    bench: false,
    workId: 7,
    rootRealPath: 'D:\\Works\\root-1',
  }
  render(<Lightbox {...props} />)
  return props
}

function marks() {
  return document.querySelector('[data-lightbox-marks]') as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal('HTMLMediaElement', window.HTMLMediaElement)
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  setTagData(null)
  vi.restoreAllMocks()
})

describe('#13 ライトボックスのマーク', () => {
  it('読み込み前は操作できず、既存の評価が消えない', async () => {
    const load = deferred<WorkMark>()
    const setWorkMark = vi.fn(async (workId: number, next: Partial<WorkMark>) =>
      markOf(workId, next),
    )
    setTagData(
      createTagData({
        getWorkMark: () => load.promise,
        setWorkMark: setWorkMark as TagData['setWorkMark'],
      }),
    )
    renderLightbox()

    expect(marks()).toHaveAttribute('data-lightbox-marks-loaded', 'false')
    const toggle = document.querySelector('[data-lightbox-favorite-toggle]') as HTMLElement
    expect(toggle).toBeDisabled()
    expect(toggle.getAttribute('title')).toContain('読み込')

    // 読み込み前のキー操作は無効（古い値で上書きしない）
    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', shiftKey: true })
    fireEvent.keyDown(window, { key: '3', code: 'Digit3' })
    fireEvent.keyDown(window, { key: '0', code: 'Digit0', shiftKey: true })
    expect(setWorkMark).not.toHaveBeenCalled()

    await act(async () => {
      load.resolve(markOf(7, { favorite: true, rating: 4 }))
    })
    await waitFor(() => expect(marks()).toHaveAttribute('data-lightbox-marks-loaded', 'true'))
    expect(marks()).toHaveAttribute('data-lightbox-favorite', 'true')
    expect(marks()).toHaveAttribute('data-lightbox-rating', '4')
    expect(toggle).toBeEnabled()
  })

  it('保存に失敗したら楽観更新を戻して通知する', async () => {
    const save = deferred<WorkMark>()
    const setWorkMark = vi.fn(() => save.promise)
    setTagData(
      createTagData({
        getWorkMark: async (workId) => markOf(workId, { favorite: true, rating: 4 }),
        setWorkMark: setWorkMark as TagData['setWorkMark'],
      }),
    )
    renderLightbox()
    await waitFor(() => expect(marks()).toHaveAttribute('data-lightbox-marks-loaded', 'true'))

    fireEvent.click(screen.getByLabelText('お気に入りから外す（Shift+F）'))
    expect(marks()).toHaveAttribute('data-lightbox-favorite', 'false')

    await act(async () => {
      save.reject(new Error('disk full'))
    })
    await waitFor(() => expect(marks()).toHaveAttribute('data-lightbox-favorite', 'true'))
    expect(marks()).toHaveAttribute('data-lightbox-rating', '4')
    await waitFor(() =>
      expect(document.querySelector('[data-lightbox-notice]')?.textContent).toContain(
        '保存できませんでした',
      ),
    )
    expect(document.querySelector('[data-lightbox-notice]')).toHaveAttribute(
      'data-lightbox-notice-tone',
      'error',
    )
  })

  it('長押し（event.repeat）では保存しない', async () => {
    const setWorkMark = vi.fn(async (workId: number, next: Partial<WorkMark>) =>
      markOf(workId, next),
    )
    setTagData(createTagData({ setWorkMark: setWorkMark as TagData['setWorkMark'] }))
    renderLightbox()
    await waitFor(() => expect(marks()).toHaveAttribute('data-lightbox-marks-loaded', 'true'))

    fireEvent.keyDown(window, { key: '3', code: 'Digit3', repeat: true })
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', repeat: true })
    expect(setWorkMark).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: '3', code: 'Digit3' })
    await waitFor(() => expect(setWorkMark).toHaveBeenCalledTimes(1))
    expect(marks()).toHaveAttribute('data-lightbox-rating', '3')
  })
})

describe('#13 作品詳細ヘッダ（WorkMarksBar）のマーク', () => {
  it('読み込み前は操作できず、既存の評価が消えない', async () => {
    const open = deferred<WorkMark>()
    const setWorkMark = vi.fn(async (workId: number, next: Partial<WorkMark>) =>
      markOf(workId, next),
    )
    setTagData(
      createTagData({
        recordOpen: () => open.promise,
        setWorkMark: setWorkMark as TagData['setWorkMark'],
      }),
    )
    render(<WorkMarksBar workId={7} />)

    const root = document.querySelector('[data-work-marks]') as HTMLElement
    expect(root).toHaveAttribute('data-mark-loaded', 'false')
    const star = screen.getByRole('button', { name: '5 段階で評価' })
    expect(star).toBeDisabled()
    fireEvent.click(star)
    expect(setWorkMark).not.toHaveBeenCalled()

    await act(async () => {
      open.resolve(markOf(7, { rating: 4 }))
    })
    await waitFor(() => expect(root).toHaveAttribute('data-mark-loaded', 'true'))
    expect(screen.getByText('4 / 5')).toBeInTheDocument()
    expect(star).toBeEnabled()
  })

  it('保存に失敗したら楽観更新を戻してエラーを出す', async () => {
    setTagData(
      createTagData({
        recordOpen: async (workId) => markOf(workId, { rating: 4 }),
        setWorkMark: async () => {
          throw new Error('read only')
        },
      }),
    )
    render(<WorkMarksBar workId={7} />)
    await waitFor(() =>
      expect(document.querySelector('[data-work-marks]')).toHaveAttribute(
        'data-mark-loaded',
        'true',
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: '5 段階で評価' }))
    expect(screen.getByText('5 / 5')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('4 / 5')).toBeInTheDocument())
    expect(screen.getByRole('alert').textContent).toContain('保存できませんでした')
  })

  it('書き込み開始後に届いた遅い GET では巻き戻らない', async () => {
    const stale = deferred<WorkMark>()
    let getCalls = 0
    setTagData(
      createTagData({
        recordOpen: async (workId) => markOf(workId, { rating: 3 }),
        getWorkMark: () => {
          getCalls += 1
          return stale.promise
        },
        setWorkMark: async (workId, next) => markOf(workId, next),
      }),
    )
    render(<WorkMarksBar workId={7} />)
    await waitFor(() =>
      expect(document.querySelector('[data-work-marks]')).toHaveAttribute(
        'data-mark-loaded',
        'true',
      ),
    )

    // 他画面からの変更通知で GET が始まる（まだ応答しない）
    window.dispatchEvent(new CustomEvent(MARK_CHANGED_EVENT, { detail: { workId: 7 } }))
    expect(getCalls).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'お気に入りに追加' }))
    await waitFor(() =>
      expect(document.querySelector('[data-favorite="true"]')).not.toBeNull(),
    )

    // 書き込み開始後に古い値の GET が届いても、楽観更新を巻き戻さない
    await act(async () => {
      stale.resolve(markOf(7, { rating: 1, favorite: false }))
    })
    expect(document.querySelector('[data-favorite="true"]')).not.toBeNull()
    expect(screen.getByText('3 / 5')).toBeInTheDocument()
  })
})
