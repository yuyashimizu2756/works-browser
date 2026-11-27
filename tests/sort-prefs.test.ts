import { beforeEach, describe, expect, it } from 'vitest'
import {
  defaultDirFor,
  defaultFileDirFor,
  flipDir,
  isSortDir,
  isSortKey,
  readSortPreference,
  writeSortPreference,
} from '../src/library/sortPrefs'

describe('#59 並び順の設定', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('キーごとの既定の向き', () => {
    expect(defaultDirFor('mtime')).toBe('desc')
    expect(defaultDirFor('created')).toBe('desc')
    expect(defaultDirFor('title')).toBe('asc')
  })

  it('保存した並び順を復元する', () => {
    writeSortPreference('size', 'asc')
    const pref = readSortPreference()
    expect(pref.sort).toBe('size')
    expect(pref.dir).toBe('asc')
  })

  it('壊れた値は既定にフォールバックする', () => {
    window.localStorage.setItem('works-browser.sort', '{oops')
    const pref = readSortPreference()
    expect(pref.sort).toBe('mtime')
    expect(pref.dir).toBe('desc')
  })

  it('未知のキーは無効として扱う', () => {
    expect(isSortKey('nope')).toBe(false)
    expect(isSortKey('created')).toBe(true)
    expect(isSortDir('up')).toBe(false)
  })

  it('向きを反転できる', () => {
    expect(flipDir('asc')).toBe('desc')
    expect(flipDir('desc')).toBe('asc')
  })

  it('ファイルモードもキーごとの既定の向きを持つ（#87）', () => {
    expect(defaultFileDirFor('mtime')).toBe('desc')
    expect(defaultFileDirFor('name')).toBe('asc')
    expect(defaultFileDirFor('size')).toBe('desc')
    expect(defaultFileDirFor('duration')).toBe('desc')
  })
})
