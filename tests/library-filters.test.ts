/**
 * #120: ライブラリの絞り込みを履歴へ写すための純関数。
 *
 * 「すべて」を選んだときにルートが片方だけ残る、空検索に戻したのに古い語が
 * 復活する、といった取りこぼしをここで固定する。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearWorkFilters,
  defaultLibraryFilters,
  sameLibraryFilters,
  withRootFilter,
} from '../src/library/libraryFilters'
import { defaultDirFor } from '../src/library/sortPrefs'

beforeEach(() => {
  window.localStorage.clear()
})

describe('#120 ライブラリの絞り込み', () => {
  it('初期値は空検索・すべて・並びは保存値（既定は更新日）', () => {
    const filters = defaultLibraryFilters()
    expect(filters).toMatchObject({
      search: '',
      kind: 'all',
      rootId: null,
      tagId: null,
      minRating: null,
      favorite: false,
      metaSearch: false,
      sort: 'mtime',
      sortDir: defaultDirFor('mtime'),
      fileRootId: null,
    })
  })

  it('ルート選択は作品モードとファイルモードの両方へ入り、「すべて」で両方戻る', () => {
    const selected = withRootFilter(defaultLibraryFilters(), 3)
    expect(selected.rootId).toBe(3)
    expect(selected.fileRootId).toBe(3)

    const cleared = withRootFilter(selected, null)
    expect(cleared.rootId).toBeNull()
    expect(cleared.fileRootId).toBeNull()
  })

  it('すべて解除は検索・種類・タグ・評価・お気に入り・生成情報を初期値へ戻す', () => {
    const populated = {
      ...defaultLibraryFilters(),
      search: 'プロンプト',
      kind: 'video' as const,
      rootId: 2,
      tagId: 5,
      minRating: 4,
      favorite: true,
      metaSearch: true,
      sort: 'title' as const,
      sortDir: 'asc' as const,
      fileRootId: 7,
    }

    const cleared = clearWorkFilters(populated)
    expect(cleared).toMatchObject({
      search: '',
      kind: 'all',
      rootId: null,
      tagId: null,
      minRating: null,
      favorite: false,
      metaSearch: false,
    })
    // 並び順とファイルモード側のルートは別操作なので保つ
    expect(cleared.sort).toBe('title')
    expect(cleared.sortDir).toBe('asc')
    expect(cleared.fileRootId).toBe(7)
  })

  it('内容の比較は全項目を見る（古い写しと取り違えない）', () => {
    const base = defaultLibraryFilters()
    expect(sameLibraryFilters(base, { ...base })).toBe(true)
    expect(sameLibraryFilters(base, { ...base, rootId: 1 })).toBe(false)
    expect(sameLibraryFilters(base, { ...base, fileRootId: 1 })).toBe(false)
    expect(sameLibraryFilters(base, { ...base, search: 'x' })).toBe(false)
  })
})
