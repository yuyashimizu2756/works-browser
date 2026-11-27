import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkSummary } from '../src/api'
import { formatBytes, formatShortDate } from '../src/lib/format'
import { hueForTitle, initialsForTitle } from '../src/library/placeholder'
import { WorkCard } from '../src/library/WorkCard'
import { makeWork } from './fixtures'

function renderCard(
  overrides: Partial<WorkSummary> & { id: number } = { id: 1 },
  props: Partial<{
    selected: boolean
    thumbnailVisible: boolean
    accent: string
    rootLabel: string
    onToggle: (work: WorkSummary, modifiers: { ctrl: boolean; shift: boolean }) => void
    onOpen: (work: WorkSummary) => void
  }> = {},
) {
  const work = makeWork(overrides)
  const onToggle = props.onToggle ?? vi.fn()
  const onOpen = props.onOpen ?? vi.fn()
  render(
    <WorkCard
      work={work}
      rootLabel={props.rootLabel ?? 'ルート A'}
      accent={props.accent ?? '#7c6cff'}
      selected={props.selected ?? false}
      thumbnailVisible={props.thumbnailVisible ?? false}
      bench={false}
      onToggle={onToggle}
      onOpen={onOpen}
    />,
  )
  return { work, onToggle, onOpen }
}

describe('WorkCard（#98）', () => {
  it('題名と 2 行のメタ（本数 · サイズ · 日付）を出す', () => {
    const { work } = renderCard({ id: 7, title: '静かな海', file_count: 12, total_bytes: 1_000 })

    const card = screen.getByRole('option')
    expect(card).toHaveAccessibleName(
      `静かな海、ルート A、12 ファイル、${formatBytes(1_000)}、${formatShortDate(work.mtime)}`,
    )
    expect(screen.getByText('静かな海')).toBeInTheDocument()

    const meta = card.querySelector('[data-card-meta]')
    expect(meta).not.toBeNull()
    // 題名 + 補助情報の 2 行だけ（ルート名は aria-label / title に含める）
    expect(meta?.children).toHaveLength(2)
    expect(meta?.textContent).toContain('12 ファイル')
    expect(meta?.textContent).toContain(formatBytes(1_000))
    expect(meta?.textContent).toContain(formatShortDate(work.mtime))
  })

  it('題名は 1 行省略、補助情報は 12px の tabular', () => {
    renderCard({ id: 2, title: 'とても長い題名が入っても省略される作品' })
    const title = screen.getByText('とても長い題名が入っても省略される作品')
    expect(title).toHaveClass('truncate')
    expect(title).toHaveClass('text-[15px]')

    const subtitle = screen.getByRole('option').querySelector('[data-card-subtitle]')
    expect(subtitle).toHaveClass('text-xs')
    expect(subtitle).toHaveClass('tabular-nums')
  })

  it('サムネイル非表示が既定で、画像を 1 枚も描画しない', () => {
    renderCard({ id: 3, cover_thumb: '/demo/01-night-orbit.svg' })
    expect(screen.getByRole('option').querySelector('img')).toBeNull()
    expect(screen.getByRole('option')).not.toHaveAttribute('data-previewing')
  })

  it('画像なしのカードはタイトルから生成したタイポグラフィック・カバーになる', () => {
    renderCard({ id: 3, title: '静かな海' })
    const card = screen.getByRole('option')
    expect(card).toHaveAttribute('data-placeholder', 'typographic')
    expect(card).toHaveAttribute('data-placeholder-hue', String(hueForTitle('静かな海')))

    const placeholder = card.querySelector<HTMLElement>('.work-placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.style.getPropertyValue('--placeholder-hue')).toBe(
      String(hueForTitle('静かな海')),
    )
    expect(placeholder?.querySelector('[data-placeholder-initials]')).toHaveTextContent(
      initialsForTitle('静かな海'),
    )
  })

  it('英数字タイトルは 2 文字を大文字で置く', () => {
    renderCard({ id: 12, title: 'bench work 00002' })
    expect(
      screen.getByRole('option').querySelector('[data-placeholder-initials]'),
    ).toHaveTextContent('BE')
  })

  it('種類バッジは画像 / 動画 / 混在をアイコン + ツールチップで出し、画像なしはアイコンのみ', () => {
    renderCard({ id: 4, kind: 'video', title: '動画の作品' })
    const plainBadge = screen.getByRole('option').querySelector('[data-kind-badge]')
    expect(plainBadge).toHaveAttribute('data-overlay', 'plain')
    expect(plainBadge).toHaveAttribute('title', '動画')
    expect(plainBadge).toHaveAttribute('aria-label', '動画')
    // 画像なしではラベル文字を出さない（20px のアイコンだけ）
    expect(plainBadge?.textContent).toBe('')
    expect(plainBadge?.querySelector('svg')).toHaveClass('size-5')
  })

  it('写真があるときのバッジはピルをやめ、14px アイコン 60% + ツールチップ', () => {
    renderCard(
      { id: 5, kind: 'mixed', title: '混在の作品', cover_thumb: '/demo/02-morning-paper.svg' },
      { thumbnailVisible: true },
    )
    const badge = screen.getByRole('option').querySelector('[data-kind-badge]')
    expect(badge).not.toHaveTextContent('混在')
    expect(badge).toHaveAttribute('data-overlay', 'photo')
    expect(badge).toHaveAttribute('title', '混在')
    expect(badge).toHaveAttribute('aria-label', '混在')
    expect(badge).toHaveClass('opacity-60')
    expect(badge).not.toHaveClass('bg-black/60')
    expect(badge?.querySelector('svg')).toHaveClass('size-3.5')
    expect(screen.getByRole('option').querySelector('img')).not.toBeNull()
  })

  it('ホバーで開く操作を出し、フォーカスは共通の 2px リングに任せる', () => {
    renderCard({ id: 6 })
    const card = screen.getByRole('option')
    // #100: フォーカスは index.css の共通ルール（2px / offset 2）。カード側で
    // 打ち消す outline-none を持たないことを確認する。
    expect(card).toHaveAttribute('tabindex', '0')
    expect(card).not.toHaveClass('outline-none')
    expect(card).not.toHaveClass('hover:-translate-y-0.5')

    const open = card.querySelector('[data-card-action="open"]')
    expect(open).toHaveClass('opacity-0')
    expect(open).toHaveClass('group-hover/card:opacity-100')
  })

  it('選択状態はチェック以外にも枠 + 背景で分かる', () => {
    renderCard({ id: 8 }, { selected: true })
    const card = screen.getByRole('option')
    expect(card).toHaveAttribute('aria-selected', 'true')
    expect(card.className).toContain('shadow-[inset_0_0_0_2px_var(--root-accent)]')
    expect(card.className).toContain('bg-[color-mix(in_srgb,var(--root-accent)_10%,var(--surface))]')
  })

  it('チェックボックスのクリックで onToggle を呼ぶ', () => {
    const onToggle = vi.fn()
    renderCard({ id: 9, title: '選択する作品' }, { onToggle })
    fireEvent.click(screen.getByRole('checkbox', { name: '選択する作品 を選択' }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle.mock.calls[0]?.[0]).toMatchObject({ id: 9 })
  })

  it('Enter で詳細を開く（キーボード操作は維持）', () => {
    const onOpen = vi.fn()
    renderCard({ id: 10, title: '開く作品' }, { onOpen })
    fireEvent.keyDown(screen.getByRole('option'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('coverHeight を渡すと 4:3 の高さを固定する', () => {
    renderCard({ id: 11 })
    // 既定は aspect-[4/3]（タイムライン等が親から渡さない場合）
    expect(screen.getByRole('option').querySelector('[data-work-cover]')).toHaveClass(
      'aspect-[4/3]',
    )
  })
})
