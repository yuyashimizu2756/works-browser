/**
 * 比較ビュー（#71）のレイアウトとズーム計算。
 *
 * 2 / 3 / 4 枚で崩れないように、CSS Grid の列・行と各セルの配置を返す。
 * 3 枚は「左に 1 枚（縦 2 行）+ 右に 2 枚」の 1 + 2 構成にする。
 *
 * ズームとパンは比較ビュー全体で 1 つの値（`zoom` / `pan`）を共有し、
 * 各セルに同じ transform を掛けることで相対位置を揃える。
 */

export const MIN_COMPARE_ITEMS = 2
export const MAX_COMPARE_ITEMS = 4

export const COMPARE_MIN_ZOOM = 0.2
export const COMPARE_MAX_ZOOM = 8

export type CompareCellPlacement = {
  /** CSS の `grid-column` にそのまま渡す値。 */
  gridColumn: string
  /** CSS の `grid-row` にそのまま渡す値。 */
  gridRow: string
}

export type CompareLayout = {
  /** 実際に並べる枚数（2〜4 に丸めた値）。 */
  count: number
  columns: number
  rows: number
  cells: CompareCellPlacement[]
  /** `style` にそのまま展開できるグリッド定義。 */
  style: {
    gridTemplateColumns: string
    gridTemplateRows: string
  }
}

/** 2〜4 に丸める。比較ビューを開く側もこの範囲だけを渡す。 */
export function normalizeCompareCount(count: number): number {
  if (!Number.isFinite(count)) return MIN_COMPARE_ITEMS
  return Math.min(MAX_COMPARE_ITEMS, Math.max(MIN_COMPARE_ITEMS, Math.trunc(count)))
}

export function canCompare(count: number): boolean {
  return count >= MIN_COMPARE_ITEMS && count <= MAX_COMPARE_ITEMS
}

/** 2 / 3 / 4 枚のグリッド配置。 */
export function compareLayout(count: number): CompareLayout {
  const normalized = normalizeCompareCount(count)
  const style = {
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gridTemplateRows:
      normalized === 2 ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))',
  }

  if (normalized === 2) {
    return {
      count: 2,
      columns: 2,
      rows: 1,
      cells: [
        { gridColumn: '1', gridRow: '1' },
        { gridColumn: '2', gridRow: '1' },
      ],
      style,
    }
  }

  if (normalized === 3) {
    return {
      count: 3,
      columns: 2,
      rows: 2,
      cells: [
        // 左に大きく 1 枚（1 + 2 構成）
        { gridColumn: '1', gridRow: '1 / span 2' },
        { gridColumn: '2', gridRow: '1' },
        { gridColumn: '2', gridRow: '2' },
      ],
      style,
    }
  }

  return {
    count: 4,
    columns: 2,
    rows: 2,
    cells: [
      { gridColumn: '1', gridRow: '1' },
      { gridColumn: '2', gridRow: '1' },
      { gridColumn: '1', gridRow: '2' },
      { gridColumn: '2', gridRow: '2' },
    ],
    style,
  }
}

export function clampCompareZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(COMPARE_MAX_ZOOM, Math.max(COMPARE_MIN_ZOOM, zoom))
}

/** ホイール 1 回分のズーム。上方向（deltaY < 0）で拡大する。 */
export function zoomAfterWheel(zoom: number, deltaY: number): number {
  const safeDelta = Number.isFinite(deltaY) ? deltaY : 0
  return clampCompareZoom(zoom * Math.exp(-safeDelta * 0.0015))
}

/** 拡大中だけドラッグでパンできる（等倍以下では画像を動かさない）。 */
export function canPan(zoom: number): boolean {
  return zoom > 1.001
}
