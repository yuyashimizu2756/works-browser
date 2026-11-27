import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api'
import type { FileFeedQuery } from '../src/library/useFileFeed'
import { useFileFeed } from '../src/library/useFileFeed'

// #87: ファイルモードも同じ抜けが無いかを `list_files` の呼び出しで見る
vi.mock('../src/api', () => ({
  api: { findWorks: vi.fn(), listFiles: vi.fn() },
}))

const listFiles = vi.mocked(api.listFiles)

function query(overrides: Partial<FileFeedQuery> = {}): FileFeedQuery {
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
  listFiles.mockReset()
  listFiles.mockResolvedValue({ files: [], total: 0 })
})

describe('useFileFeed の依存キー（#87）', () => {
  it('dir を変えると list_files を再取得する', async () => {
    const { rerender } = renderHook(
      ({ dir }: { dir: 'asc' | 'desc' }) =>
        useFileFeed({ query: query({ dir }), refreshToken: 0 }),
      { initialProps: { dir: 'desc' as 'asc' | 'desc' } },
    )

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1))
    expect(listFiles.mock.calls[0][0].dir).toBe('desc')

    rerender({ dir: 'asc' })

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    expect(listFiles.mock.calls[1][0].dir).toBe('asc')
  })

  it('sort を変えると再取得する', async () => {
    const { rerender } = renderHook(
      ({ sort }: { sort: FileFeedQuery['sort'] }) =>
        useFileFeed({ query: query({ sort }), refreshToken: 0 }),
      { initialProps: { sort: 'mtime' as FileFeedQuery['sort'] } },
    )

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1))

    rerender({ sort: 'name' })

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    expect(listFiles.mock.calls[1][0].sort).toBe('name')
  })

  it('metaQuery を変えると再取得する（取りこぼし確認）', async () => {
    const { rerender } = renderHook(
      ({ metaQuery }: { metaQuery: string | undefined }) =>
        useFileFeed({ query: query({ metaQuery }), refreshToken: 0 }),
      { initialProps: { metaQuery: undefined as string | undefined } },
    )

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1))

    rerender({ metaQuery: 'cat' })

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(2))
    expect(listFiles.mock.calls[1][0].metaQuery).toBe('cat')
  })

  it('同じ条件の再描画では再取得しない', async () => {
    const { rerender } = renderHook(
      ({ dir }: { dir: 'asc' | 'desc' }) =>
        useFileFeed({ query: query({ dir }), refreshToken: 0 }),
      { initialProps: { dir: 'desc' as 'asc' | 'desc' } },
    )

    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1))

    rerender({ dir: 'desc' })

    await Promise.resolve()
    expect(listFiles).toHaveBeenCalledTimes(1)
  })
})
