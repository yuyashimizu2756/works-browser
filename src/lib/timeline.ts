import type { WorkSummary } from '../api'

/**
 * タイムライン（日別）ビューの日付グルーピング（#81）。
 *
 * `mtime` は UNIX ミリ秒なので、**ローカル時刻の年月日**へ落としてから日別にまとめる。
 * `toLocaleDateString` は環境（ICU / ロケール）で書式が変わるうえ、`toISOString` は
 * UTC なので深夜の作品が前日にずれる。ここでは `Date` のローカル getter だけで
 * `YYYY-MM-DD` を組み立て、タイムゾーンに依存しない形にする。
 *
 * UI（`src/library/TimelineView.tsx`）はこの結果を描画するだけで、日付の判断は持たない。
 */

/** 日曜始まり（`Date#getDay()` の並び）。 */
export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

export type TimelineSection = {
  /** ローカル日付 `YYYY-MM-DD`。セクションのキーにも使う。 */
  dateKey: string
  /** `Date#getDay()`（0 = 日曜）。 */
  weekday: number
  /** 見出し用の `2026-11-26（木）`。 */
  label: string
  /** その日の作品数。 */
  count: number
  /** その日の作品（`mtime` の新しい順）。 */
  works: WorkSummary[]
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** UNIX ミリ秒 → ローカル日付 `YYYY-MM-DD`。 */
export function localDateKey(ms: number): string {
  const date = new Date(ms)
  const year = String(date.getFullYear()).padStart(4, '0')
  return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** UNIX ミリ秒 → ローカルの曜日（0 = 日曜）。 */
export function localWeekday(ms: number): number {
  return new Date(ms).getDay()
}

/** UNIX ミリ秒 → `木` などの曜日 1 文字。 */
export function weekdayLabel(ms: number): string {
  return WEEKDAY_JA[localWeekday(ms)]
}

/** `2026-11-26（木）・N 件`。見出しの表示文字列を 1 か所にまとめる。 */
export function timelineHeading(section: Pick<TimelineSection, 'label' | 'count'>): string {
  return `${section.label}・${section.count} 件`
}

/**
 * 作品をローカル日付ごとにまとめ、日付の新しい順に返す。
 *
 * - 日付セクションは `YYYY-MM-DD` の降順（年またぎ・月またぎも文字列比較で正しい）
 * - 同じ日の中は `mtime` の新しい順
 * - 空配列は空配列（呼び出し側で空状態を出す）
 */
export function groupWorksByDay(works: readonly WorkSummary[]): TimelineSection[] {
  const groups = new Map<string, WorkSummary[]>()
  for (const work of works) {
    const dateKey = localDateKey(work.mtime)
    const existing = groups.get(dateKey)
    if (existing) existing.push(work)
    else groups.set(dateKey, [work])
  }

  return [...groups.entries()]
    .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
    .map(([dateKey, dayWorks]) => {
      const sorted = [...dayWorks].sort((left, right) => right.mtime - left.mtime)
      const weekday = localWeekday(sorted[0].mtime)
      return {
        dateKey,
        weekday,
        label: `${dateKey}（${WEEKDAY_JA[weekday]}）`,
        count: sorted.length,
        works: sorted,
      }
    })
}
