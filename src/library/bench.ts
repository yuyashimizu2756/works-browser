/**
 * 合成データでスクロール性能を測るための開発用モード（#4 / #21）。
 *
 * `?bench=10000` で作品モード、`?bench=65000&mode=files` でファイルモードを開くと、
 * Tauri IPC の代わりにメモリ上の合成データを `find_works` / `list_files` と同じ形で返す。
 * `window.__worksBench.start()` が全ページを読み込ませたあと、一定時間スクロールして
 * フレームレートを返す。
 *
 * `?bench=500` 以下のときはファイル一覧・作品詳細のサムネイルに SVG の data URL を
 * 入れる（headless 確認用。実アプリでは使わない）。作品グリッドは #100 で
 * 「サムネイル未生成」の状態を再現するため、デモ（`?demo=1`）以外は画像を入れない。
 */
import type {
  FilePage,
  FileSummary,
  RootInfo,
  Tag,
  WorkKind,
  WorkMark,
  WorkPage,
  WorkSummary,
} from '../api'
import { filterFiles, filterWorks } from '../lib/filter'
import { sortFiles, sortWorks } from '../lib/sort'
import type { FilePageSource } from './useFileFeed'
import type { WorkPageSource } from './useWorkFeed'
import type { TagData } from './tagData'
import { emptyMark, setTagData } from './tagData'

const KINDS: WorkKind[] = ['image', 'video', 'mixed']
const ROOT_IDS = [1, 2, 3, 4]
const BENCH_THUMB_LIMIT = 500

/** URL の `?bench=10000` を読む。未指定なら null。 */
export function benchCountFromUrl(search = window.location.search): number | null {
  const raw = new URLSearchParams(search).get('bench')
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 10_000
  return Math.min(parsed, 100_000)
}

/** URL の `?demo=1` を読む（#97）。`?bench=N` と併用したときだけ意味を持つ。 */
export function demoModeFromUrl(search = window.location.search): boolean {
  const raw = new URLSearchParams(search).get('demo')
  return raw === '1' || raw === 'true'
}

/** 決定的な擬似乱数（見た目のサイズを散らすだけ）。 */
function noise(seed: number): number {
  let value = (seed * 1_103_515_245 + 12_345) % 2_147_483_647
  value = (value * 1_103_515_245 + 12_345) % 2_147_483_647
  return value / 2_147_483_647
}

const THUMB_COLORS = ['#3b6ea5', '#7c4dbb', '#1f8a70', '#b5651d', '#a53b5c', '#2a7f8f']

/** headless 確認用の小さな SVG サムネイル（data URL）。 */
function benchThumb(seed: number, label: string): string {
  const color = THUMB_COLORS[seed % THUMB_COLORS.length]
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">` +
    `<rect width="320" height="180" fill="${color}"/>` +
    `<text x="160" y="104" font-family="Segoe UI, sans-serif" font-size="34" font-weight="600" ` +
    `fill="#ffffff" text-anchor="middle">${label}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * #97: デモモードで使う画像 URL の並び。null なら従来のプレースホルダを返す。
 * カード 1 枚ごとに違う絵が見えるよう、seed を法にして選ぶ。
 */
export type DemoThumbs = readonly string[] | null

function demoThumbAt(images: readonly string[], seed: number): string {
  return images[((seed % images.length) + images.length) % images.length]
}

/** デモ画像があればそれを、無ければ従来どおりの SVG プレースホルダを返す。 */
function thumbFor(demo: DemoThumbs, seed: number, label: string): string {
  if (demo !== null && demo.length > 0) return demoThumbAt(demo, seed)
  return benchThumb(seed, label)
}

function buildWorks(count: number, demo: DemoThumbs = null): WorkSummary[] {
  const base = Date.UTC(2026, 10, 25, 12, 0, 0)
  const useDemo = demo !== null && demo.length > 0
  return Array.from({ length: count }, (_, index) => {
    const serial = String(index + 1).padStart(5, '0')
    const kind = KINDS[index % KINDS.length]
    const title = index % 9 === 0 ? `ベンチ作品 ${serial}` : `Bench Work ${serial}`
    return {
      id: index + 1,
      root_id: ROOT_IDS[index % ROOT_IDS.length],
      rel_path: `bench/root${index % ROOT_IDS.length}/${serial}`,
      title,
      kind,
      cover_file_id: null,
      // #100: デモ以外は「サムネイル未生成」の状態をそのまま再現する。
      // （画像を出すのは `?demo=1` のときだけ）
      cover_thumb: useDemo ? thumbFor(demo, index, `W${serial}`) : null,
      // デモでは 1 枚の絵を大きく見せたいので、2×2 モザイクは作らない（#97）。
      preview_thumbs: [],
      file_count: 1 + (index % 37),
      total_bytes: 1024 * (200 + Math.floor(noise(index) * 8_000_000)),
      mtime: base - (index % 900) * 86_400_000,
    }
  })
}

/**
 * #100: 空状態のショット用の合成ルート。
 *
 * 通常のベンチ（`?bench=N` だけ）ではサイドバーを空のままにするが、
 * 「スマートフォルダ無し / 検索 0 件 / サムネ未生成」を見るときだけ、
 * 作品カードの `root_id` に対応する 4 ルートを並べる。
 */
export function createBenchRoots(count: number): RootInfo[] {
  const labels = ['写真', 'イラスト', '動画', '素材']
  const base = Date.UTC(2026, 10, 25, 12, 0, 0)
  const perRoot = Math.floor(count / ROOT_IDS.length)
  return ROOT_IDS.map((id, index) => {
    const works = perRoot + (index < count % ROOT_IDS.length ? 1 : 0)
    return {
      root: {
        id,
        path: `D:\\Works\\${labels[index]}`,
        real_path: `D:\\Works\\${labels[index]}`,
        label: labels[index],
        depth: 1,
        enabled: true,
        duplicate_of: null,
        created_at: base - index * 86_400_000,
      },
      works,
      files: works * 4,
      total_bytes: works * 240 * 1024 * 1024,
      last_scan_at: base - index * 3_600_000,
      last_scan_status: 'done',
      exists: true,
    }
  })
}

/**
 * ベンチ用のタグ・評価・開封回数（#6）。
 *
 * 実 DB の代わりにメモリ上で `list_tags` / `set_work_tags` / `record_open` と同じ
 * 形を返す。`?bench=` で UI のタグ付け → 絞り込み → 並び替えを headless 確認するため。
 */
export type BenchTagData = TagData & {
  /** 付与・評価が変わるたびに増える（`find_works` のキャッシュ無効化に使う）。 */
  version: number
  isFavorite: (workId: number) => boolean
  hasTag: (workId: number, tagId: number) => boolean
  openCount: (workId: number) => number
  lastOpened: (workId: number) => number | null
  rating: (workId: number) => number | null
}

const BENCH_TAGS: { name: string; color: string; every: number }[] = [
  { name: 'サンプル', color: '#22d3ee', every: 3 },
  { name: 'あとで見る', color: '#f59e0b', every: 5 },
  { name: 'シリーズ', color: '#ec4899', every: 7 },
]

export function createBenchTagData(count: number): BenchTagData {
  const tags: Tag[] = BENCH_TAGS.map((seed, index) => ({
    id: index + 1,
    name: seed.name,
    color: seed.color,
    created_at: 0,
    works: 0,
  }))
  const workTags = new Map<number, Set<number>>()
  const marks = new Map<number, WorkMark>()
  const base = Date.UTC(2026, 10, 25, 12, 0, 0)
  let nextTagId = tags.length + 1
  const state = {
    version: 0,
  } as BenchTagData

  const tagsFor = (workId: number): Set<number> => {
    let set = workTags.get(workId)
    if (!set) {
      set = new Set()
      workTags.set(workId, set)
    }
    return set
  }
  const markFor = (workId: number): WorkMark => {
    let mark = marks.get(workId)
    if (!mark) {
      mark = emptyMark(workId)
      marks.set(workId, mark)
    }
    return mark
  }
  const recount = () => {
    for (const tag of tags) {
      let works = 0
      for (const set of workTags.values()) if (set.has(tag.id)) works += 1
      tag.works = works
    }
  }
  const bump = () => {
    state.version += 1
    recount()
  }

  // 決定的な初期値（タグ・お気に入り・評価・開封回数）
  for (let id = 1; id <= count; id += 1) {
    BENCH_TAGS.forEach((seed, index) => {
      if (id % seed.every === 0) tagsFor(id).add(index + 1)
    })
    const mark = markFor(id)
    mark.favorite = id % 4 === 0
    mark.rating = id % 6 === 0 ? 5 : id % 9 === 0 ? 3 : null
    mark.open_count = id % 11 === 0 ? (id % 5) + 1 : 0
    mark.last_opened_at =
      mark.open_count > 0 ? base - (id % 30) * 3_600_000 : null
  }
  recount()

  Object.assign(state, {
    listTags: async () => tags.map((tag) => ({ ...tag })),
    createTag: async (name: string, color: string) => {
      const trimmed = name.trim()
      const existing = tags.find(
        (tag) => tag.name.toLowerCase() === trimmed.toLowerCase(),
      )
      if (existing) {
        existing.color = color
        bump()
        return { ...existing }
      }
      const tag: Tag = {
        id: nextTagId,
        name: trimmed,
        color,
        created_at: Date.now(),
        works: 0,
      }
      nextTagId += 1
      tags.push(tag)
      bump()
      return { ...tag }
    },
    deleteTag: async (tagId: number) => {
      const index = tags.findIndex((tag) => tag.id === tagId)
      if (index >= 0) tags.splice(index, 1)
      for (const set of workTags.values()) set.delete(tagId)
      bump()
    },
    getWorkTags: async (workId: number) =>
      tags.filter((tag) => tagsFor(workId).has(tag.id)).map((tag) => ({ ...tag })),
    // ベンチには生成情報が無いので候補も出さない（実アプリは Rust 集計）。
    tagSuggestions: async () => [],
    setWorkTags: async (workId: number, tagIds: number[]) => {
      workTags.set(workId, new Set(tagIds.filter((id) => tags.some((tag) => tag.id === id))))
      bump()
      return tags
        .filter((tag) => tagsFor(workId).has(tag.id))
        .map((tag) => ({ ...tag }))
    },
    getWorkMark: async (workId: number) => ({ ...markFor(workId) }),
    setWorkMark: async (
      workId: number,
      mark: { favorite: boolean; rating: number | null },
    ) => {
      const current = markFor(workId)
      current.favorite = mark.favorite
      current.rating = mark.rating
      bump()
      return { ...current }
    },
    recordOpen: async (workId: number) => {
      const current = markFor(workId)
      current.open_count += 1
      current.last_opened_at = Date.now()
      bump()
      return { ...current }
    },
    isFavorite: (workId: number) => markFor(workId).favorite,
    hasTag: (workId: number, tagId: number) => tagsFor(workId).has(tagId),
    openCount: (workId: number) => markFor(workId).open_count,
    lastOpened: (workId: number) => markFor(workId).last_opened_at,
    rating: (workId: number) => markFor(workId).rating,
  })
  return state
}

let benchTagState: BenchTagData | null = null
let benchTagCount = -1

/** ベンチ用タグ実装を作り、UI の供給元として差し込む。 */
export function ensureBenchTagData(count: number): BenchTagData {
  if (benchTagState === null || benchTagCount !== count) {
    benchTagState = createBenchTagData(count)
    benchTagCount = count
    setTagData(benchTagState)
  }
  return benchTagState
}

function waitFrame(ms = 4): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

/** `find_works` 互換のメモリ内ソース。 */
export function createBenchSource(count: number, demo: DemoThumbs = null): WorkPageSource {
  const works = buildWorks(count, demo)
  const tags = ensureBenchTagData(count)
  // ページごとに 65,000 件を並べ替えないよう、同じ絞り込みの結果を覚える
  let cachedKey = ''
  let cachedRows: WorkSummary[] = works
  const rowsFor = (key: string, build: () => WorkSummary[]): WorkSummary[] => {
    if (key !== cachedKey) {
      cachedRows = build()
      cachedKey = key
    }
    return cachedRows
  }

  return async (query): Promise<WorkPage> => {
    const needle = query.search?.trim().toLowerCase() ?? ''
    const key = `${needle}\u0000${query.kind ?? ''}\u0000${query.rootId ?? ''}\u0000${
      query.tagId ?? ''
    }\u0000${query.favorite === true ? 'fav' : ''}\u0000${query.minRating ?? ''}\u0000${
      query.sort
    }\u0000${tags.version}`
    const sorted = rowsFor(key, () => {
      let rows = filterWorks(works, {
        search: needle,
        kind: query.kind,
        rootId: query.rootId,
      })
      if (query.tagId != null) {
        rows = rows.filter((work) => tags.hasTag(work.id, query.tagId as number))
      }
      if (query.favorite === true) {
        rows = rows.filter((work) => tags.isFavorite(work.id))
      }
      if (query.minRating != null) {
        rows = rows.filter((work) => (tags.rating(work.id) ?? 0) >= (query.minRating as number))
      }
      return sortWorks(rows, query.sort, tags)
    })
    await waitFrame()
    return {
      total: sorted.length,
      works: sorted.slice(query.offset, query.offset + query.limit),
    }
  }
}

function buildFiles(count: number, demo: DemoThumbs = null): FileSummary[] {
  const base = Date.UTC(2026, 10, 25, 12, 0, 0)
  const withThumbs = count <= BENCH_THUMB_LIMIT
  const workTitles = new Map<number, string>()
  const titleFor = (workId: number): string => {
    let title = workTitles.get(workId)
    if (title === undefined) {
      title = `ベンチ作品 ${String(workId).padStart(4, '0')}`
      workTitles.set(workId, title)
    }
    return title
  }
  return Array.from({ length: count }, (_, index) => {
    const serial = String(index + 1).padStart(5, '0')
    const video = index % 6 === 0
    const workId = Math.floor(index / 12) + 1
    const ext = video ? 'mp4' : 'png'
    return {
      id: index + 1,
      work_id: workId,
      rel_path: `bench/work-${workId}/${serial}.${ext}`,
      name: `${serial}.${ext}`,
      kind: video ? 'video' : 'image',
      bytes: 1024 * (30 + Math.floor(noise(index) * 900_000)),
      width: video ? 1920 : 1280,
      height: video ? 1080 : 720,
      duration_ms: video ? 5_000 + Math.floor(noise(index) * 600_000) : null,
      mtime: base - (index % 900) * 86_400_000,
      thumb_path: withThumbs ? thumbFor(demo, index, serial) : null,
      work_title: titleFor(workId),
      work_rel_path: `bench/work-${workId}`,
      root_id: ROOT_IDS[index % ROOT_IDS.length],
      // #114: ファイルモードでも「動画 + meta + 再生位置」が同時に出る状態を
      // スクショで確認できるよう、一部の動画に再開位置を持たせる。
      position_ms: video && index % 18 === 0 ? 42_000 : null,
      has_meta: index % 3 === 0,
    }
  })
}

/** 合成ファイル配列を `list_files` / `get_work_files` 互換のソースにする。 */
function filePageSourceFor(files: FileSummary[]): FilePageSource {
  let cachedKey = ''
  let cachedRows: FileSummary[] = files
  const rowsFor = (key: string, build: () => FileSummary[]): FileSummary[] => {
    if (key !== cachedKey) {
      cachedRows = build()
      cachedKey = key
    }
    return cachedRows
  }

  return async (query): Promise<FilePage> => {
    const needle = query.search?.trim().toLowerCase() ?? ''
    const key = `${needle}\u0000${query.kind ?? ''}\u0000${query.rootId ?? ''}\u0000${query.workId ?? ''}\u0000${query.sort}`
    const sorted = rowsFor(key, () =>
      sortFiles(
        filterFiles(files, {
          search: needle,
          kind: query.kind ?? 'all',
          rootId: query.rootId,
          workId: query.workId,
        }),
        query.sort,
      ),
    )
    await waitFrame()
    return {
      total: sorted.length,
      files: sorted.slice(query.offset, query.offset + query.limit),
    }
  }
}

/** `list_files` 互換のメモリ内ソース。 */
export function createBenchFileSource(count: number, demo: DemoThumbs = null): FilePageSource {
  return filePageSourceFor(buildFiles(count, demo))
}

function buildWorkFiles(workId: number, count: number, demo: DemoThumbs = null): FileSummary[] {
  const base = Date.UTC(2026, 10, 25, 12, 0, 0)
  const title = `ベンチ作品 ${String(workId).padStart(4, '0')}`
  return Array.from({ length: count }, (_, index) => {
    const serial = String(index + 1).padStart(5, '0')
    const video = index % 6 === 0
    const ext = video ? 'mp4' : 'png'
    return {
      id: workId * 1_000_000 + index + 1,
      work_id: workId,
      rel_path: `bench/work-${workId}/${serial}.${ext}`,
      name: `${serial}.${ext}`,
      kind: video ? 'video' : 'image',
      bytes: 1024 * (200 + Math.floor(noise(index) * 8_000)),
      width: video ? 1920 : 1280,
      height: video ? 1080 : 720,
      duration_ms: video ? 5_000 + Math.floor(noise(index) * 600_000) : null,
      mtime: base - (index % 900) * 86_400_000,
      // 作品ごとに違う絵になるよう、workId を混ぜて選ぶ（#97）。
      thumb_path:
        demo !== null && demo.length > 0
          ? demoThumbAt(demo, workId * 37 + index)
          : benchThumb(index, serial),
      work_title: title,
      work_rel_path: `bench/work-${workId}`,
      root_id: 1,
      position_ms: video && index % 18 === 0 ? 42_000 : null,
      has_meta: index % 3 === 0,
    }
  })
}

/** 作品詳細のベンチ用供給元（`get_work_files` 互換）。#5 */
export function createBenchWorkFileSource(
  workId: number,
  count: number,
  demo: DemoThumbs = null,
): FilePageSource {
  return filePageSourceFor(buildWorkFiles(workId, count, demo))
}

/** 作品詳細のベンチ用ヘッダ（`get_work_summary` 互換）。 */
export function benchWorkSummary(
  workId: number,
  count: number,
  demo: DemoThumbs = null,
): WorkSummary {
  const files = buildWorkFiles(workId, count, demo)
  const videos = files.filter((file) => file.kind === 'video').length
  const kind: WorkKind =
    videos === 0 ? 'image' : videos === files.length ? 'video' : 'mixed'
  return {
    id: workId,
    root_id: 1,
    rel_path: `bench/work-${workId}`,
    title: `ベンチ作品 ${String(workId).padStart(4, '0')}`,
    kind,
    cover_file_id: files[0]?.id ?? null,
    cover_thumb: files[0]?.thumb_path ?? null,
    preview_thumbs: files.slice(0, 4).map((file) => file.thumb_path ?? ''),
    file_count: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    mtime: files.reduce((latest, file) => Math.max(latest, file.mtime), 0),
  }
}

/** ベンチ用: `?detail=7` で作品 7 の詳細を直接開く。 */
export function benchDetailFromUrl(search = window.location.search): number | null {
  const raw = new URLSearchParams(search).get('detail')
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export type BenchResult = {
  /** 計測区間の平均 FPS。 */
  fps: number
  frames: number
  seconds: number
  p95FrameMs: number
  worstFrameMs: number
  over20ms: number
  /** 計測開始時点で読み込み済みだった件数 / 総数。 */
  loaded: number
  total: number
  columns: number
}

export type WorksBench = {
  start: (durationMs?: number) => Promise<BenchResult>
}

declare global {
  interface Window {
    __worksBench?: WorksBench
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * グリッド / リストのスクロール要素にベンチマークを仕掛ける。戻り値は後始末関数。
 * `loaded` / `total` は毎回読み直す（ページングで増えるため）。
 */
export function installBenchHarness(
  element: HTMLElement,
  stats: { loaded: () => number; total: () => number; columns: () => number },
): () => void {
  const run = async (durationMs = 4_000): Promise<BenchResult> => {
    // 1) 末尾へ飛ばしながら全ページを読み込ませる
    const deadline = performance.now() + 20_000
    while ((stats.total() === 0 || stats.loaded() < stats.total()) && performance.now() < deadline) {
      element.scrollTop = element.scrollHeight
      await wait(80)
    }
    element.scrollTop = 0
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await wait(250)

    // 2) 上から下まで等速でスクロールしながらフレーム間隔を記録
    const deltas: number[] = []
    const maxScroll = Math.max(1, element.scrollHeight - element.clientHeight)
    const startedAt = performance.now()
    await new Promise<void>((resolve) => {
      let last = startedAt
      const step = (now: number) => {
        deltas.push(now - last)
        last = now
        const progress = Math.min(1, (now - startedAt) / durationMs)
        element.scrollTop = maxScroll * progress
        if (progress < 1) {
          requestAnimationFrame(step)
        } else {
          resolve()
        }
      }
      requestAnimationFrame(step)
    })

    const frames = deltas.slice(1)
    const mean = frames.reduce((sum, value) => sum + value, 0) / Math.max(1, frames.length)
    const sorted = [...frames].sort((a, b) => a - b)
    const percentile = (ratio: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0
    return {
      fps: Math.round((1000 / mean) * 10) / 10,
      frames: frames.length,
      seconds: Math.round((durationMs / 1000) * 10) / 10,
      p95FrameMs: Math.round(percentile(0.95) * 10) / 10,
      worstFrameMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
      over20ms: frames.filter((value) => value > 20).length,
      loaded: stats.loaded(),
      total: stats.total(),
      columns: stats.columns(),
    }
  }

  window.__worksBench = { start: run }
  return () => {
    delete window.__worksBench
  }
}
