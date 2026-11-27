/**
 * 表示用の絶対パス（#8 の「パスをコピー」）。
 *
 * DB はルートの実パス（`roots.real_path`）と、ルートからの相対パス
 * （`files.rel_path`）しか持たない。UI 側でこの 2 つを繋いで、エクスプローラに
 * 貼り付けられる形にする。保存されている相対パスは `/` 区切りのことがあるため
 * `\` に揃える（Rust 側の `db::join_root` と同じ扱い）。
 */

/** `root` と `rel` を Windows の区切り文字で繋ぐ。空の要素は無視する。 */
export function joinWindowsPath(root: string, rel: string): string {
  const base = root.replace(/[\\/]+$/, '')
  const rest = rel.replace(/^[\\/]+/, '').replace(/[/\\]+/g, '\\')
  if (rest === '') return base
  return base === '' ? rest : `${base}\\${rest}`
}

/**
 * ファイルの絶対パス。ルートの実パスが分からないとき（ベンチ / 取得失敗）は null。
 */
export function fileAbsolutePath(
  rootRealPath: string | null | undefined,
  relPath: string,
): string | null {
  if (!rootRealPath || rootRealPath.trim() === '') return null
  return joinWindowsPath(rootRealPath, relPath)
}
