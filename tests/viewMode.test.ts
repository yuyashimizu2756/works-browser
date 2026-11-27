import { describe, expect, it } from 'vitest'
import {
  initialShieldFromUrl,
  initialThumbnailsFromUrl,
  initialViewModeFromUrl,
  nextViewMode,
  VIEW_MODE_LABEL,
  VIEW_MODE_SHORTCUT,
} from '../src/lib/viewMode'

describe('nextViewMode', () => {
  it('works → files → timeline → works の順に切り替える', () => {
    expect(nextViewMode('works')).toBe('files')
    expect(nextViewMode('files')).toBe('timeline')
    expect(nextViewMode('timeline')).toBe('works')
    expect(nextViewMode(nextViewMode(nextViewMode('works')))).toBe('works')
  })
})

describe('URL からの初期値（ベンチ / headless 用）', () => {
  it('?mode= は works / files / timeline を受け付ける', () => {
    expect(initialViewModeFromUrl('?mode=files')).toBe('files')
    expect(initialViewModeFromUrl('?mode=works')).toBe('works')
    expect(initialViewModeFromUrl('?mode=timeline')).toBe('timeline')
    expect(initialViewModeFromUrl('?mode=other')).toBeNull()
    expect(initialViewModeFromUrl('')).toBeNull()
  })

  it('?thumbs= は hidden / shown の別名も受ける', () => {
    expect(initialThumbnailsFromUrl('?thumbs=hidden')).toBe(false)
    expect(initialThumbnailsFromUrl('?thumbs=0')).toBe(false)
    expect(initialThumbnailsFromUrl('?thumbs=shown')).toBe(true)
    expect(initialThumbnailsFromUrl('?thumbs=1')).toBe(true)
    expect(initialThumbnailsFromUrl('')).toBeNull()
  })

  it('?shield= は見た目の上書きも返す', () => {
    expect(initialShieldFromUrl('?shield=1')).toEqual({ active: true, appearance: null })
    expect(initialShieldFromUrl('?shield=plain')).toEqual({ active: true, appearance: 'plain' })
    expect(initialShieldFromUrl('?shield=files')).toEqual({ active: true, appearance: 'files' })
    expect(initialShieldFromUrl('')).toEqual({ active: false, appearance: null })
  })
})

describe('表示ラベル', () => {
  it('全モードにラベルとショートカットがある', () => {
    expect(VIEW_MODE_LABEL.works).toBe('作品')
    expect(VIEW_MODE_LABEL.files).toBe('ファイル')
    expect(VIEW_MODE_LABEL.timeline).toBe('タイムライン')
    expect(VIEW_MODE_SHORTCUT.works).toBe('Alt+1')
    expect(VIEW_MODE_SHORTCUT.files).toBe('Alt+2')
    expect(VIEW_MODE_SHORTCUT.timeline).toBe('Alt+3')
  })
})
