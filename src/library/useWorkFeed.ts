import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { SortKey, WorkKindFilter, WorkPage, WorkQuery, WorkSummary } from '../api'
import { describeError } from '../lib/format'

/** グリッドが必要とするページサイズ。1 万件でも 17 往復で読み切れる。 */
export const PAGE_SIZE = 600

export type WorkFeedQuery = {
  /** 入力中の値（200ms デバウンスしてから問い合わせる）。 */
  search: string
  kind: WorkKindFilter
  rootId: number | null
  sort: SortKey
  /** #59: 昇順 / 降順。 */
  dir?: 'asc' | 'desc'
  /** #6: タグ絞り込み。 */
  tagId?: number | null
  /** #6: お気に入りのみ。 */
  favorite?: boolean
  /** #6: 最低評価（1〜5）。 */
  minRating?: number | null
  /** #60: 生成情報（プロンプト・モデル等）の検索語。 */
  metaQuery?: string
}

export type WorkPageSource = (query: WorkQuery) => Promise<WorkPage>

/** 既定の供給元（Tauri の `find_works`）。 */
export const dbWorkSource: WorkPageSource = (query) => api.findWorks(query)

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

type FeedStatus = 'loading' | 'ready' | 'error'

/**
 * `find_works` を 1 ページずつ読み、仮想グリッドに渡す。
 *
 * - 検索入力は 200ms デバウンス（DB 側 LIKE）
 * - ページ取得は直列化し、フィルタ変更時は世代番号で古い応答を捨てる
 * - 走査完了などで `refreshToken` が変わったら先頭から読み直す
 */
export function useWorkFeed(options: {
  query: WorkFeedQuery
  source?: WorkPageSource
  refreshToken: number
}) {
  const { query, source = dbWorkSource, refreshToken } = options
  const search = query.search.trim()
  const debouncedSearch = useDebouncedValue(search, 200)

  const [works, setWorks] = useState<WorkSummary[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<FeedStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  const generation = useRef(0)
  const worksRef = useRef<WorkSummary[]>([])
  const totalRef = useRef(0)
  const pending = useRef(new Set<string>())
  const queue = useRef<Promise<void>>(Promise.resolve())
  const filtersRef = useRef({
    search: debouncedSearch,
    kind: query.kind,
    rootId: query.rootId,
    sort: query.sort,
    dir: query.dir,
    tagId: query.tagId ?? null,
    favorite: query.favorite ?? false,
    minRating: query.minRating ?? null,
    metaQuery: query.metaQuery ?? '',
  })
  filtersRef.current = {
    search: debouncedSearch,
    kind: query.kind,
    rootId: query.rootId,
    sort: query.sort,
    dir: query.dir,
    tagId: query.tagId ?? null,
    favorite: query.favorite ?? false,
    minRating: query.minRating ?? null,
    metaQuery: query.metaQuery ?? '',
  }

  const requestPage = useCallback(
    (offset: number) => {
      const generationAtRequest = generation.current
      const key = `${generationAtRequest}:${offset}`
      if (pending.current.has(key)) return
      if (offset > 0) {
        // 前のページが届いていない / 既に最後まで読んだ場合は何もしない
        if (offset !== worksRef.current.length || offset >= totalRef.current) return
      }
      pending.current.add(key)
      queue.current = queue.current.then(async () => {
        if (generationAtRequest !== generation.current) {
          pending.current.delete(key)
          return
        }
        const filters = filtersRef.current
        try {
          const page = await source({
            limit: PAGE_SIZE,
            offset,
            sort: filters.sort,
            dir: filters.dir,
            search: filters.search || undefined,
            kind: filters.kind === 'all' ? undefined : filters.kind,
            rootId: filters.rootId ?? undefined,
            tagId: filters.tagId,
            favorite: filters.favorite || undefined,
            minRating: filters.minRating,
            metaQuery: filters.metaQuery || undefined,
          })
          if (generationAtRequest !== generation.current) return
          const next = offset === 0 ? page.works : [...worksRef.current, ...page.works]
          worksRef.current = next
          totalRef.current = page.total
          setWorks(next)
          setTotal(page.total)
          setError(null)
          setStatus('ready')
        } catch (cause) {
          if (generationAtRequest === generation.current) {
            setError(describeError(cause))
            setStatus('error')
          }
        } finally {
          pending.current.delete(key)
        }
      })
    },
    [source],
  )

  const filterKey = `${debouncedSearch}\u0000${query.kind}\u0000${query.rootId ?? ''}\u0000${
    query.sort
  }\u0000${query.dir ?? ''}\u0000${query.tagId ?? ''}\u0000${query.favorite ? 'fav' : ''}\u0000${
    query.minRating ?? ''
  }\u0000${query.metaQuery ?? ''}`

  useEffect(() => {
    generation.current += 1
    pending.current.clear()
    worksRef.current = []
    totalRef.current = 0
    setWorks([])
    setTotal(0)
    setError(null)
    setStatus('loading')
    requestPage(0)
  }, [filterKey, refreshToken, retryToken, requestPage])

  const loadMore = useCallback(() => {
    if (status === 'error') return
    const loaded = worksRef.current.length
    if (loaded >= totalRef.current) return
    // #49: 先読み中にスクロールイベントが連続しても二重取得しない。
    if (pending.current.size > 0) return
    requestPage(loaded)
  }, [requestPage, status])

  /**
   * 現在の絞り込み条件に一致する作品を全ページ分読み出す（Ctrl+A 用）。
   * グリッドのページングとは独立して 1,000 件ずつ取得する。
   */
  const loadAll = useCallback(async (): Promise<WorkSummary[]> => {
    const filters = filtersRef.current
    const collected: WorkSummary[] = []
    let offset = 0
    // 暴走防止（1,000 件 × 100 回 = 10 万件まで）
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await source({
        limit: 1000,
        offset,
        sort: filters.sort,
        dir: filters.dir,
        search: filters.search || undefined,
        kind: filters.kind === 'all' ? undefined : filters.kind,
        rootId: filters.rootId ?? undefined,
        tagId: filters.tagId,
        favorite: filters.favorite || undefined,
        minRating: filters.minRating,
        metaQuery: filters.metaQuery || undefined,
      })
      collected.push(...page.works)
      if (page.works.length === 0 || collected.length >= page.total) break
      offset += page.works.length
    }
    return collected
  }, [source])

  const retry = useCallback(() => {
    setRetryToken((value) => value + 1)
  }, [])

  return {
    works,
    total,
    status,
    error,
    /** 入力は変わったがデバウンス待ち / DB 問い合わせ中。 */
    isSearching: search !== debouncedSearch || (status === 'loading' && works.length === 0),
    hasMore: works.length < total,
    loadMore,
    loadAll,
    retry,
  }
}
