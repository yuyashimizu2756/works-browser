import { describe, expect, it } from 'vitest'
import {
  applyWatchChanged,
  clearBadge,
  pendingBadges,
  pendingNet,
  totalBadges,
} from '../src/library/watchBadges'

const CHANGE = { root_id: 1, added: 0, removed: 0, rescan: false }

describe('#63 新着バッジ', () => {
  it('added - removed を 0 未満にしない', () => {
    expect(pendingNet({ added: 3, removed: 1 })).toBe(2)
    expect(pendingNet({ added: 1, removed: 5 })).toBe(0)
  })

  it('watch_pending の戻り値を root_id → 件数にする', () => {
    const badges = pendingBadges([
      { root_id: 2, added: 4, removed: 1 },
      { root_id: 5, added: 2, removed: 2 },
    ])
    expect([...badges.entries()]).toEqual([[2, 3]])
    expect(totalBadges(badges)).toBe(3)
  })

  it('イベントの増分を足し、削除が上回ったら消す', () => {
    let badges = new Map<number, number>([[1, 2]])
    badges = applyWatchChanged(badges, { ...CHANGE, root_id: 1, added: 3 })
    expect(badges.get(1)).toBe(5)

    badges = applyWatchChanged(badges, { ...CHANGE, root_id: 1, removed: 1 })
    expect(badges.get(1)).toBe(4)

    badges = applyWatchChanged(badges, { ...CHANGE, root_id: 1, removed: 9 })
    expect(badges.has(1)).toBe(false)
    expect(totalBadges(badges)).toBe(0)
  })

  it('別ルートのイベントはそのルートだけに足す', () => {
    const badges = applyWatchChanged(new Map([[1, 2]]), {
      ...CHANGE,
      root_id: 2,
      added: 1,
    })
    expect(badges.get(1)).toBe(2)
    expect(badges.get(2)).toBe(1)
  })

  it('クリアで 0 に戻る', () => {
    const badges = clearBadge(new Map([[1, 7]]), 1)
    expect(badges.has(1)).toBe(false)
    expect(badges.size).toBe(0)
  })

  it('変わらないイベントでは同じ Map を返す', () => {
    const badges = new Map([[1, 2]])
    expect(applyWatchChanged(badges, CHANGE)).toBe(badges)
    expect(clearBadge(badges, 99)).toBe(badges)
  })
})
