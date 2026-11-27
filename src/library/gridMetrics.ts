/**
 * 作品グリッドの寸法（#98）。
 *
 * 列数・カード幅・カード高さを 1 箇所で決める。`WorkGrid` は仮想スクロールの
 * 行送りに、`TimelineView` は日別セクションの行送りに、`WorkCard` はカバー高さに
 * 同じ値を使う。カバーは 4:3 固定なので、カード高さは幅から決まる。
 *
 * 目安: 1280×800（サイドバー 240px を引いた幅 ≒ 1040）で 4 列、
 * 1920×1080（同 ≒ 1680）で 6 列。
 */

/** カード間の間隔（--space-4）。 */
export const GRID_GAP = 16
/** グリッドの外側余白（--space-6）。 */
export const GRID_PADDING = 24
/**
 * カバーより下のメタ部分の高さ。
 * 題名 15px / 行間 20px + 余白 12×2 + 間隔 4 + 補助 12px / 行間 18px = 66px。
 * `WorkCard` のメタも同じ固定高さにして、仮想スクロールの行送りとずれないようにする。
 */
export const CARD_META_HEIGHT = 66

export type GridMetrics = {
  columns: number
  /** グリッド内側のカード幅（px）。viewport が 0 の間は 0。 */
  cardWidth: number
  /** 4:3 のカバー高さ（px）。 */
  coverHeight: number
  /** カバー + メタ（px）。 */
  cardHeight: number
}

/** 内側の幅（外側余白を引いた値）から列数を決める。3〜6 列に収める。 */
export function gridColumnsFor(viewportWidth: number, padding = GRID_PADDING): number {
  const content = Math.max(0, viewportWidth - padding * 2)
  if (content >= 1560) return 6
  if (content >= 1240) return 5
  if (content >= 880) return 4
  return 3
}

/** 幅に応じた列数とカード寸法。カバーは常に 4:3。 */
export function gridMetricsFor(viewportWidth: number, padding = GRID_PADDING): GridMetrics {
  const content = Math.max(0, viewportWidth - padding * 2)
  if (content <= 0) {
    return { columns: 3, cardWidth: 0, coverHeight: 0, cardHeight: CARD_META_HEIGHT }
  }
  const columns = gridColumnsFor(viewportWidth, padding)
  const cardWidth = (content - GRID_GAP * (columns - 1)) / columns
  const coverHeight = Math.round((cardWidth * 3) / 4)
  return { columns, cardWidth, coverHeight, cardHeight: coverHeight + CARD_META_HEIGHT }
}

/**
 * #100: スケルトン用の寸法。読み込み中は実データの列数に関係なく
 * **3 列 × 2 行**で描くため、列数だけ 3 に固定した同じ計算を使う。
 */
export function skeletonMetricsFor(
  viewportWidth: number,
  padding = GRID_PADDING,
  columns = 3,
): GridMetrics {
  const content = Math.max(0, viewportWidth - padding * 2)
  if (content <= 0) {
    return { columns, cardWidth: 0, coverHeight: 0, cardHeight: CARD_META_HEIGHT }
  }
  const cardWidth = (content - GRID_GAP * (columns - 1)) / columns
  const coverHeight = Math.round((cardWidth * 3) / 4)
  return { columns, cardWidth, coverHeight, cardHeight: coverHeight + CARD_META_HEIGHT }
}
