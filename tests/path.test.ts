import { describe, expect, it } from 'vitest'
import { fileAbsolutePath, joinWindowsPath } from '../src/lib/path'

describe('joinWindowsPath', () => {
  it('ルートと相対パスを `\\` で繋ぐ', () => {
    expect(joinWindowsPath('D:\\Works', 'work-1\\001.png')).toBe('D:\\Works\\work-1\\001.png')
  })

  it('相対パスの `/` を `\\` に揃える（DB の保存形式が混在していてもよい）', () => {
    expect(joinWindowsPath('D:\\Works', 'work-1/001.png')).toBe('D:\\Works\\work-1\\001.png')
  })

  it('末尾・先頭の区切りが重複しても二重にならない', () => {
    expect(joinWindowsPath('D:\\Works\\', '\\work-1\\001.png')).toBe('D:\\Works\\work-1\\001.png')
  })

  it('相対パスが空ならルートだけを返す', () => {
    expect(joinWindowsPath('D:\\Works', '')).toBe('D:\\Works')
  })
})

describe('fileAbsolutePath', () => {
  it('ルートの実パスが分かれば絶対パスを作る', () => {
    expect(fileAbsolutePath('D:\\Works', 'work-1/001.png')).toBe('D:\\Works\\work-1\\001.png')
  })

  it('ベンチなどでルートが無いときは null（メニューを無効化する）', () => {
    expect(fileAbsolutePath(null, 'work-1/001.png')).toBeNull()
    expect(fileAbsolutePath(undefined, 'work-1/001.png')).toBeNull()
    expect(fileAbsolutePath('  ', 'work-1/001.png')).toBeNull()
  })
})
