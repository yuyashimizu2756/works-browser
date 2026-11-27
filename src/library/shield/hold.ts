/**
 * 長押し判定の純粋ロジック（#22）。
 *
 * タイマーは呼び出し側（`usePrivacyShield`）が持ち、ここでは
 * 「押してからどれだけ経ったか」だけを見る。テストのために時計を注入できる。
 */

export type ShieldOutcome = 'activate' | 'restore' | null

/**
 * ホットキー押下時の結果。
 *
 * - シールド中でなければ、押した瞬間に発動（誤操作より隠す速さを優先）
 * - シールド中は `holdMs` 以上押し続けたときだけ解除（誤操作防止）
 */
export function hotkeyOutcome(params: {
  shielded: boolean
  holdMs: number
  heldMs: number
}): ShieldOutcome {
  if (!params.shielded) return 'activate'
  return params.heldMs >= params.holdMs ? 'restore' : null
}

/**
 * Esc 長押しの結果。シールド中は何もしない（解除は「戻す」かホットキー長押し）。
 */
export function escHoldOutcome(params: {
  shielded: boolean
  holdMs: number
  heldMs: number
}): ShieldOutcome {
  if (params.shielded) return null
  return params.heldMs >= params.holdMs ? 'activate' : null
}

/** 押下開始から解除までの経過（負の値は 0）。 */
export function heldFor(startedAt: number, now: number): number {
  return Math.max(0, now - startedAt)
}
