import { describe, expect, it } from 'vitest'
import { rowsPerScreen, wantsNextPage } from '../src/lib/prefetch'

describe('rowsPerScreen', () => {
  it('viewport の高さを行の高さで割って切り上げる', () => {
    expect(rowsPerScreen(800, 200)).toBe(4)
    expect(rowsPerScreen(801, 200)).toBe(5)
  })

  it('未計測（0）のときは 600px ぶんの行数で見積もる', () => {
    expect(rowsPerScreen(0, 200)).toBe(3)
  })

  it('行の高さが 0 でも 1 以上を返す', () => {
    expect(rowsPerScreen(800, 0)).toBe(800)
    expect(rowsPerScreen(0, 0)).toBe(600)
  })
})

describe('wantsNextPage', () => {
  const base = { columns: 6, rowsAhead: 12 }

  it('末尾から 2 画面より手前では要求しない', () => {
    // 最終行 10、残り 12 行 → 22 行目まで見ている。600 件なら 100 行。
    expect(wantsNextPage({ ...base, lastRowIndex: 10, loaded: 600 })).toBe(false)
  })

  it('残り 2 画面に入ったら要求する', () => {
    // 100 行 - 12 行 = 88 行目で 600 件の末尾に届く
    expect(wantsNextPage({ ...base, lastRowIndex: 88, loaded: 600 })).toBe(true)
    expect(wantsNextPage({ ...base, lastRowIndex: 89, loaded: 600 })).toBe(true)
  })

  it('末端の 1 行手前でも当然要求する', () => {
    expect(wantsNextPage({ ...base, lastRowIndex: 99, loaded: 600 })).toBe(true)
  })

  it('読み込み前（loaded = 0）は要求しない', () => {
    expect(wantsNextPage({ ...base, lastRowIndex: 0, loaded: 0 })).toBe(false)
  })

  it('列数が不正でも落ちない', () => {
    expect(wantsNextPage({ ...base, lastRowIndex: 5, loaded: 600, columns: 0 })).toBe(false)
  })

  it('コンパクトリスト（1 列）でも同じ判定になる', () => {
    expect(wantsNextPage({ columns: 1, rowsAhead: 30, lastRowIndex: 10, loaded: 600 })).toBe(false)
    expect(wantsNextPage({ columns: 1, rowsAhead: 30, lastRowIndex: 570, loaded: 600 })).toBe(true)
  })
})
