import { useEffect, useRef } from 'react'
import { isEditableTarget, resolveLibraryShortcut } from '../lib/shortcuts'
import type { LibraryViewMode } from '../lib/viewMode'

type Options = {
  /** 詳細画面など、ライブラリ以外では登録しない。 */
  enabled: boolean
  onViewModeChange: (mode: LibraryViewMode) => void
  onToggleThumbnails: () => void
  /** `Ctrl+1..9` は 0 始まりのルート位置、`Ctrl+0` は `null`（すべて）。 */
  onSelectRoot: (index: number | null) => void
}

/**
 * ライブラリ全体のキーバインド（#21 / #55 / #88）。
 *
 * - `Alt+1` / `Alt+2` / `Alt+3` … 作品 / ファイル / タイムライン
 * - `Ctrl+Shift+T` … タイムライン（#81。`Alt+3` と同じ動作）
 * - `Ctrl+Shift+H` … サムネ表示の切り替え
 * - `Ctrl+1..9` / `Ctrl+0` … ルートの絞り込み（#55。`0` はすべて）
 *
 * #88: 以前は表示モード（このフック）とルート絞り込み（`LibraryView`）が別々の
 * `keydown` リスナーで同じ `Ctrl+1` に反応していた。いまは `resolveLibraryShortcut` が
 * 返す **1 件の意図だけ**をここで実行するので、1 つのキーを 2 か所が処理しない。
 *
 * ルート絞り込みだけは従来どおり、入力欄とダイアログ表示中は動かさない。
 * Windows 専用なので `Ctrl` だけで受ける（`⌘` は使わない）。
 * 状態の保存は `preferences.ts`（`config.json`）が行う。
 */
export function useLibraryShortcuts({
  enabled,
  onViewModeChange,
  onToggleThumbnails,
  onSelectRoot,
}: Options) {
  const handlersRef = useRef({ onViewModeChange, onToggleThumbnails, onSelectRoot })
  handlersRef.current = { onViewModeChange, onToggleThumbnails, onSelectRoot }

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (event: KeyboardEvent) => {
      // 先に処理したリスナー（一覧の j/k など）のキーは奪わない
      if (event.defaultPrevented) return

      const intent = resolveLibraryShortcut(event)
      if (!intent) return

      const current = handlersRef.current

      if (intent.kind === 'view-mode') {
        event.preventDefault()
        current.onViewModeChange(intent.mode)
        return
      }

      if (intent.kind === 'toggle-thumbnails') {
        event.preventDefault()
        current.onToggleThumbnails()
        return
      }

      // ルート絞り込みは入力中・ダイアログ表示中に動かさない（#55）
      if (isEditableTarget(event.target)) return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      current.onSelectRoot(intent.index)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
