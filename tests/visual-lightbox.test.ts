import { describe, expect, it } from 'vitest'
import { lightboxVisualFromUrl } from '../src/library/visualLightbox'

describe('visual:check 用のライトボックス初期状態', () => {
  it('既定はすべて閉じている', () => {
    expect(lightboxVisualFromUrl('')).toEqual({
      open: false,
      menu: false,
      meta: false,
      slideshow: false,
    })
  })

  it('URL から開く・メニュー・メタ・スライドショーを指定できる', () => {
    expect(lightboxVisualFromUrl('?lightbox=1&lightboxMenu=1')).toEqual({
      open: true,
      menu: true,
      meta: false,
      slideshow: false,
    })
    expect(lightboxVisualFromUrl('?lightbox=1&lightboxMeta=1&lightboxSlideshow=1')).toEqual({
      open: true,
      menu: false,
      meta: true,
      slideshow: true,
    })
  })
})
