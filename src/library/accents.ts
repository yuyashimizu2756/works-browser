/**
 * ルート識別のアクセント色。
 *
 * #96 で「紫 1 色」に統一したため、どのルートも同じ `--accent` を返す。
 * 将来ルートごとに色を戻す場合も、値は `src/index.css` の CSS 変数に置く。
 */
export const ROOT_ACCENT_TOKENS = ['var(--brand)'] as const

export const ROOT_ACCENT_NAMES = ['accent'] as const

export type RootAccentName = (typeof ROOT_ACCENT_NAMES)[number]

/** ルート ID の一覧から、ID → CSS 変数 の対応を作る。 */
export function buildRootAccentMap(rootIds: number[]): Map<number, string> {
  const ordered = [...new Set(rootIds)].sort((a, b) => a - b)
  return new Map(
    ordered.map((id, index) => [id, ROOT_ACCENT_TOKENS[index % ROOT_ACCENT_TOKENS.length]]),
  )
}

/** マップに無い ID（削除済みルートなど）のフォールバック込みで引く。 */
export function rootAccentFor(
  accents: Map<number, string>,
  rootId: number | null | undefined,
): string {
  if (rootId == null) return ROOT_ACCENT_TOKENS[0]
  return accents.get(rootId) ?? ROOT_ACCENT_TOKENS[(Math.max(1, rootId) - 1) % ROOT_ACCENT_TOKENS.length]
}
