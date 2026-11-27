import { isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { PathCheck } from '../api'

/** ダイアログ / ドロップで受け取った候補。深さを選んで追加するステップに使う。 */
export type PendingRoots = {
  /** フォルダだけを検証済みで保持する（ファイルは `skippedFiles` に数える）。 */
  checks: PathCheck[]
  /** 一緒に落とされたファイルなど、フォルダ以外の件数。 */
  skippedFiles: number
  /** どこから来たか（文言の出し分け用）。 */
  source: 'picker' | 'drop'
}

export const NOT_DESKTOP_MESSAGE =
  'フォルダ選択ダイアログはデスクトップアプリで使えます（npm run tauri dev または配布版）'

/**
 * OS のフォルダ選択ダイアログを開く（複数選択可）。
 * キャンセルなら空配列。ブラウザ単体（Tauri なし）ではエラーにする。
 */
export async function pickFolders(): Promise<string[]> {
  if (!isTauri()) throw new Error(NOT_DESKTOP_MESSAGE)
  const selected = await open({
    directory: true,
    multiple: true,
    title: '走査するフォルダを選択',
  })
  if (selected === null) return []
  return Array.isArray(selected) ? selected : [selected]
}
