/**
 * #82: `?` で開くショートカット一覧。
 *
 * - 定義データの分類・表記・重複なし
 * - 入力欄では開かない判定（既存の入力ガードと同じ）
 * - `?` で開き、Esc で閉じる
 * - 実際のキー処理（`resolveListShortcut` / `matchesShortcut`）が定義を参照している
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  isEditableTarget,
  matchesShortcut,
  resolveListShortcut,
  SHORTCUT_DEFINITIONS,
  SHORTCUT_GROUPS,
  shortcutKeys,
  shortcutsInGroup,
  shouldOpenHelp,
} from '../src/lib/shortcuts'
import { helpOpenFromUrl, ShortcutsHelp } from '../src/library/ShortcutsHelp'

function helpEvent(extra: Parameters<typeof shouldOpenHelp>[0] = { key: '?' }) {
  return { key: '?', code: 'Slash', shiftKey: true, ...extra }
}

describe('ショートカット定義（#82）', () => {
  it('一覧 / 詳細 / 比較・差分 / 全体の 4 分類に分かれている', () => {
    expect(SHORTCUT_GROUPS.map((group) => group.label)).toEqual([
      '一覧',
      '詳細',
      '比較・差分',
      '全体',
    ])

    for (const group of SHORTCUT_GROUPS) {
      const definitions = shortcutsInGroup(group.id)
      expect(definitions.length).toBeGreaterThan(0)
      expect(definitions.every((definition) => definition.group === group.id)).toBe(true)
    }

    // どの定義も必ずどれかの分類に入る（未分類を作らない）
    expect(SHORTCUT_DEFINITIONS.every((definition) =>
      SHORTCUT_GROUPS.some((group) => group.id === definition.group),
    )).toBe(true)
  })

  it('キー表記は Windows（Ctrl のみ・⌘ / Cmd / Meta を出さない）', () => {
    for (const definition of SHORTCUT_DEFINITIONS) {
      expect(definition.keys.trim()).not.toBe('')
      expect(definition.description.trim()).not.toBe('')
      expect(definition.keys).not.toContain('⌘')
      expect(definition.keys).not.toMatch(/Cmd|Command|Meta|Control\+/)
      expect(definition.keys).not.toContain('Alt+Ctrl')
      // Ctrl と Shift を両方使うときは Ctrl → Shift の順
      if (definition.keys.includes('Ctrl+') && definition.keys.includes('Shift+')) {
        expect(definition.keys.indexOf('Ctrl+')).toBeLessThan(
          definition.keys.indexOf('Shift+'),
        )
      }
    }
  })

  it('id と分類内のキー表記が重複しない', () => {
    const ids = SHORTCUT_DEFINITIONS.map((definition) => definition.id)
    expect(new Set(ids).size).toBe(ids.length)

    const groupKeys = SHORTCUT_DEFINITIONS.map(
      (definition) => `${definition.group}:${definition.keys}`,
    )
    expect(new Set(groupKeys).size).toBe(groupKeys.length)
  })

  it('ヘルプ自身も定義にあり、表記は ?', () => {
    expect(shortcutKeys('help')).toBe('?')
    expect(matchesShortcut('help', helpEvent({ isComposing: false }))).toBe(true)
  })
})

describe('shouldOpenHelp（入力中は開かない）', () => {
  it('入力欄・選択欄・contenteditable では開かない', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    editable.isContentEditable = true

    for (const target of [input, textarea, select, editable]) {
      expect(isEditableTarget(target)).toBe(true)
      expect(shouldOpenHelp(helpEvent(), target)).toBe(false)
    }
    // 入力欄でなくても、対象がなければ body 扱いで開く
    expect(shouldOpenHelp(helpEvent(), document.createElement('div'))).toBe(true)
    expect(shouldOpenHelp(helpEvent(), null)).toBe(true)
  })

  it('IME 変換中・修飾キー付き・ / では開かない', () => {
    expect(shouldOpenHelp(helpEvent({ isComposing: true }))).toBe(false)
    expect(shouldOpenHelp(helpEvent({ shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(shouldOpenHelp(helpEvent({ altKey: true }))).toBe(false)
    expect(shouldOpenHelp(helpEvent({ metaKey: true }))).toBe(false)
    expect(shouldOpenHelp({ key: '/', code: 'Slash', shiftKey: false })).toBe(false)
  })
})

describe('キー処理が定義を参照している', () => {
  it('Delete / Shift+Delete は定義の判定に一致する', () => {
    expect(matchesShortcut('delete', { key: 'Delete', shiftKey: false })).toBe(true)
    expect(matchesShortcut('delete', { key: 'Delete', shiftKey: true })).toBe(false)
    expect(matchesShortcut('delete-permanent', { key: 'Delete', shiftKey: true })).toBe(true)
    expect(matchesShortcut('search', { key: '/' })).toBe(true)
    expect(matchesShortcut('roots', { key: '3', ctrlKey: true })).toBe(true)
    expect(
      matchesShortcut('view-timeline', { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }),
    ).toBe(true)
    expect(
      matchesShortcut('view-timeline', { key: '3', code: 'Digit3', altKey: true }),
    ).toBe(true)
    expect(
      matchesShortcut('view-works', { key: '1', code: 'Digit1', altKey: true }),
    ).toBe(true)
    // #88: Ctrl+1 はルート絞り込みだけ。表示モードには一致しない
    expect(
      matchesShortcut('view-works', { key: '1', code: 'Digit1', ctrlKey: true }),
    ).toBe(false)
    expect(matchesShortcut('roots', { key: '1', code: 'Digit1', ctrlKey: true })).toBe(true)
    expect(matchesShortcut('roots', { key: '1', code: 'Digit1', altKey: true })).toBe(false)
  })

  it('resolveListShortcut の動作はこれまでどおり', () => {
    expect(resolveListShortcut({ key: 'j' })).toEqual({ kind: 'focus', delta: 1 })
    expect(resolveListShortcut({ key: 'K' })).toEqual({ kind: 'focus', delta: -1 })
    expect(resolveListShortcut({ key: '3' })).toEqual({ kind: 'rate', rating: 3 })
    expect(resolveListShortcut({ key: '0' })).toEqual({ kind: 'rate', rating: null })
    expect(resolveListShortcut({ key: 'F' })).toEqual({ kind: 'favorite' })
    expect(resolveListShortcut({ key: ' ', code: 'Space' })).toEqual({
      kind: 'toggle-play',
    })
    expect(resolveListShortcut({ key: 'Escape' })).toEqual({ kind: 'close' })
    expect(resolveListShortcut({ key: '/', code: 'Slash' })).toBeNull()
    expect(resolveListShortcut({ key: '?', code: 'Slash', shiftKey: true })).toBeNull()
  })
})

describe('ShortcutsHelp（? で開く）', () => {
  it('? で開き、定義と同じキー表記を表示する', () => {
    render(<ShortcutsHelp />)

    expect(screen.queryByText('キーボードショートカット')).toBeNull()
    fireEvent.keyDown(window, helpEvent())

    expect(screen.getByText('キーボードショートカット')).toBeInTheDocument()
    for (const group of SHORTCUT_GROUPS) {
      expect(
        document.querySelector(`[data-shortcut-group="${group.id}"]`),
      ).toBeTruthy()
    }
    // 表示は定義データそのもの（? と Ctrl+Shift+P が一致する）
    expect(
      document.querySelector('[data-shortcut="help"] kbd')?.textContent,
    ).toBe(shortcutKeys('help'))
    expect(
      document.querySelector('[data-shortcut="shield"] kbd')?.textContent,
    ).toBe(shortcutKeys('shield'))
    // #81 のタイムライン切替も一覧に出る（#88 で Alt+3 を追加、Ctrl+Shift+T は維持）
    expect(
      document.querySelector('[data-shortcut="view-timeline"] kbd')?.textContent,
    ).toBe('Alt+3 / Ctrl+Shift+T')
    expect(
      document.querySelector('[data-shortcut="view-works"] kbd')?.textContent,
    ).toBe('Alt+1')
  })

  it('入力欄にフォーカスがあるときは開かない', () => {
    render(
      <>
        <input aria-label="検索" />
        <ShortcutsHelp />
      </>,
    )

    const input = screen.getByLabelText('検索')
    input.focus()
    fireEvent.keyDown(input, helpEvent())

    expect(screen.queryByText('キーボードショートカット')).toBeNull()
  })

  it('Esc で閉じる', () => {
    render(<ShortcutsHelp />)
    fireEvent.keyDown(window, helpEvent())
    expect(screen.getByText('キーボードショートカット')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByText('キーボードショートカット')).toBeNull()
  })
})

/**
 * #116: 1280×800 で下端が切れないように、ダイアログの高さを制限して
 * 本文だけを内部スクロールにする。ヘッダー / フッター / 見出しの扱いも固定する。
 */
describe('ShortcutsHelp（#116 高さ制限と本文スクロール）', () => {
  /** jsdom はレイアウトしないので、スクロール量だけを差し替える。 */
  function setScrollMetrics(element: HTMLElement, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
    Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true })
  }

  function openDialog() {
    render(<ShortcutsHelp />)
    fireEvent.keyDown(window, helpEvent())
    const dialog = document.querySelector<HTMLElement>('[data-shortcuts-dialog]')
    const scroll = document.querySelector<HTMLElement>('[data-shortcuts-scroll]')
    const footer = document.querySelector<HTMLElement>('[data-shortcuts-footer]')
    expect(dialog).toBeTruthy()
    expect(scroll).toBeTruthy()
    expect(footer).toBeTruthy()
    // Radix は portal に描画するので、本文・フッターは同じダイアログの中にある
    expect(dialog!.contains(scroll!)).toBe(true)
    expect(scroll!.contains(footer!)).toBe(false)
    return { dialog: dialog!, scroll: scroll!, footer: footer! }
  }

  it('高さは min(85vh, 760px) で、ヘッダーとフッターは本文の外側に固定される', () => {
    const { dialog, scroll, footer } = openDialog()

    expect(dialog.className).toContain('max-h-[min(85vh,760px)]')
    expect(dialog.className).toContain('flex')
    expect(dialog.className).toContain('flex-col')

    // 本文だけがスクロールし、タイトル・説明・フッターはその中に入らない
    expect(scroll.className).toContain('overflow-y-auto')
    expect(scroll.contains(screen.getByText('キーボードショートカット'))).toBe(false)
    expect(footer.className).toContain('shrink-0')

    // 4 分類の見出しは sticky（スクロール中も現在地が分かる）
    for (const group of SHORTCUT_GROUPS) {
      const heading = document.getElementById(`shortcuts-heading-${group.id}`)
      expect(heading).toBeTruthy()
      expect(heading!.className).toContain('sticky')
      expect(heading!.className).toContain('top-0')
    }

    // 下端には「続きがある」ことを示すフェードがある
    expect(document.querySelector('[data-shortcuts-fade]')).toBeTruthy()
    expect(document.querySelector('[data-shortcuts-fade]')!.className).toContain(
      'bg-gradient-to-t',
    )
  })

  it('PageDown / PageUp / ↑↓ / Home / End で本文がスクロールする', () => {
    const { scroll } = openDialog()
    setScrollMetrics(scroll, 400, 1200)
    // ページ量は「画面 1 枚弱」（clientHeight - 48 = 352）
    expect(scroll.scrollTop).toBe(0)

    fireEvent.keyDown(window, { key: 'PageDown' })
    expect(scroll.scrollTop).toBe(352)

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(scroll.scrollTop).toBe(400)

    fireEvent.keyDown(window, { key: 'ArrowUp' })
    expect(scroll.scrollTop).toBe(352)

    fireEvent.keyDown(window, { key: 'PageDown' })
    expect(scroll.scrollTop).toBe(704)

    fireEvent.keyDown(window, { key: 'PageDown' })
    expect(scroll.scrollTop).toBe(800) // 最下端で止まる

    fireEvent.keyDown(window, { key: 'PageUp' })
    expect(scroll.scrollTop).toBe(448)

    fireEvent.keyDown(window, { key: 'End' })
    expect(scroll.scrollTop).toBe(800)

    fireEvent.keyDown(window, { key: 'Home' })
    expect(scroll.scrollTop).toBe(0)
  })

  it('入力欄にフォーカスがあるときはスクロールキーを奪わない', () => {
    const { scroll } = openDialog()
    setScrollMetrics(scroll, 400, 1200)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    fireEvent.keyDown(input, { key: 'PageDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(scroll.scrollTop).toBe(0)

    input.remove()
  })

  it('修飾キー付きのキーはスクロールに使わない', () => {
    const { scroll } = openDialog()
    setScrollMetrics(scroll, 400, 1200)

    fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'PageDown', altKey: true })
    expect(scroll.scrollTop).toBe(0)
  })

  it('?help=1 は visual:check 用に初期表示から開く', () => {
    expect(helpOpenFromUrl('?help=1&bench=24')).toBe(true)
    expect(helpOpenFromUrl('?bench=24')).toBe(false)

    window.history.replaceState({}, '', '/?help=1&bench=24')
    try {
      render(<ShortcutsHelp />)
      expect(screen.getByText('キーボードショートカット')).toBeInTheDocument()
    } finally {
      window.history.replaceState({}, '', '/')
    }
  })
})
