import { describe, expect, it } from 'vitest'
import { sortFiles, sortWorks } from '../src/lib/sort'
import { makeFile, makeWork } from './fixtures'

const works = [
  makeWork({ id: 1, title: 'B作品', total_bytes: 300, file_count: 2, mtime: 100 }),
  makeWork({ id: 2, title: 'A作品', total_bytes: 500, file_count: 9, mtime: 300 }),
  makeWork({ id: 3, title: 'C作品', total_bytes: 100, file_count: 1, mtime: 200 }),
]

describe('sortWorks', () => {
  it('mtime は新しい順', () => {
    expect(sortWorks(works, 'mtime').map((work) => work.id)).toEqual([2, 3, 1])
  })

  it('title は名前順', () => {
    expect(sortWorks(works, 'title').map((work) => work.id)).toEqual([2, 1, 3])
  })

  it('size は大きい順', () => {
    expect(sortWorks(works, 'size').map((work) => work.id)).toEqual([2, 1, 3])
  })

  it('files はファイル数が多い順', () => {
    expect(sortWorks(works, 'files').map((work) => work.id)).toEqual([2, 1, 3])
  })

  it('元の配列を変更しない', () => {
    const before = works.map((work) => work.id)
    sortWorks(works, 'size')
    expect(works.map((work) => work.id)).toEqual(before)
  })

  it('last_opened は最終閲覧が新しい順で、未開封は末尾', () => {
    const opened = new Map([
      [1, 500],
      [2, 900],
    ])
    expect(
      sortWorks(works, 'last_opened', { lastOpened: (id) => opened.get(id) ?? null }).map(
        (work) => work.id,
      ),
    ).toEqual([2, 1, 3])
  })

  it('open_count は開封回数の多い順', () => {
    const counts = new Map([
      [1, 3],
      [2, 7],
    ])
    expect(
      sortWorks(works, 'open_count', { openCount: (id) => counts.get(id) ?? 0 }).map(
        (work) => work.id,
      ),
    ).toEqual([2, 1, 3])
  })
})

const files = [
  makeFile({ id: 1, name: 'b.png', bytes: 300, mtime: 100, duration_ms: null }),
  makeFile({ id: 2, name: 'a.mp4', bytes: 900, mtime: 300, duration_ms: 5_000 }),
  makeFile({ id: 3, name: 'c.mp4', bytes: 100, mtime: 200, duration_ms: 30_000 }),
]

describe('sortFiles', () => {
  it('name は名前順', () => {
    expect(sortFiles(files, 'name').map((file) => file.id)).toEqual([2, 1, 3])
  })

  it('size は大きい順', () => {
    expect(sortFiles(files, 'size').map((file) => file.id)).toEqual([2, 1, 3])
  })

  it('duration は長い順で、null は末尾', () => {
    expect(sortFiles(files, 'duration').map((file) => file.id)).toEqual([3, 2, 1])
  })

  it('mtime は新しい順', () => {
    expect(sortFiles(files, 'mtime').map((file) => file.id)).toEqual([2, 3, 1])
  })
})
