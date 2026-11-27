import { useCallback, useState } from 'react'
import type { NavHistory, NavRoute } from './navStack'
import {
  backNav,
  canGoBack,
  canGoForward,
  createNavHistory,
  currentEntry,
  currentRoute,
  forwardNav,
  pushNav,
  replaceCurrentNav,
  setCurrentSnapshot,
} from './navStack'

export type { NavEntry, NavHistory, NavRoute } from './navStack'
export { LIBRARY_ROUTE } from './navStack'

type UseNavStack<S> = {
  route: NavRoute
  /** 現在の画面に戻ってきたときに復元する状態。 */
  snapshot: S | undefined
  canGoBack: boolean
  canGoForward: boolean
  /** 1 段進む。`snapshot` は離れる画面（いま表示中）の状態。 */
  push: (route: NavRoute, snapshot?: S) => void
  /**
   * 1 段戻る。履歴が空なら何もしない。
   * `priority` が true を返したときはダイアログを閉じるなどが優先され、履歴は動かさない。
   */
  back: (priority?: () => boolean, snapshot?: S) => void
  forward: (snapshot?: S) => void
  /** 履歴を積まずに現在のルートだけ差し替える（ライトボックスの index 更新）。 */
  replace: (route: NavRoute) => void
  /** 現在の画面の復元用状態だけ更新する。 */
  capture: (snapshot: S | undefined) => void
}

/**
 * #33: 画面階層（ライブラリ → 作品詳細 → ライトボックス）の履歴。
 *
 * 状態遷移は `navStack.ts` の純粋関数に任せ、ここでは React の state に載せるだけ。
 */
export function useNavStack<S = unknown>(initial?: NavRoute | NavRoute[]): UseNavStack<S> {
  const [history, setHistory] = useState<NavHistory<S>>(() => createNavHistory<S>(initial))

  const push = useCallback((route: NavRoute, snapshot?: S) => {
    setHistory((previous) => pushNav(previous, route, snapshot))
  }, [])

  const back = useCallback((priority?: () => boolean, snapshot?: S) => {
    if (priority?.()) return
    setHistory((previous) => backNav(previous, snapshot))
  }, [])

  const forward = useCallback((snapshot?: S) => {
    setHistory((previous) => forwardNav(previous, snapshot))
  }, [])

  const replace = useCallback((route: NavRoute) => {
    setHistory((previous) => replaceCurrentNav(previous, route))
  }, [])

  const capture = useCallback((snapshot: S | undefined) => {
    setHistory((previous) => setCurrentSnapshot(previous, snapshot))
  }, [])

  return {
    route: currentRoute(history),
    snapshot: currentEntry(history).snapshot,
    canGoBack: canGoBack(history),
    canGoForward: canGoForward(history),
    push,
    back,
    forward,
    replace,
    capture,
  }
}
