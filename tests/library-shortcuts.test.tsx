/**
 * #88: `Ctrl+1` の二重発火を解消したことの回帰テスト。
 *
 * - `Ctrl+1` はルート絞り込みだけ（表示モードは変わらない）
 * - `Alt+1` は表示モードだけ（ルートは変わらない）
 * - 1 つのキーに一致する「一覧 / 全体」の定義は最大 1 件
 * - `useLibraryShortcuts` は 1 つの `keydown` ハンドラで 1 つの意図だけを実行する
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  matchesShortcut,
  resolveLibraryShortcut,
  SHORTCUT_DEFINITIONS,
} from '../src/lib/shortcuts'
import type { KeyInput } from '../src/lib/shortcuts'
import { useLibraryShortcuts } from '../src/library/useLibraryShortcuts'

function key(overrides: KeyInput & { key: string }): KeyInput {
  return {
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  }
}

function dispatch(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

function setup({ enabled = true }: { enabled?: boolean } = {}) {
  const onViewModeChange = vi.fn()
  const onToggleThumbnails = vi.fn()
  const onSelectRoot = vi.fn()
  const view = renderHook(() =>
    useLibraryShortcuts({ enabled, onViewModeChange, onToggleThumbnails, onSelectRoot }),
  )
  return { onViewModeChange, onToggleThumbnails, onSelectRoot, ...view }
}

describe('resolveLibraryShortcut（1 キー = 1 意図）', () => {
  it('Ctrl+1 はルート、Alt+1 は表示モードにだけ解決する', () => {
    expect(resolveLibraryShortcut(key({ key: '1', code: 'Digit1', ctrlKey: true }))).toEqual({
      kind: 'select-root',
      index: 0,
    })
    expect(resolveLibraryShortcut(key({ key: '1', code: 'Digit1', altKey: true }))).toEqual({
      kind: 'view-mode',
      mode: 'works',
    })
  })

  it('Alt+2 / Alt+3 / Ctrl+Shift+T は表示モード', () => {
    expect(resolveLibraryShortcut(key({ key: '2', code: 'Digit2', altKey: true }))).toEqual({
      kind: 'view-mode',
      mode: 'files',
    })
    expect(resolveLibraryShortcut(key({ key: '3', code: 'Digit3', altKey: true }))).toEqual({
      kind: 'view-mode',
      mode: 'timeline',
    })
    expect(
      resolveLibraryShortcut(key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: 'view-mode', mode: 'timeline' })
  })

  it('Ctrl+Shift+H はサムネ表示、Ctrl+0 はすべてのルート', () => {
    expect(
      resolveLibraryShortcut(key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: 'toggle-thumbnails' })
    expect(resolveLibraryShortcut(key({ key: '0', ctrlKey: true }))).toEqual({
      kind: 'select-root',
      index: null,
    })
  })

  it('修飾なし・Meta 付き・IME 変換中は何もしない', () => {
    expect(resolveLibraryShortcut(key({ key: '1' }))).toBeNull()
    expect(resolveLibraryShortcut(key({ key: '1', code: 'Digit1', metaKey: true }))).toBeNull()
    expect(
      resolveLibraryShortcut(key({ key: '1', code: 'Digit1', ctrlKey: true, isComposing: true })),
    ).toBeNull()
  })
})

describe('useLibraryShortcuts（単一ハンドラ）', () => {
  it('Ctrl+1 ではルートだけが変わり、表示モードは変わらない', () => {
    const { onViewModeChange, onToggleThumbnails, onSelectRoot } = setup()

    const event = dispatch(window, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(onSelectRoot).toHaveBeenCalledTimes(1)
    expect(onSelectRoot).toHaveBeenCalledWith(0)
    expect(onViewModeChange).not.toHaveBeenCalled()
    expect(onToggleThumbnails).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('Alt+1 では表示モードだけが変わり、ルートは変わらない', () => {
    const { onViewModeChange, onToggleThumbnails, onSelectRoot } = setup()

    const event = dispatch(window, { key: '1', code: 'Digit1', altKey: true })

    expect(onViewModeChange).toHaveBeenCalledTimes(1)
    expect(onViewModeChange).toHaveBeenCalledWith('works')
    expect(onSelectRoot).not.toHaveBeenCalled()
    expect(onToggleThumbnails).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('Alt+2 / Alt+3 / Ctrl+Shift+T / Ctrl+Shift+H を 1 回ずつ処理する', () => {
    const { onViewModeChange, onToggleThumbnails, onSelectRoot } = setup()

    dispatch(window, { key: '2', code: 'Digit2', altKey: true })
    dispatch(window, { key: '3', code: 'Digit3', altKey: true })
    dispatch(window, { key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })
    dispatch(window, { key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true })

    expect(onViewModeChange.mock.calls).toEqual([['files'], ['timeline'], ['timeline']])
    expect(onToggleThumbnails).toHaveBeenCalledTimes(1)
    expect(onSelectRoot).not.toHaveBeenCalled()
  })

  it('Ctrl+0 はすべて、Ctrl+5 は 5 番目のルート', () => {
    const { onSelectRoot } = setup()

    dispatch(window, { key: '0', ctrlKey: true })
    dispatch(window, { key: '5', code: 'Digit5', ctrlKey: true })

    expect(onSelectRoot.mock.calls).toEqual([[null], [4]])
  })

  it('入力欄ではルートを動かさない（表示モードは従来どおり切り替わる）', () => {
    const { onViewModeChange, onSelectRoot } = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)

    dispatch(input, { key: '1', code: 'Digit1', ctrlKey: true })
    dispatch(input, { key: '1', code: 'Digit1', altKey: true })

    expect(onSelectRoot).not.toHaveBeenCalled()
    expect(onViewModeChange).toHaveBeenCalledWith('works')
    input.remove()
  })

  it('ダイアログ表示中はルートを動かさない', () => {
    const { onSelectRoot } = setup()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)

    dispatch(window, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(onSelectRoot).not.toHaveBeenCalled()
    dialog.remove()
  })

  it('先に処理済み（defaultPrevented）のキーは奪わない', () => {
    const { onViewModeChange, onSelectRoot } = setup()
    const event = new KeyboardEvent('keydown', {
      key: '1',
      code: 'Digit1',
      ctrlKey: true,
      cancelable: true,
    })
    event.preventDefault()
    window.dispatchEvent(event)

    expect(onSelectRoot).not.toHaveBeenCalled()
    expect(onViewModeChange).not.toHaveBeenCalled()
  })

  it('enabled=false では登録しない', () => {
    const { onSelectRoot } = setup({ enabled: false })

    dispatch(window, { key: '1', code: 'Digit1', ctrlKey: true })

    expect(onSelectRoot).not.toHaveBeenCalled()
  })
})

describe('定義のキー空間（一覧 / 全体）', () => {
  it('同じキーに一致する定義は最大 1 件（Ctrl+1 と Alt+1 を含む）', () => {
    const events: KeyInput[] = [
      ...Array.from({ length: 10 }, (_, value) => key({ key: String(value), ctrlKey: true })),
      key({ key: '1', code: 'Digit1', altKey: true }),
      key({ key: '2', code: 'Digit2', altKey: true }),
      key({ key: '3', code: 'Digit3', altKey: true }),
      key({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }),
      key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }),
      key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }),
      key({ key: '?', code: 'Slash', shiftKey: true }),
      key({ key: '/', code: 'Slash' }),
      key({ key: 'Delete' }),
      key({ key: 'Delete', shiftKey: true }),
      key({ key: 'Escape' }),
      key({ key: 'Enter' }),
      key({ key: ' ', code: 'Space' }),
      key({ key: 'j' }),
      key({ key: 'k' }),
      key({ key: 'f' }),
      key({ key: '0' }),
      key({ key: '1' }),
      key({ key: '5' }),
    ]

    const scoped = SHORTCUT_DEFINITIONS.filter(
      (definition) => definition.group === 'list' || definition.group === 'global',
    )
    for (const event of events) {
      const matched = scoped
        .filter((definition) => matchesShortcut(definition.id, event))
        .map((definition) => definition.id)
      expect(
        matched.length,
        `${JSON.stringify(event)} が ${matched.join(', ')} に一致`,
      ).toBeLessThanOrEqual(1)
    }
  })
})
