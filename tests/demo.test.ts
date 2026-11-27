import { describe, expect, it } from 'vitest'
import { demoModeFromUrl } from '../src/library/bench'
import { demoImageUrls } from '../src/library/demo'

describe('デモモード（#97）', () => {
  it('?demo=1 / ?demo=true のときだけ有効', () => {
    expect(demoModeFromUrl('?bench=24&demo=1')).toBe(true)
    expect(demoModeFromUrl('?bench=24&demo=true')).toBe(true)
    expect(demoModeFromUrl('?bench=24')).toBe(false)
    expect(demoModeFromUrl('?bench=24&demo=0')).toBe(false)
    expect(demoModeFromUrl('')).toBe(false)
  })

  it('16 枚の /demo/*.svg を重複なく返す', () => {
    const urls = demoImageUrls()
    expect(urls).toHaveLength(16)
    expect(new Set(urls).size).toBe(16)
    for (const url of urls) {
      expect(url.startsWith('/demo/')).toBe(true)
      expect(url.endsWith('.svg')).toBe(true)
    }
  })
})
