import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api'
import type { WorkFeedQuery } from '../src/library/useWorkFeed'
import { useWorkFeed } from '../src/library/useWorkFeed'

// #87: `@/api` を差し替え、依存キーが変わったら `find_works` を呼び直すことを見る
vi.mock('../src/api', () => ({
  api: { findWorks: vi.fn(), listFiles: vi.fn() },
}))

const findWorks = vi.mocked(api.findWorks)

function query(overrides: Partial<WorkFeedQuery> = {}): WorkFeedQuery {
  return {
    search: '',
    kind: 'all',
    rootId: null,
    sort: 'mtime',
    dir: 'desc',
    ...overrides,
  }
}

beforeEach(() => {
  findWorks.mockReset()
  findWorks.mockResolvedValue({ works: [], total: 0 })
})

describe('useWorkFeed の依存キー（#87）', () => {
  it('dir を変えると find_works を再取得する', async () => {
    const { rerender } = renderHook(
      ({ dir }: { dir: 'asc' | 'desc' }) =>
        useWorkFeed({ query: query({ dir }), refreshToken: 0 }),
      { initialProps: { dir: 'desc' as 'asc' | 'desc' } },
    )

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(1))
    expect(findWorks.mock.calls[0][0].dir).toBe('desc')

    rerender({ dir: 'asc' })

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(2))
    expect(findWorks.mock.calls[1][0].dir).toBe('asc')
  })

  it('sort を変えると再取得する', async () => {
    const { rerender } = renderHook(
      ({ sort }: { sort: WorkFeedQuery['sort'] }) =>
        useWorkFeed({ query: query({ sort }), refreshToken: 0 }),
      { initialProps: { sort: 'mtime' as WorkFeedQuery['sort'] } },
    )

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(1))

    rerender({ sort: 'title' })

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(2))
    expect(findWorks.mock.calls[1][0].sort).toBe('title')
  })

  it('metaQuery を変えると再取得する（取りこぼし確認）', async () => {
    const { rerender } = renderHook(
      ({ metaQuery }: { metaQuery: string | undefined }) =>
        useWorkFeed({ query: query({ metaQuery }), refreshToken: 0 }),
      { initialProps: { metaQuery: undefined as string | undefined } },
    )

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(1))

    rerender({ metaQuery: 'cat' })

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(2))
    expect(findWorks.mock.calls[1][0].metaQuery).toBe('cat')
  })

  it('同じ条件の再描画では再取得しない', async () => {
    const { rerender } = renderHook(
      ({ dir }: { dir: 'asc' | 'desc' }) =>
        useWorkFeed({ query: query({ dir }), refreshToken: 0 }),
      { initialProps: { dir: 'desc' as 'asc' | 'desc' } },
    )

    await waitFor(() => expect(findWorks).toHaveBeenCalledTimes(1))

    rerender({ dir: 'desc' })

    // 再取得が始まらないことを確かめる（マイクロタスクを 1 巡させる）
    await Promise.resolve()
    expect(findWorks).toHaveBeenCalledTimes(1)
  })
})
