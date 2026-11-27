import { describe, expect, it } from 'vitest'
import {
  buildSmartFolderQuery,
  normalizeMinRating,
  parseSmartFolderQuery,
  smartFolderMatches,
  stringifySmartFolderQuery,
} from '../src/library/smartFolders'

describe('#69 スマートフォルダの条件 JSON', () => {
  it('検索語を trim し、指定が無ければ既定値で組み立てる', () => {
    expect(buildSmartFolderQuery()).toEqual({
      search: '',
      kind: 'all',
      rootId: null,
      tagId: null,
      minRating: null,
      favorite: false,
      metaSearch: false,
      sort: 'mtime',
      dir: 'desc',
    })
    expect(buildSmartFolderQuery({ search: '  海  ' }).search).toBe('海')
  })

  it('すべての保存対象（検索語・種類・ルート・タグ・評価・お気に入り・生成情報・並び順・昇降）を持つ', () => {
    const query = buildSmartFolderQuery({
      search: 'night',
      kind: 'video',
      rootId: 3,
      tagId: 7,
      minRating: 4,
      favorite: true,
      metaSearch: true,
      sort: 'title',
      dir: 'asc',
    })
    expect(query).toEqual({
      search: 'night',
      kind: 'video',
      rootId: 3,
      tagId: 7,
      minRating: 4,
      favorite: true,
      metaSearch: true,
      sort: 'title',
      dir: 'asc',
    })
  })

  it('知らない値・範囲外の値は既定へ丸める', () => {
    const query = buildSmartFolderQuery({
      kind: 'audio',
      sort: 'random',
      dir: 'up',
      rootId: -1,
      tagId: Number.NaN,
      minRating: 9,
    })
    expect(query.kind).toBe('all')
    expect(query.sort).toBe('mtime')
    expect(query.dir).toBe('desc')
    expect(query.rootId).toBeNull()
    expect(query.tagId).toBeNull()
    expect(query.minRating).toBeNull()
  })

  it('最低評価は 1〜5 の整数だけ受け付ける', () => {
    expect(normalizeMinRating(5)).toBe(5)
    expect(normalizeMinRating(1)).toBe(1)
    expect(normalizeMinRating(0)).toBeNull()
    expect(normalizeMinRating(6)).toBeNull()
    expect(normalizeMinRating(3.9)).toBe(3)
    expect(normalizeMinRating('4')).toBeNull()
  })

  it('JSON 文字列との往復で内容が変わらない', () => {
    const query = buildSmartFolderQuery({
      search: 'プロンプト',
      kind: 'image',
      rootId: 2,
      tagId: 5,
      minRating: 3,
      favorite: true,
      metaSearch: true,
      sort: 'size',
      dir: 'asc',
    })
    expect(parseSmartFolderQuery(stringifySmartFolderQuery(query))).toEqual(query)
  })

  it('壊れた JSON・配列・古い形式は条件なしとして読む', () => {
    const empty = buildSmartFolderQuery()
    expect(parseSmartFolderQuery('{oops')).toEqual(empty)
    expect(parseSmartFolderQuery('[1,2,3]')).toEqual(empty)
    expect(parseSmartFolderQuery('null')).toEqual(empty)
    // キーが足りない保存値（将来の項目追加を想定）も既定で補う
    expect(parseSmartFolderQuery('{"search":"a"}')).toEqual({
      ...empty,
      search: 'a',
    })
  })

  it('保存した条件といまの条件が完全一致したときだけ「適用中」になる', () => {
    const saved = buildSmartFolderQuery({ search: 'a', kind: 'video', minRating: 4 })
    expect(smartFolderMatches(saved, buildSmartFolderQuery({ search: ' a ', kind: 'video', minRating: 4 }))).toBe(
      true,
    )
    expect(smartFolderMatches(saved, buildSmartFolderQuery({ search: 'a', kind: 'video' }))).toBe(
      false,
    )
    expect(
      smartFolderMatches(saved, buildSmartFolderQuery({ search: 'a', kind: 'video', minRating: 3 })),
    ).toBe(false)
  })
})
