import { describe, expect, it } from 'vitest'
import {
  EMPTY_SEARCH_QUERY,
  emptyPreviewFromUrl,
  initialSearchFromUrl,
} from '../src/lib/emptyState'

describe('#100 空状態の URL', () => {
  it('?empty=roots|smart|search|thumbs だけを受け付ける', () => {
    expect(emptyPreviewFromUrl('?bench=24&empty=roots')).toBe('roots')
    expect(emptyPreviewFromUrl('?bench=24&empty=smart')).toBe('smart')
    expect(emptyPreviewFromUrl('?bench=24&empty=search')).toBe('search')
    expect(emptyPreviewFromUrl('?bench=24&empty=thumbs')).toBe('thumbs')
    expect(emptyPreviewFromUrl('?bench=24&empty=unknown')).toBeNull()
    expect(emptyPreviewFromUrl('?bench=24')).toBeNull()
  })

  it('検索語は ?q= で渡せて、空文字は null', () => {
    expect(initialSearchFromUrl('?q=night')).toBe('night')
    expect(initialSearchFromUrl('?q=')).toBeNull()
    expect(initialSearchFromUrl('?q=%20%20')).toBeNull()
    expect(initialSearchFromUrl('?bench=24')).toBeNull()
  })

  it('検索 0 件用の語はどのベンチ作品にも一致しない', () => {
    expect(EMPTY_SEARCH_QUERY).not.toBe('')
    expect(EMPTY_SEARCH_QUERY.toLowerCase()).not.toContain('bench work')
  })
})
