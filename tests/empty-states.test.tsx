/**
 * #100: 空状態の共通形。
 *
 * - 4 種（ルート無し / スマートフォルダ無し / 検索 0 件 / サムネ未生成）が
 *   同じ「アイコン + 短い説明 + 次の行動 1 つ」で描ける
 * - サイドバーの空状態は実際の RootsSidebar から出す
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Bookmark, FolderPlus, ImageOff, SearchX } from 'lucide-react'
import { EmptyState } from '../src/library/EmptyState'
import { RootsSidebar } from '../src/library/RootsSidebar'
import { makeRootInfo } from './fixtures'

afterEach(() => {
  vi.clearAllMocks()
})

describe('#100 EmptyState', () => {
  it('アイコン・短い説明・次の行動を 1 つだけ出す', () => {
    const onClick = vi.fn()
    render(
      <EmptyState
        icon={SearchX}
        title="条件に一致する作品がありません"
        description="検索語や絞り込みを変えてみてください。"
        action={{ label: '条件をクリア', onClick }}
      />,
    )

    expect(screen.getByText('条件に一致する作品がありません')).toBeInTheDocument()
    expect(screen.getByText('検索語や絞り込みを変えてみてください。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '条件をクリア' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('サムネ未生成は横長の notice でも同じ形で出せる', () => {
    const onClick = vi.fn()
    render(
      <EmptyState
        variant="notice"
        icon={ImageOff}
        title="サムネイルはまだ生成されていません"
        description="画像を表示すると作品を見分けやすくなります。"
        action={{ label: 'サムネイルを生成', onClick }}
      />,
    )

    expect(screen.getByText('サムネイルはまだ生成されていません')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'サムネイルを生成' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('#100 サイドバーの空状態', () => {
  it('ルートが無いときは説明と「ルートを追加」を出す', () => {
    const onAddRoot = vi.fn()
    render(
      <RootsSidebar
        roots={[]}
        rootAccents={new Map()}
        selectedRootId={null}
        onSelect={() => undefined}
        onAddRoot={onAddRoot}
      />,
    )

    expect(screen.getByText('ルートを追加して始める')).toBeInTheDocument()
    expect(screen.queryByText('スマートフォルダはまだありません')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'ルートを追加' }))
    expect(onAddRoot).toHaveBeenCalledTimes(1)
  })

  it('スマートフォルダが無いときは「条件を絞り込む」を 1 つ出す', () => {
    const onFocusFilters = vi.fn()
    render(
      <RootsSidebar
        roots={[makeRootInfo({ id: 1 })]}
        rootAccents={new Map()}
        selectedRootId={null}
        onSelect={() => undefined}
        onAddRoot={() => undefined}
        onFocusFilters={onFocusFilters}
        smartFolders={[]}
      />,
    )

    expect(screen.getByText('スマートフォルダはまだありません')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '条件を絞り込む' }))
    expect(onFocusFilters).toHaveBeenCalledTimes(1)
  })

  it('アイコンは控えめ（ブランド色で塗らない）', () => {
    render(
      <EmptyState
        variant="sidebar"
        icon={Bookmark}
        title="スマートフォルダはまだありません"
        description="絞り込みを保存できます。"
        action={{ label: '条件を絞り込む', onClick: () => undefined }}
      />,
    )
    const iconHost = document.querySelector('[data-empty-state] span[aria-hidden="true"]')
    expect(iconHost).toHaveClass('text-[var(--text-tertiary)]')
    expect(iconHost?.className).not.toContain('var(--brand)')
  })

  it('ルートが無いときのアイコンは FolderPlus', () => {
    render(
      <EmptyState
        variant="sidebar"
        icon={FolderPlus}
        title="ルートを追加して始める"
        description="フォルダを追加して始めます。"
      />,
    )
    expect(document.querySelector('[data-empty-state] svg')).not.toBeNull()
  })
})
