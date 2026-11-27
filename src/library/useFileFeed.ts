import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type {
  FileKindFilter,
  FilePage,
  FileQuery,
  FileSortKey,
  FileSummary,
} from '../api'
import { describeError } from '../lib/format'
import { useDebouncedValue } from './useWorkFeed'

/** ファイルモードのページサイズ。65,000 件でも 109 往復で読み切れる。 */
export const FILE_PAGE_SIZE = 600

export type FileFeedQuery = {
  /** 入力中の値（200ms デバウンスしてから問い合わせる）。 */
  search: string
  kind: FileKindFilter
  rootId: number | null
  sort: FileSortKey
  /** #87: 昇順 / 降順。省略時はキーごとの既定（Rust 側も同じ）。 */
  dir?: 'asc' | 'desc'
  /** 作品 1 件に絞る（#5 の作品詳細ギャラリー）。 */
  workId?: number | null
  /** #60: 生成情報（プロンプト・モデル等）の検索語。 */
  metaQuery?: string
}

export type FilePageSource = (query: FileQuery) => Promise<FilePage>

/** 既定の供給元（Tauri の `list_files`）。 */
export const dbFileSource: FilePageSource = (query) => api.listFiles(query)

/** 作品詳細の供給元（Tauri の `get_work_files`）。#5 */
export const dbWorkFileSource: FilePageSource = (query) => api.getWorkFiles(query)

/** 作品詳細のページサイズ（1,000 ファイルでも 4 往復）。#5 */
export const WORK_FILE_PAGE_SIZE = 300

type FeedStatus = 'loading' | 'ready' | 'error'

/**
 * `list_files` を 1 ページずつ読み、ファイルグリッドに渡す（#21）。
 *
 * ページ取得は直列化し、絞り込み変更時は世代番号で古い応答を捨てる。
 * 最初のページが届くまでの時間を `firstPageMs` で返す（ベンチ計測用）。
 */
export function useFileFeed(options: {
  query: FileFeedQuery
  source?: FilePageSource
  refreshToken: number
  /** 1 ページの件数（作品詳細は 300、ファイルモードは 600）。 */
  pageSize?: number
}) {
  const { query, source = dbFileSource, refreshToken, pageSize = FILE_PAGE_SIZE } = options
  const search = query.search.trim()
  const debouncedSearch = useDebouncedValue(search, 200)

  const [files, setFiles] = useState<FileSummary[]>([])
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<FeedStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [firstPageMs, setFirstPageMs] = useState<number | null>(null)

  const generation = useRef(0)
  const filesRef = useRef<FileSummary[]>([])
  const totalRef = useRef(0)
  const pending = useRef(new Set<string>())
  const queue = useRef<Promise<void>>(Promise.resolve())
  const requestedAt = useRef(0)
  const filtersRef = useRef<FileFeedQuery>({
    search: debouncedSearch,
    kind: query.kind,
    rootId: query.rootId,
    sort: query.sort,
    dir: query.dir,
    workId: query.workId,
    metaQuery: query.metaQuery ?? '',
  })
  filtersRef.current = {
    search: debouncedSearch,
    kind: query.kind,
    rootId: query.rootId,
    sort: query.sort,
    dir: query.dir,
    workId: query.workId,
    metaQuery: query.metaQuery ?? '',
  }

  const requestPage = useCallback(
    (offset: number) => {
      const generationAtRequest = generation.current
      const key = `${generationAtRequest}:${offset}`
      if (pending.current.has(key)) return
      if (offset > 0) {
        if (offset !== filesRef.current.length || offset >= totalRef.current) return
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
            limit: pageSize,
            offset,
            sort: filters.sort,
            dir: filters.dir,
            search: filters.search || undefined,
            kind: filters.kind === 'all' ? undefined : filters.kind,
            rootId: filters.rootId ?? undefined,
            workId: filters.workId ?? undefined,
            metaQuery: filters.metaQuery || undefined,
          })
          if (generationAtRequest !== generation.current) return
          const next = offset === 0 ? page.files : [...filesRef.current, ...page.files]
          filesRef.current = next
          totalRef.current = page.total
          setFiles(next)
          setTotal(page.total)
          setError(null)
          setStatus('ready')
          if (offset === 0) {
            setFirstPageMs(Math.max(0, Math.round(performance.now() - requestedAt.current)))
          }
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
    [source, pageSize],
  )

  const filterKey = `${debouncedSearch}\u0000${query.kind}\u0000${query.rootId ?? ''}\u0000${query.sort}\u0000${query.dir ?? ''}\u0000${query.workId ?? ''}\u0000${query.metaQuery ?? ''}`

  useEffect(() => {
    generation.current += 1
    pending.current.clear()
    filesRef.current = []
    totalRef.current = 0
    requestedAt.current = performance.now()
    setFiles([])
    setTotal(0)
    setError(null)
    setStatus('loading')
    setFirstPageMs(null)
    requestPage(0)
  }, [filterKey, refreshToken, retryToken, requestPage])

  const loadMore = useCallback(() => {
    if (status === 'error') return
    const loaded = filesRef.current.length
    if (loaded >= totalRef.current) return
    // #49: 先読み中にスクロールイベントが連続しても二重取得しない。
    if (pending.current.size > 0) return
    requestPage(loaded)
  }, [requestPage, status])

  const retry = useCallback(() => {
    setRetryToken((value) => value + 1)
  }, [])

  return {
    files,
    total,
    status,
    error,
    firstPageMs,
    isSearching: search !== debouncedSearch || (status === 'loading' && files.length === 0),
    hasMore: files.length < total,
    loadMore,
    retry,
  }
}

/** ファイルモードの件数表示用（`0 件` を出さない）。 */
export function fileFeedLabel(kind: FileKindFilter): string {
  if (kind === 'video') return '動画'
  if (kind === 'image') return '画像'
  return 'ファイル'
}
