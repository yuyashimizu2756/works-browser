import { describe, expect, it } from 'vitest'
import {
  marqueeSelect,
  selectAllWorks,
  selectedBytes,
  selectWorks,
} from '../src/lib/selection'
import { makeFile, makeWork } from './fixtures'

const works = [1, 2, 3, 4].map((id) => makeWork({ id }))
const none = { ctrl: false, shift: false }

describe('selectWorks', () => {
  it('素のクリックで 1 件だけ選択する', () => {
    const result = selectWorks(new Map(), works[1], none, works, null)
    expect([...result.selection.keys()]).toEqual([2])
    expect(result.anchorId).toBe(2)
  })

  it('選択済みをもう一度クリックすると解除する', () => {
    const first = selectWorks(new Map(), works[0], none, works, null)
    const second = selectWorks(first.selection, works[0], none, works, first.anchorId)
    expect(second.selection.size).toBe(0)
    expect(second.anchorId).toBe(1)
  })

  it('Ctrl+クリックで既存の選択を保ったまま追加する', () => {
    const first = selectWorks(new Map(), works[0], none, works, null)
    const second = selectWorks(
      first.selection,
      works[2],
      { ctrl: true, shift: false },
      works,
      first.anchorId,
    )
    expect([...second.selection.keys()]).toEqual([1, 3])
  })

  it('Shift+クリックでアンカーから範囲選択する', () => {
    const first = selectWorks(new Map(), works[0], none, works, null)
    const second = selectWorks(
      first.selection,
      works[2],
      { ctrl: false, shift: true },
      works,
      first.anchorId,
    )
    expect([...second.selection.keys()]).toEqual([1, 2, 3])
    // 範囲選択ではアンカーを動かさない
    expect(second.anchorId).toBe(1)
  })

  it('Shift+Ctrl で範囲を既存の選択に足す', () => {
    const base = new Map([[4, works[3]]])
    const result = selectWorks(base, works[1], { ctrl: true, shift: true }, works, 3)
    expect([...result.selection.keys()]).toEqual([4, 2, 3])
  })

  it('アンカーが無い Shift は単体トグルとして扱う', () => {
    const result = selectWorks(new Map(), works[1], { ctrl: false, shift: true }, works, null)
    expect([...result.selection.keys()]).toEqual([2])
  })

  it('アンカーが読み込み済み範囲の外なら単体トグルに落とす', () => {
    const result = selectWorks(new Map(), works[1], { ctrl: false, shift: true }, works, 99)
    expect([...result.selection.keys()]).toEqual([2])
  })

  it('元の Map を変更しない', () => {
    const base = new Map([[1, works[0]]])
    selectWorks(base, works[1], none, works, 1)
    expect([...base.keys()]).toEqual([1])
  })
})

describe('selectAllWorks', () => {
  it('全件を選択する', () => {
    const all = selectAllWorks(works)
    expect([...all.keys()]).toEqual([1, 2, 3, 4])
    expect(all.get(3)).toBe(works[2])
  })

  it('空配列では空の Map', () => {
    expect(selectAllWorks([]).size).toBe(0)
  })
})

describe('marqueeSelect', () => {
  it('additive=false では置き換える', () => {
    const current = new Map([[1, works[0]]])
    const next = marqueeSelect(current, [works[2], works[3]], false)
    expect([...next.keys()]).toEqual([3, 4])
  })

  it('additive=true では既存に足す', () => {
    const current = new Map([[1, works[0]]])
    const next = marqueeSelect(current, [works[2]], true)
    expect([...next.keys()]).toEqual([1, 3])
  })
})

describe('selectedBytes', () => {
  it('作品は total_bytes、ファイルは bytes を合計する', () => {
    const selection = new Map([
      [1, makeWork({ id: 1, total_bytes: 1_024 })],
      [2, makeWork({ id: 2, total_bytes: 2_048 })],
    ])
    expect(selectedBytes(selection)).toBe(3_072)
    const files = new Map([
      [1, makeFile({ id: 1, bytes: 10 })],
      [2, makeFile({ id: 2, bytes: 32 })],
    ])
    expect(selectedBytes(files)).toBe(42)
  })
})
