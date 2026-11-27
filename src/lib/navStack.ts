/**
 * #33: 画面階層の履歴スタック（純粋な状態遷移）。
 *
 * ```
 * ライブラリ → 作品詳細 → ライトボックス
 * ```
 *
 * React に依存しないので、単体テスト（`tests/nav-stack.test.ts`）から直接叩ける。
 * 実際に画面へ配線するのは `useNavStack`。
 */

export type NavRoute =
  | { kind: 'library' }
  | { kind: 'work'; workId: number }
  | { kind: 'lightbox'; workId: number; fileIndex: number }

/**
 * 画面を離れるときに控えておく状態。
 * 型は使う側が決める（ライブラリならスクロール位置と選択）。
 */
export type NavEntry<S = unknown> = {
  route: NavRoute
  /** この画面に戻ってきたときに復元する状態。 */
  snapshot?: S
}

export type NavHistory<S = unknown> = {
  entries: NavEntry<S>[]
  /** 現在表示している entries の位置。 */
  index: number
}

export const LIBRARY_ROUTE: NavRoute = { kind: 'library' }

/** 戻りすぎでメモリを食わないよう、履歴はこの件数までにする。 */
export const NAV_HISTORY_LIMIT = 64

export function createNavHistory<S = unknown>(
  initial: NavRoute | NavRoute[] = LIBRARY_ROUTE,
): NavHistory<S> {
  const routes = Array.isArray(initial) ? initial : [initial]
  return {
    entries: routes.map((route) => ({ route })),
    index: Math.max(0, routes.length - 1),
  }
}

export function currentEntry<S>(history: NavHistory<S>): NavEntry<S> {
  return history.entries[history.index]
}

export function currentRoute<S>(history: NavHistory<S>): NavRoute {
  return currentEntry(history).route
}

export function canGoBack<S>(history: NavHistory<S>): boolean {
  return history.index > 0
}

export function canGoForward<S>(history: NavHistory<S>): boolean {
  return history.index < history.entries.length - 1
}

export function sameRoute(a: NavRoute, b: NavRoute): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'library') return true
  if (a.kind === 'work') return b.kind === 'work' && a.workId === b.workId
  return b.kind === 'lightbox' && a.workId === b.workId && a.fileIndex === b.fileIndex
}

/** 現在の画面の復元用状態を差し替える（履歴は動かさない）。 */
export function setCurrentSnapshot<S>(
  history: NavHistory<S>,
  snapshot: S | undefined,
): NavHistory<S> {
  if (snapshot === undefined) return history
  const entries = history.entries.slice()
  entries[history.index] = { ...entries[history.index], snapshot }
  return { ...history, index: history.index, entries }
}

/**
 * 1 段進む。`snapshot` は**いま離れる画面**の状態（ライブラリのスクロール位置など）。
 * 進んだ先より後ろの「進む」履歴は捨てる。
 */
export function pushNav<S>(
  history: NavHistory<S>,
  route: NavRoute,
  snapshot?: S,
): NavHistory<S> {
  const base = setCurrentSnapshot(history, snapshot)
  if (sameRoute(currentRoute(base), route)) return base

  const entries = base.entries.slice(0, base.index + 1)
  entries.push({ route })
  if (entries.length > NAV_HISTORY_LIMIT) entries.splice(0, entries.length - NAV_HISTORY_LIMIT)
  return { entries, index: entries.length - 1 }
}

/**
 * 1 段戻る。履歴が空（ライブラリが先頭）なら何もしない。
 * `snapshot` は**いま離れる画面**の状態。
 */
export function backNav<S>(history: NavHistory<S>, snapshot?: S): NavHistory<S> {
  if (!canGoBack(history)) return history
  const base = setCurrentSnapshot(history, snapshot)
  return { entries: base.entries, index: base.index - 1 }
}

/** 1 段進む（「戻る」で戻った先から）。履歴が無ければ何もしない。 */
export function forwardNav<S>(history: NavHistory<S>, snapshot?: S): NavHistory<S> {
  if (!canGoForward(history)) return history
  const base = setCurrentSnapshot(history, snapshot)
  return { entries: base.entries, index: base.index + 1 }
}

/** 現在の履歴を積み直さずに差し替える（ライトボックスの index 更新など）。 */
export function replaceCurrentNav<S>(history: NavHistory<S>, route: NavRoute): NavHistory<S> {
  const entries = history.entries.slice()
  entries[history.index] = { ...entries[history.index], route }
  return { ...history, entries }
}
