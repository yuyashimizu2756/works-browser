/**
 * タグ・評価・開封回数の読み書き（#6）。
 *
 * 実アプリは Tauri コマンド（`api.ts`）を呼ぶ。ベンチモード（`?bench=`）だけは
 * `bench.ts` がメモリ内の実装を差し込むため、UI はこの入口だけを使う。
 */
import { api } from '../api'
import type { Tag, TagSuggestion, WorkMark } from '../api'

export type TagData = {
  listTags: () => Promise<Tag[]>
  createTag: (name: string, color: string) => Promise<Tag>
  deleteTag: (tagId: number) => Promise<void>
  getWorkTags: (workId: number) => Promise<Tag[]>
  setWorkTags: (workId: number, tagIds: number[]) => Promise<Tag[]>
  /** #79: 生成情報の頻出語からタグ候補（生成情報が無ければ空配列）。 */
  tagSuggestions: (workId: number, limit?: number) => Promise<TagSuggestion[]>
  getWorkMark: (workId: number) => Promise<WorkMark>
  setWorkMark: (
    workId: number,
    mark: { favorite: boolean; rating: number | null; note?: string | null },
  ) => Promise<WorkMark>
  recordOpen: (workId: number) => Promise<WorkMark>
}

const dbTagData: TagData = {
  listTags: () => api.listTags(),
  createTag: (name, color) => api.createTag(name, color),
  deleteTag: (tagId) => api.deleteTag(tagId),
  getWorkTags: (workId) => api.getWorkTags(workId),
  setWorkTags: (workId, tagIds) => api.setWorkTags(workId, tagIds),
  tagSuggestions: (workId, limit) => api.tagSuggestions(workId, limit),
  getWorkMark: (workId) => api.getWorkMark(workId),
  setWorkMark: (workId, mark) => api.setWorkMark(workId, mark),
  recordOpen: (workId) => api.recordOpen(workId),
}

let override: TagData | null = null
const listeners = new Set<() => void>()

/** 現在の供給元（実アプリは Tauri、ベンチはメモリ）。 */
export function tagData(): TagData {
  return override ?? dbTagData
}

/** ベンチモードからメモリ実装を差し込む。`null` で既定へ戻す。 */
export function setTagData(next: TagData | null): void {
  override = next
}

/** タグ・評価が変わったことを購読者（フィルタのチップなど）へ知らせる。 */
export function notifyTagsChanged(): void {
  for (const listener of listeners) listener()
}

/** #71: キーボード評価など、別コンポーネントから評価を変えたことを知らせるイベント名。 */
export const MARK_CHANGED_EVENT = 'works-browser:mark-changed'

/** #71: 作品 1 件の評価・お気に入りが変わったことをヘッダ（WorkMarksBar）へ知らせる。 */
export function notifyMarkChanged(workId: number): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(MARK_CHANGED_EVENT, { detail: { workId } }))
}

export function subscribeTags(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 未設定作品の既定値（Tauri 側 `WorkMark` と同じ形）。 */
export function emptyMark(workId: number): WorkMark {
  return {
    work_id: workId,
    favorite: false,
    rating: null,
    note: null,
    last_opened_at: null,
    open_count: 0,
  }
}
