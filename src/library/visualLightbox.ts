/**
 * `visual:check` 用のライトボックス初期状態（#8）。
 *
 * `?help=1` / `?empty=` と同じ「URL で画面の状態を指定する」デモ用の入口。
 * ベンチ（`?bench=`）のときだけ使う。通常起動では何もしない。
 */
export type LightboxVisualState = {
  /** `?lightbox=1` … 作品詳細の先頭ファイルでライトボックスを開く。 */
  open: boolean
  /** `?lightboxMenu=1` … `⋯` メニューを開いた状態で撮る。 */
  menu: boolean
  /** `?lightboxMeta=1` … 生成情報パネルを開いた状態で撮る。 */
  meta: boolean
  /** `?lightboxSlideshow=1` … スライドショー中の表示で撮る。 */
  slideshow: boolean
}

export const EMPTY_LIGHTBOX_VISUAL: LightboxVisualState = {
  open: false,
  menu: false,
  meta: false,
  slideshow: false,
}

export function lightboxVisualFromUrl(search = window.location.search): LightboxVisualState {
  const params = new URLSearchParams(search)
  return {
    open: params.get('lightbox') === '1',
    menu: params.get('lightboxMenu') === '1',
    meta: params.get('lightboxMeta') === '1',
    slideshow: params.get('lightboxSlideshow') === '1',
  }
}
