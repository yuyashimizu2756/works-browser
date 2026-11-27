/**
 * デザイン検証用デモモード（#97）の画像一覧。
 *
 * `?bench=N&demo=1` のときだけ App から **動的 import** され、`public/demo/*.svg`
 * （抽象アート風のサンプル 16 枚）をカードに割り当てる。通常起動ではこのモジュール
 * 自体が読み込まれないため、画像も一覧も初期チャンクに入らない。
 *
 * 画像は `public/demo` にあるが、製品の `dist` には含めない（`vite.config.ts` の
 * `works-browser-demo-assets`）。`npm run visual:check` の `vite preview` 中だけ
 * public から直接配信する。
 */
const DEMO_IMAGE_FILES = [
  '01-night-orbit.svg',
  '02-morning-paper.svg',
  '03-graphite-slabs.svg',
  '04-magenta-tide.svg',
  '05-forest-mist.svg',
  '06-dune-sunset.svg',
  '07-neon-wire.svg',
  '08-bauhaus-day.svg',
  '09-rust-cells.svg',
  '10-violet-veil.svg',
  '11-olive-horizon.svg',
  '12-slate-lines.svg',
  '13-ember-spiral.svg',
  '14-ink-wash.svg',
  '15-electric-cut.svg',
  '16-sepia-arches.svg',
] as const

/** ベース URL（`/` 既定）を前置したデモ画像の URL。 */
export function demoImageUrls(): string[] {
  return DEMO_IMAGE_FILES.map((file) => `${import.meta.env.BASE_URL}demo/${file}`)
}
