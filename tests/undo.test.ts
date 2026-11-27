import { describe, expect, it } from 'vitest'
import {
  startUndo,
  tickUndo,
  undoExpired,
  undoProgress,
  undoSeconds,
} from '../src/lib/undo'

describe('Undo のカウントダウン', () => {
  it('開始時は猶予いっぱい', () => {
    const state = startUndo(5_000)
    expect(state).toEqual({ remainingMs: 5_000, totalMs: 5_000 })
    expect(undoSeconds(state)).toBe(5)
    expect(undoExpired(state)).toBe(false)
    expect(undoProgress(state)).toBe(0)
  })

  it('経過分だけ残りが減る', () => {
    const state = tickUndo(startUndo(5_000), 1_200)
    expect(state.remainingMs).toBe(3_800)
    expect(undoSeconds(state)).toBe(4)
    expect(undoProgress(state)).toBeCloseTo(0.24)
  })

  it('残り 0 未満にならない', () => {
    const state = tickUndo(startUndo(500), 10_000)
    expect(state.remainingMs).toBe(0)
    expect(undoExpired(state)).toBe(true)
    expect(undoSeconds(state)).toBe(0)
    expect(undoProgress(state)).toBe(1)
  })

  it('負の経過時間では減らない', () => {
    const state = tickUndo(startUndo(1_000), -500)
    expect(state.remainingMs).toBe(1_000)
  })

  it('0 秒開始は即期限切れ', () => {
    const state = startUndo(0)
    expect(undoExpired(state)).toBe(true)
    expect(undoProgress(state)).toBe(1)
  })
})
