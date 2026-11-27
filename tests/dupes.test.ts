import { describe, expect, it } from 'vitest'

import type { DupGroup } from '@/api'
import { keeperOf, removalIds, totalWasted, wastedBytes } from '@/library/dupes'

function file(id: number, bytes: number, keeper = false) {
  return {
    id,
    work_id: 1,
    name: `${id}.png`,
    rel_path: `${id}.png`,
    kind: 'image' as const,
    bytes,
    width: 1024,
    height: 1024,
    mtime: id,
    keeper,
  }
}

const group: DupGroup = {
  key: 'exact:abc',
  files: [file(1, 300, true), file(2, 200), file(3, 100)],
  total_bytes: 600,
  wasted_bytes: 300,
}

describe('dupes helpers', () => {
  it('keeps the file Rust marked as keeper', () => {
    expect(keeperOf(group)?.id).toBe(1)
    expect(removalIds(group)).toEqual([2, 3])
    expect(wastedBytes(group)).toBe(300)
  })

  it('lets the user pick another keeper', () => {
    expect(keeperOf(group, 3)?.id).toBe(3)
    expect(removalIds(group, 3)).toEqual([1, 2])
    expect(wastedBytes(group, 3)).toBe(500)
  })

  it('falls back when the override is not in the group', () => {
    expect(keeperOf(group, 999)?.id).toBe(1)
    expect(removalIds(group, 999)).toEqual([2, 3])
  })

  it('sums wasted bytes across groups', () => {
    const other: DupGroup = {
      key: 'similar:def',
      files: [file(4, 50, true), file(5, 25)],
      total_bytes: 75,
      wasted_bytes: 25,
    }
    expect(totalWasted([group, other])).toBe(325)
  })

  it('returns nothing for an empty group', () => {
    expect(keeperOf({ key: 'x', files: [], total_bytes: 0, wasted_bytes: 0 })).toBeNull()
    expect(removalIds({ key: 'x', files: [], total_bytes: 0, wasted_bytes: 0 })).toEqual([])
  })
})
