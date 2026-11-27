import { api } from '../api'
import { describeError } from './format'

/**
 * #24: ファイル ID からフルパスを Rust（`file_path`）で解決してコピーする。
 *
 * UI 側でルートの実パスと相対パスを繋がない（保存形式や区切り文字の扱いを
 * Rust の `db::join_root` と 1 箇所に揃える）。呼び出し側は結果を通知に使う。
 */
export type PathCopyResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

export async function copyFilePath(fileId: number): Promise<PathCopyResult> {
  let path: string
  try {
    path = await api.filePath(fileId)
  } catch (cause) {
    return {
      ok: false,
      message: `パスを取得できませんでした: ${describeError(cause)}`,
    }
  }

  if (typeof path !== 'string' || path.trim() === '') {
    return { ok: false, message: 'パスを取得できませんでした' }
  }

  try {
    await navigator.clipboard.writeText(path)
    return { ok: true, path }
  } catch (cause) {
    return {
      ok: false,
      message: `クリップボードにコピーできませんでした: ${describeError(cause)}`,
    }
  }
}
