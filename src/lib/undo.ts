/**
 * 削除の Undo（取り消し）カウントダウン（#15 の下準備）。
 *
 * 削除トーストは数秒間だけ「元に戻す」を受け付け、残り時間を表示する。
 * ここではタイマーを直接持たず、経過ミリ秒を渡して次の状態を返す純粋な
 * ステートマシンにしておく（`setInterval` 側は 100ms ごとに `tickUndo` を呼ぶ）。
 */

export type UndoCountdown = {
  /** 残りミリ秒（0 で期限切れ）。 */
  remainingMs: number
  /** 開始時の猶予（進捗バー用）。 */
  totalMs: number
}

/** カウントダウンを開始する。0 以下なら即座に期限切れ。 */
export function startUndo(totalMs: number): UndoCountdown {
  return { remainingMs: Math.max(0, totalMs), totalMs: Math.max(0, totalMs) }
}

/** 時間を進める。残りは 0 未満にならない。 */
export function tickUndo(state: UndoCountdown, elapsedMs: number): UndoCountdown {
  return {
    remainingMs: Math.max(0, state.remainingMs - Math.max(0, elapsedMs)),
    totalMs: state.totalMs,
  }
}

/** 残り秒（切り上げ）。トーストの「あと 3 秒」表示に使う。 */
export function undoSeconds(state: UndoCountdown): number {
  return Math.ceil(state.remainingMs / 1000)
}

/** 期限切れか。 */
export function undoExpired(state: UndoCountdown): boolean {
  return state.remainingMs <= 0
}

/** 進捗 0〜1（残りが減るほど 1 に近づく）。 */
export function undoProgress(state: UndoCountdown): number {
  if (state.totalMs <= 0) return 1
  return Math.min(1, Math.max(0, 1 - state.remainingMs / state.totalMs))
}
