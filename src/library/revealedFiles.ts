import { createContext, useContext } from 'react'

/**
 * サムネ非表示中に「このファイル / この作品だけ一時的に表示する」ための状態
 * （#52 / #121）。
 *
 * - **永続化しない**（再起動・再スキャンで消える）
 * - 全体トグル（サムネ非表示）が切り替わるたびに空へ戻す
 * - `enabled` は「全体が非表示かどうか」。false のときは個別ボタンを出さない
 */
export type RevealedFilesValue = {
  enabled: boolean
  revealed: ReadonlySet<number>
  /** #121: 作品カードの「この作品のサムネイルを表示」状態。 */
  revealedWorks: ReadonlySet<number>
  toggle: (fileId: number) => void
  reveal: (fileId: number) => void
  /** #121: 作品単位の個別表示。 */
  toggleWork: (workId: number) => void
}

export const RevealedFilesContext = createContext<RevealedFilesValue>({
  enabled: false,
  revealed: new Set<number>(),
  revealedWorks: new Set<number>(),
  toggle: () => undefined,
  reveal: () => undefined,
  toggleWork: () => undefined,
})

export function useRevealedFiles(): RevealedFilesValue {
  return useContext(RevealedFilesContext)
}

/** 個別表示のトグル（#52）。新しい Set を返す。 */
export function toggleRevealedFile(
  current: ReadonlySet<number>,
  fileId: number,
): ReadonlySet<number> {
  const next = new Set(current)
  if (next.has(fileId)) next.delete(fileId)
  else next.add(fileId)
  return next
}

/** 作品単位の個別表示のトグル（#121）。ファイル版と同じ規則。 */
export function toggleRevealedWork(
  current: ReadonlySet<number>,
  workId: number,
): ReadonlySet<number> {
  const next = new Set(current)
  if (next.has(workId)) next.delete(workId)
  else next.add(workId)
  return next
}

/** 全体トグルが変わったときのリセット（#52 / #121）。 */
export function resetRevealed(): ReadonlySet<number> {
  return new Set<number>()
}

/** そのファイルのサムネを実際に表示するか（#52）。 */
export function shouldRevealThumb(
  globalHidden: boolean,
  revealed: ReadonlySet<number>,
  fileId: number,
): boolean {
  return globalHidden && revealed.has(fileId)
}

/** その作品のサムネを実際に表示するか（#121）。 */
export function shouldRevealWorkThumb(
  globalHidden: boolean,
  revealedWorks: ReadonlySet<number>,
  workId: number,
): boolean {
  return globalHidden && revealedWorks.has(workId)
}
