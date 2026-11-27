import { describe, expect, it } from 'vitest'
import { filterFiles, filterWorks } from '../src/lib/filter'
import { makeFile, makeWork } from './fixtures'

const works = [
  makeWork({ id: 1, title: '夏の海', rel_path: 'trip/summer', kind: 'image', root_id: 1 }),
  makeWork({ id: 2, title: 'Night Drive', rel_path: 'trip/night', kind: 'video', root_id: 2 }),
  makeWork({ id: 3, title: '混在セット', rel_path: 'studio/mix', kind: 'mixed', root_id: 2 }),
]

describe('filterWorks', () => {
  it('タイトルの部分一致（大文字小文字を無視）', () => {
    expect(filterWorks(works, { search: 'night' }).map((work) => work.id)).toEqual([2])
  })

  it('作品パスでも一致する', () => {
    expect(filterWorks(works, { search: 'studio' }).map((work) => work.id)).toEqual([3])
  })

  it('前後の空白は無視する', () => {
    expect(filterWorks(works, { search: '  海  ' }).map((work) => work.id)).toEqual([1])
  })

  it('kind=video は動画あり（混在を含む）', () => {
    expect(filterWorks(works, { kind: 'video' }).map((work) => work.id)).toEqual([2, 3])
  })

  it('kind=image は画像のみ', () => {
    expect(filterWorks(works, { kind: 'image' }).map((work) => work.id)).toEqual([1])
  })

  it('ルートで絞り込む', () => {
    expect(filterWorks(works, { rootId: 2 }).map((work) => work.id)).toEqual([2, 3])
  })

  it('検索・種類・ルートを組み合わせる', () => {
    expect(
      filterWorks(works, { search: 'trip', kind: 'video', rootId: 2 }).map((work) => work.id),
    ).toEqual([2])
  })

  it('一致しなければ空配列', () => {
    expect(filterWorks(works, { search: '存在しない' })).toEqual([])
  })

  it('元の配列を変更しない', () => {
    filterWorks(works, { kind: 'image' })
    expect(works).toHaveLength(3)
  })
})

const files = [
  makeFile({ id: 1, name: 'cover.png', rel_path: 'a/cover.png', kind: 'image', root_id: 1, work_id: 1 }),
  makeFile({ id: 2, name: 'clip.mp4', rel_path: 'a/clip.mp4', kind: 'video', root_id: 1, work_id: 1 }),
  makeFile({ id: 3, name: 'other.mp4', rel_path: 'b/other.mp4', kind: 'video', root_id: 2, work_id: 2 }),
]

describe('filterFiles', () => {
  it('ファイル名 / 相対パスで検索する', () => {
    expect(filterFiles(files, { search: 'cover' }).map((file) => file.id)).toEqual([1])
    expect(filterFiles(files, { search: 'b/' }).map((file) => file.id)).toEqual([3])
  })

  it('種類で絞り込む', () => {
    expect(filterFiles(files, { kind: 'video' }).map((file) => file.id)).toEqual([2, 3])
    expect(filterFiles(files, { kind: 'image' }).map((file) => file.id)).toEqual([1])
  })

  it('all は絞り込まない', () => {
    expect(filterFiles(files, { kind: 'all' })).toHaveLength(3)
  })

  it('ルートと作品で絞り込む', () => {
    expect(filterFiles(files, { rootId: 2 }).map((file) => file.id)).toEqual([3])
    expect(filterFiles(files, { workId: 1 }).map((file) => file.id)).toEqual([1, 2])
  })
})
