import { describe, expect, it } from 'vitest'
import { makeWork } from './fixtures'
import {
  groupWorksByDay,
  localDateKey,
  localWeekday,
  timelineHeading,
  WEEKDAY_JA,
  weekdayLabel,
} from '../src/lib/timeline'

/** ローカル時刻で日時を作る（`Date.UTC` は使わない）。 */
function local(
  year: number,
  monthIndex: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
): number {
  return new Date(year, monthIndex, day, hour, minute, second).getTime()
}

describe('localDateKey', () => {
  it('ローカルの年月日を YYYY-MM-DD で返す', () => {
    expect(localDateKey(local(2026, 10, 26))).toBe('2026-11-26')
    expect(localDateKey(local(2026, 0, 1))).toBe('2026-01-01')
    expect(localDateKey(local(2026, 11, 31))).toBe('2026-12-31')
  })

  it('同じローカル日の 00:05 と 23:55 は同じキーになる（UTC に落とさない）', () => {
    // UTC 基準にすると、負のオフセットでは 23:55 が翌日、正のオフセットでは
    // 00:05 が前日になる。ローカル getter ならどちらも同じ日。
    const early = local(2026, 0, 1, 0, 5)
    const late = local(2026, 0, 1, 23, 55)
    expect(localDateKey(early)).toBe('2026-01-01')
    expect(localDateKey(late)).toBe('2026-01-01')
    expect(localDateKey(early)).toBe(localDateKey(late))
  })

  it('0 埋めする（1 桁の月・日）', () => {
    expect(localDateKey(local(2026, 0, 5))).toBe('2026-01-05')
    expect(localDateKey(local(2026, 8, 9))).toBe('2026-09-09')
  })
})

describe('曜日', () => {
  it('ローカルの曜日を返す', () => {
    // 2026-11-26 は木曜日
    expect(localWeekday(local(2026, 10, 26))).toBe(4)
    expect(weekdayLabel(local(2026, 10, 26))).toBe('木')
    expect(WEEKDAY_JA[localWeekday(local(2026, 0, 1))]).toBe('木')
    expect(weekdayLabel(local(2025, 11, 31))).toBe('水')
  })
})

describe('timelineHeading', () => {
  it('「YYYY-MM-DD（曜）・N 件」の形にする', () => {
    expect(
      timelineHeading({ label: '2026-11-26（木）', count: 12 }),
    ).toBe('2026-11-26（木）・12 件')
    expect(timelineHeading({ label: '2026-01-01（木）', count: 1 })).toBe(
      '2026-01-01（木）・1 件',
    )
  })
})

describe('groupWorksByDay', () => {
  it('空配列は空配列', () => {
    expect(groupWorksByDay([])).toEqual([])
  })

  it('同じ日の複数作品を 1 セクションにまとめ、mtime の新しい順に並べる', () => {
    const works = [
      makeWork({ id: 1, mtime: local(2026, 10, 26, 9) }),
      makeWork({ id: 2, mtime: local(2026, 10, 26, 18) }),
      makeWork({ id: 3, mtime: local(2026, 10, 26, 12) }),
    ]
    const sections = groupWorksByDay(works)
    expect(sections).toHaveLength(1)
    expect(sections[0].dateKey).toBe('2026-11-26')
    expect(sections[0].weekday).toBe(4)
    expect(sections[0].label).toBe('2026-11-26（木）')
    expect(sections[0].count).toBe(3)
    expect(sections[0].works.map((work) => work.id)).toEqual([2, 3, 1])
  })

  it('月をまたぐと別セクションになり、新しい月が先', () => {
    const works = [
      makeWork({ id: 1, mtime: local(2026, 0, 31, 23, 59, 59) }),
      makeWork({ id: 2, mtime: local(2026, 1, 1, 0, 0, 1) }),
    ]
    const sections = groupWorksByDay(works)
    expect(sections.map((section) => section.dateKey)).toEqual(['2026-02-01', '2026-01-31'])
    expect(sections.map((section) => section.count)).toEqual([1, 1])
  })

  it('年をまたぐと別セクションになり、新しい年が先', () => {
    const works = [
      makeWork({ id: 1, mtime: local(2025, 11, 31, 23, 59, 59) }),
      makeWork({ id: 2, mtime: local(2026, 0, 1, 0, 0, 1) }),
    ]
    const sections = groupWorksByDay(works)
    expect(sections.map((section) => section.dateKey)).toEqual(['2026-01-01', '2025-12-31'])
    expect(sections[0].weekday).toBe(4)
    expect(sections[1].weekday).toBe(3)
  })

  it('入力が日付順でなくても、セクションは新しい順に並ぶ', () => {
    const works = [
      makeWork({ id: 1, mtime: local(2026, 10, 24) }),
      makeWork({ id: 2, mtime: local(2026, 10, 26) }),
      makeWork({ id: 3, mtime: local(2026, 10, 25) }),
      makeWork({ id: 4, mtime: local(2026, 10, 26, 8) }),
    ]
    const sections = groupWorksByDay(works)
    expect(sections.map((section) => section.dateKey)).toEqual([
      '2026-11-26',
      '2026-11-25',
      '2026-11-24',
    ])
    expect(sections[0].works.map((work) => work.id)).toEqual([2, 4])
    expect(sections[0].count).toBe(2)
  })

  it('同じ mtime の作品は入力順を保つ（安定ソート）', () => {
    const mtime = local(2026, 10, 26, 10)
    const sections = groupWorksByDay([
      makeWork({ id: 1, mtime }),
      makeWork({ id: 2, mtime }),
    ])
    expect(sections[0].works.map((work) => work.id)).toEqual([1, 2])
  })
})
