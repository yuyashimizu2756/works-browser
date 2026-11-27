/**
 * #96 ツールバーのポップオーバー / メニューの開閉テスト。
 *
 * - フィルタはクリックで開き、Escape と外側クリックで閉じる
 * - 並びメニューは項目を選ぶと閉じて onChange を 1 回だけ呼ぶ
 * - 適用中チップは個別 / 一括で解除できる
 */
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  FilterChipBar,
  FilterChoice,
  FilterMenu,
  FilterSection,
  SortMenu,
  ThumbnailToggle,
  ViewModeSegment,
} from '../src/library/Toolbar'

function ThumbnailToggleHarness({ variant }: { variant: 'compact' | 'labeled' }) {
  const [visible, setVisible] = useState(false)
  return (
    <ThumbnailToggle
      variant={variant}
      visible={visible}
      onToggle={() => setVisible((value) => !value)}
    />
  )
}

function FilterHarness() {
  const [count, setCount] = useState(1)
  return (
    <FilterMenu count={count} onClear={() => setCount(0)}>
      {() => (
        <FilterSection label="種類">
          <FilterChoice active onClick={() => undefined}>
            すべて
          </FilterChoice>
        </FilterSection>
      )}
    </FilterMenu>
  )
}

describe('#96 ツールバー', () => {
  it('フィルタはクリックで開き、Escape で閉じてトリガーへ戻る', () => {
    render(<FilterHarness />)
    const trigger = screen.getByRole('button', { name: 'フィルタ（1 件適用中）' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('dialog', { name: '絞り込み' })).toBeInTheDocument()
    expect(screen.getByText('すべて解除')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '絞り込み' })).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('外側クリックでも閉じる', () => {
    render(<FilterHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'フィルタ（1 件適用中）' }))
    expect(screen.getByRole('dialog', { name: '絞り込み' })).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { name: '絞り込み' })).not.toBeInTheDocument()
  })

  it('並びメニューは選択で閉じ、昇降はアイコン 1 つで切り替える', () => {
    const onChange = vi.fn()
    const onToggleDir = vi.fn()
    render(
      <SortMenu
        options={[
          { key: 'mtime', label: '更新日' },
          { key: 'title', label: '名前' },
        ]}
        value="mtime"
        onChange={onChange}
        dir="desc"
        onToggleDir={onToggleDir}
      />,
    )

    const trigger = screen.getByRole('button', { name: '並び替え（現在: 更新日）' })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu', { name: '並び替え' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: '更新日' })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    fireEvent.click(screen.getByRole('menuitemradio', { name: '名前' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('title')
    expect(screen.queryByRole('menu', { name: '並び替え' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '降順（クリックで昇順）' }))
    expect(onToggleDir).toHaveBeenCalledTimes(1)
  })

  it('選択中のフィルタチップはアクセント塗りに統一する（白い選択をしない）', () => {
    render(
      <>
        <FilterChoice active onClick={() => undefined}>
          すべて
        </FilterChoice>
        <FilterChoice active={false} onClick={() => undefined}>
          画像のみ
        </FilterChoice>
      </>,
    )

    const active = screen.getByRole('button', { name: 'すべて' })
    expect(active).toHaveAttribute('aria-pressed', 'true')
    expect(active.className).toContain('bg-[var(--brand)]')
    expect(active.className).toContain('text-[var(--brand-contrast)]')
    expect(active.className).not.toContain('text-[var(--text-primary)]')

    const inactive = screen.getByRole('button', { name: '画像のみ' })
    expect(inactive).toHaveAttribute('aria-pressed', 'false')
    expect(inactive.className).not.toContain('bg-[var(--brand)]')
  })

  it('適用中チップは個別に削除でき、すべて解除もできる', () => {    const onRemove = vi.fn()
    const onClear = vi.fn()
    render(
      <FilterChipBar
        chips={[{ key: 'root', label: 'ルート: 素材', onRemove }]}
        onClear={onClear}
      />,
    )

    expect(screen.getByText('ルート: 素材')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'ルート: 素材 を解除' }))
    expect(onRemove).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'すべて解除' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('サムネトグルは aria-pressed とアクセシブル名を切り替える', () => {
    render(<ThumbnailToggleHarness variant="labeled" />)
    const toggle = screen.getByRole('button', { name: 'サムネイルを表示する' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveTextContent('サムネ')
    expect(toggle).toHaveAttribute('title', 'サムネイルの表示 / 非表示（Ctrl+Shift+H）')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAccessibleName('サムネイルを非表示にする')
    expect(toggle).toHaveTextContent('サムネ')
  })

  it('compact はアイコンだけ（ヘッダー用）で、aria-pressed は共有する', () => {
    render(<ThumbnailToggleHarness variant="compact" />)
    const toggle = screen.getByRole('button', { name: 'サムネイルを表示する' })
    expect(toggle).toHaveAttribute('data-thumb-toggle', 'compact')
    expect(toggle).not.toHaveTextContent('サムネ')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('表示切替は右端セグメントで aria-pressed が 1 つだけ true', () => {
    const onChange = vi.fn()
    render(<ViewModeSegment value="works" onChange={onChange} />)

    const group = screen.getByRole('group', { name: '表示モード' })
    const buttons = Array.from(group.querySelectorAll('button'))
    expect(buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(
      1,
    )

    fireEvent.click(screen.getByRole('button', { name: 'ファイル' }))
    expect(onChange).toHaveBeenCalledWith('files')
  })
})
