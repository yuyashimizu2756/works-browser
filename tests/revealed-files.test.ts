import { describe, expect, it } from 'vitest'
import {
  resetRevealed,
  shouldRevealThumb,
  shouldRevealWorkThumb,
  toggleRevealedFile,
  toggleRevealedWork,
} from '../src/library/revealedFiles'

describe('#52 サムネ非表示中の一時表示', () => {
  it('全体ONで個別ONにすると、そのファイルだけ表示対象になる', () => {
    const revealed = toggleRevealedFile(new Set<number>(), 42)
    expect(revealed.has(42)).toBe(true)
    expect(shouldRevealThumb(true, revealed, 42)).toBe(true)
    expect(shouldRevealThumb(true, revealed, 43)).toBe(false)
  })

  it('もう一度トグルすると隠れる（元に戻る）', () => {
    let revealed = toggleRevealedFile(new Set<number>(), 42)
    revealed = toggleRevealedFile(revealed, 42)
    expect(revealed.has(42)).toBe(false)
    expect(shouldRevealThumb(true, revealed, 42)).toBe(false)
  })

  it('全体トグルを切り替えると個別状態はリセットされる', () => {
    const revealed = toggleRevealedFile(new Set<number>(), 42)
    const afterReset = resetRevealed()
    expect(revealed.size).toBe(1)
    expect(afterReset.size).toBe(0)
    expect(shouldRevealThumb(true, afterReset, 42)).toBe(false)
  })

  it('全体が表示（非表示でない）ときは個別の一時表示は効かない', () => {
    const revealed = toggleRevealedFile(new Set<number>(), 42)
    expect(shouldRevealThumb(false, revealed, 42)).toBe(false)
  })

  it('元の Set を破壊しない', () => {
    const original = new Set<number>([1])
    const next = toggleRevealedFile(original, 2)
    expect(original.has(2)).toBe(false)
    expect(next.has(2)).toBe(true)
    expect(next.has(1)).toBe(true)
  })

  // #121: 作品単位の個別表示もファイル版と同じ規則
  it('作品トグルはその作品だけ表示対象にし、再押下で戻る', () => {
    let revealed = toggleRevealedWork(new Set<number>(), 7)
    expect(revealed.has(7)).toBe(true)
    expect(shouldRevealWorkThumb(true, revealed, 7)).toBe(true)
    expect(shouldRevealWorkThumb(true, revealed, 8)).toBe(false)

    revealed = toggleRevealedWork(revealed, 7)
    expect(revealed.has(7)).toBe(false)
    expect(shouldRevealWorkThumb(true, revealed, 7)).toBe(false)
  })

  it('作品の個別表示も全体表示中は効かず、全体トグルでリセットされる', () => {
    const revealed = toggleRevealedWork(new Set<number>(), 7)
    expect(shouldRevealWorkThumb(false, revealed, 7)).toBe(false)

    const afterReset = resetRevealed()
    expect(afterReset.size).toBe(0)
    expect(shouldRevealWorkThumb(true, afterReset, 7)).toBe(false)
  })

  it('作品トグルも元の Set を破壊しない', () => {
    const original = new Set<number>([1])
    const next = toggleRevealedWork(original, 2)
    expect(original.has(2)).toBe(false)
    expect(next.has(2)).toBe(true)
    expect(next.has(1)).toBe(true)
  })
})
