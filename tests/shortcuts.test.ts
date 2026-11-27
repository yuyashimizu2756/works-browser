import { describe, expect, it } from 'vitest'
import {
  isActivatableTarget,
  isEditableTarget,
  ratingForKey,
  resolveListShortcut,
} from '../src/lib/shortcuts'

/** 判定に必要な `KeyboardEvent` の形だけを作る。 */
function press(key: string, extra: Partial<Parameters<typeof resolveListShortcut>[0]> = {}) {
  return {
    key,
    code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...extra,
  }
}

function element(tag: 'input' | 'textarea' | 'select' | 'div'): HTMLElement {
  return document.createElement(tag)
}

describe('resolveListShortcut', () => {
  it('j / k で次 / 前へフォーカスする', () => {
    expect(resolveListShortcut(press('j'))).toEqual({ kind: 'focus', delta: 1 })
    expect(resolveListShortcut(press('k'))).toEqual({ kind: 'focus', delta: -1 })
  })

  it('1〜5 は評価、0 は未評価', () => {
    for (const value of [1, 2, 3, 4, 5]) {
      expect(resolveListShortcut(press(String(value)))).toEqual({
        kind: 'rate',
        rating: value,
      })
    }
    expect(resolveListShortcut(press('0'))).toEqual({ kind: 'rate', rating: null })
  })

  it('F はお気に入り、Space は再生 / 停止、Enter は詳細を開く', () => {
    expect(resolveListShortcut(press('f'))).toEqual({ kind: 'favorite' })
    expect(resolveListShortcut(press('F'))).toEqual({ kind: 'favorite' })
    expect(resolveListShortcut(press(' ', { code: 'Space' }))).toEqual({ kind: 'toggle-play' })
    expect(resolveListShortcut(press('Enter'))).toEqual({ kind: 'open' })
    expect(resolveListShortcut(press('Escape'))).toEqual({ kind: 'close' })
  })

  it('入力欄・選択欄・contenteditable では無効', () => {
    for (const target of [
      element('input'),
      element('textarea'),
      element('select'),
    ]) {
      expect(resolveListShortcut(press('j'), target)).toBeNull()
      expect(resolveListShortcut(press('3'), target)).toBeNull()
      expect(resolveListShortcut(press('f'), target)).toBeNull()
      expect(resolveListShortcut(press(' '), target)).toBeNull()
      expect(resolveListShortcut(press('Enter'), target)).toBeNull()
      expect(resolveListShortcut(press('Escape'), target)).toBeNull()
    }
    const editable = element('div')
    editable.isContentEditable = true
    expect(resolveListShortcut(press('Escape'), editable)).toBeNull()
  })

  it('修飾キー付きは既存ショートカットに譲る（Ctrl+1..9 / Ctrl+Shift+P / Ctrl+A）', () => {
    expect(resolveListShortcut(press('1', { ctrlKey: true }))).toBeNull()
    expect(resolveListShortcut(press('p', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(resolveListShortcut(press('a', { ctrlKey: true }))).toBeNull()
    expect(resolveListShortcut(press('j', { altKey: true }))).toBeNull()
    expect(resolveListShortcut(press('k', { metaKey: true }))).toBeNull()
    expect(resolveListShortcut(press('f', { ctrlKey: true }))).toBeNull()
    expect(resolveListShortcut(press(' ', { ctrlKey: true }))).toBeNull()
  })

  it('既存の / 検索・Delete・矢印キーは奪わない', () => {
    expect(resolveListShortcut(press('/'))).toBeNull()
    expect(resolveListShortcut(press('Delete'))).toBeNull()
    expect(resolveListShortcut(press('ArrowLeft'))).toBeNull()
    expect(resolveListShortcut(press('ArrowRight'))).toBeNull()
  })

  it('IME 変換中は無効', () => {
    expect(resolveListShortcut(press('j', { isComposing: true }))).toBeNull()
    expect(resolveListShortcut(press('Escape', { isComposing: true }))).toBeNull()
  })

  it('ボタン / チェックボックス上の Space・Enter は要素自身に任せる', () => {
    const button = document.createElement('button')
    const checkbox = document.createElement('div')
    checkbox.setAttribute('role', 'checkbox')
    expect(resolveListShortcut(press(' ', { code: 'Space' }), button)).toBeNull()
    expect(resolveListShortcut(press('Enter'), button)).toBeNull()
    expect(resolveListShortcut(press(' ', { code: 'Space' }), checkbox)).toBeNull()
    // j / k などはボタン上でも動く
    expect(resolveListShortcut(press('j'), button)).toEqual({ kind: 'focus', delta: 1 })
  })

  it('カード上の Enter はカード自身の処理に任せる（二重遷移しない）', () => {
    const card = document.createElement('div')
    card.dataset.workId = '7'
    const child = document.createElement('span')
    card.appendChild(child)
    expect(resolveListShortcut(press('Enter'), child)).toBeNull()
    expect(resolveListShortcut(press('f'), child)).toEqual({ kind: 'favorite' })
  })
})

describe('ratingForKey', () => {
  it('1〜5 / 0 / それ以外', () => {
    expect([1, 2, 3, 4, 5].map((value) => ratingForKey(String(value)))).toEqual([1, 2, 3, 4, 5])
    expect(ratingForKey('0')).toBeNull()
    expect(ratingForKey('6')).toBeUndefined()
    expect(ratingForKey('a')).toBeUndefined()
  })
})

describe('target helpers', () => {
  it('入力欄だけを editable とみなす', () => {
    expect(isEditableTarget(element('input'))).toBe(true)
    expect(isEditableTarget(element('textarea'))).toBe(true)
    expect(isEditableTarget(element('select'))).toBe(true)
    expect(isEditableTarget(element('div'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })

  it('ボタン・リンク・checkbox を activatable とみなす', () => {
    expect(isActivatableTarget(document.createElement('button'))).toBe(true)
    const link = document.createElement('a')
    link.href = '#'
    expect(isActivatableTarget(link)).toBe(true)
    const role = document.createElement('div')
    role.setAttribute('role', 'button')
    expect(isActivatableTarget(role)).toBe(true)
    expect(isActivatableTarget(document.createElement('div'))).toBe(false)
  })
})
