/**
 * 一覧・詳細のキーボード操作（#71）を window に登録する。
 *
 * 判定は `src/lib/shortcuts.ts` の純粋関数に任せ、ここではハンドラの呼び分けだけを行う。
 * ダイアログ（`role="dialog"`）が開いている間は何もしない。
 * `onClose` を渡さない画面（ライブラリ）では Esc を消費せず、既存の
 * 「選択解除」にそのまま流す。
 */
import { useEffect, useRef } from 'react'
import { resolveListShortcut } from '../lib/shortcuts'

export type ListShortcutHandlers = {
  onFocusMove?: (delta: 1 | -1) => void
  onRate?: (rating: number | null) => void
  onFavorite?: () => void
  onTogglePlay?: () => void
  onOpen?: () => void
  onClose?: () => void
}

type Options = ListShortcutHandlers & {
  enabled?: boolean
}

export function useListShortcuts({ enabled = true, ...handlers }: Options) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent) => {
      // 比較ビュー・ライトボックス・設定などのダイアログ表示中は下の画面を動かさない
      if (document.querySelector('[role="dialog"]')) return

      const action = resolveListShortcut(event, event.target)
      if (!action) return

      const current = handlersRef.current
      let handled = false

      switch (action.kind) {
        case 'focus':
          if (current.onFocusMove) {
            current.onFocusMove(action.delta)
            handled = true
          }
          break
        case 'rate':
          if (current.onRate) {
            current.onRate(action.rating)
            handled = true
          }
          break
        case 'favorite':
          if (current.onFavorite) {
            current.onFavorite()
            handled = true
          }
          break
        case 'toggle-play':
          if (current.onTogglePlay) {
            current.onTogglePlay()
            handled = true
          }
          break
        case 'open':
          if (current.onOpen) {
            current.onOpen()
            handled = true
          }
          break
        case 'close':
          // 渡されていなければ Esc は既存の画面（選択解除など）に任せる
          if (current.onClose) {
            current.onClose()
            handled = true
          }
          break
      }

      if (handled) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
