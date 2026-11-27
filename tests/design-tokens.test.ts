import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * #100: フォーカス / モーションの値が 1 箇所（index.css）で守られていること。
 * 実際の見た目は visual:check と手動確認で担保する。
 */
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('#100 デザイントークン', () => {
  it('フォーカスは 2px リング + offset 2（unlayered でユーティリティに勝つ）', () => {
    expect(css).toContain('--focus-width: 2px')
    expect(css).toContain('--focus-offset: 2px')
    expect(css).toMatch(
      /:focus-visible\s*\{[\s\S]*?outline:\s*var\(--focus-width\) solid var\(--brand\)[\s\S]*?outline-offset:\s*var\(--focus-offset\)/,
    )
    // レイヤー外であること（@layer base の中だけだと outline-none に負ける）
    const focusRule = css.slice(css.indexOf(":where(\n    button,"))
    expect(focusRule).not.toMatch(/^@layer/m)
  })

  it('動きは 160ms / reduce で無効', () => {
    expect(css).toContain('--duration-fast: 160ms')
    expect(css).toContain('transition-duration: var(--duration-fast)')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/transition-duration: 0\.01ms !important/)
    expect(css).toMatch(/animation-duration: 0\.01ms !important/)
  })

  it('21px 以上の見出しは OS 標準の表示用フォント + 字間 -0.02em', () => {
    expect(css).toContain(
      "--font-display: 'Segoe UI Variable Display', 'Segoe UI', sans-serif",
    )
    expect(css).toMatch(/\.type-display\s*\{[\s\S]*?font-family:\s*var\(--font-display\)/)
    expect(css).toMatch(/\.type-display\s*\{[\s\S]*?letter-spacing:\s*-0\.02em/)
  })

  it('ダイアログは 0.98 → 1 の拡大 + フェード', () => {
    const dialog = readFileSync(
      resolve(process.cwd(), 'src/components/ui/dialog.tsx'),
      'utf8',
    )
    expect(dialog).toContain('data-open:zoom-in-98')
    expect(dialog).toContain('data-closed:zoom-out-98')
    expect(dialog).toContain('data-open:fade-in-0')
    expect(dialog).toContain('duration-[var(--duration-fast)]')
  })
})
