import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * #115: 画面下中央のトーストを 1 つのスタックに集約する。
 *
 * 削除 / 移動の Undo、評価・コピーなどの通知は、これまで別々の `fixed` で
 * 重なっていた。ここでは store に積んだ順（古い → 新しい）で縦に並べ、
 * 新しいものが下、間隔 8px、最大 3 件にする。
 *
 * 見た目（枠・背景・影・12px）はこの 1 箇所だけが持つ。中身は呼び出し側が
 * 渡し、タイマーや操作の状態管理も従来どおり呼び出し側に残す。
 */

export type ToastEntry = {
  /** 同じ key のトーストは置き換える（文言だけが変わる通知向け）。 */
  key?: string
  content: ReactNode
  /** 幅を固定したいとき（Undo の 420 / 460px など）。未指定なら内容に合わせる。 */
  width?: string
  /** 自動で消すまでのミリ秒。未指定なら消えない（呼び出し側が管理する）。 */
  duration?: number
  /** 自動消滅したときの通知（Undo の状態を null に戻すなど）。 */
  onExpire?: () => void
  /** 最大 3 件を超えて押し出されたときの通知。 */
  onEvict?: () => void
}

type ToastRecord = ToastEntry & { id: number }

const MAX_VISIBLE = 3
const listeners = new Set<() => void>()
let entries: ToastRecord[] = []
let nextId = 1
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return entries
}

function clearTimer(id: number) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

function schedule(record: ToastRecord) {
  clearTimer(record.id)
  if (!record.duration || record.duration <= 0) return
  timers.set(
    record.id,
    setTimeout(() => {
      timers.delete(record.id)
      if (!entries.some((entry) => entry.id === record.id)) return
      entries = entries.filter((entry) => entry.id !== record.id)
      emit()
      record.onExpire?.()
    }, record.duration),
  )
}

/**
 * トーストを積む。返した id を `removeToast` に渡すと取り除ける。
 * 4 件目以降は一番古いものを押し出す。
 */
export function pushToast(entry: ToastEntry): number {
  const existing = entry.key
    ? entries.find((candidate) => candidate.key === entry.key)
    : undefined

  if (existing) {
    const replacement: ToastRecord = { ...entry, id: existing.id }
    entries = entries.map((candidate) => (candidate.id === existing.id ? replacement : candidate))
    schedule(replacement)
    emit()
    return existing.id
  }

  const record: ToastRecord = { ...entry, id: nextId++ }
  entries = [...entries, record]

  const evicted: ToastRecord[] = []
  while (entries.length > MAX_VISIBLE) {
    const oldest = entries[0]
    entries = entries.slice(1)
    clearTimer(oldest.id)
    evicted.push(oldest)
  }

  schedule(record)
  emit()

  for (const item of evicted) item.onEvict?.()
  return record.id
}

/** トーストを取り除く（アンマウント時の後始末にも使う）。 */
export function removeToast(id: number) {
  if (!entries.some((entry) => entry.id === id)) return
  clearTimer(id)
  entries = entries.filter((entry) => entry.id !== id)
  emit()
}

/** 中身だけ差し替える（タイマーは張り直さない）。 */
export function updateToast(id: number, patch: Partial<Omit<ToastEntry, 'key'>>) {
  const current = entries.find((entry) => entry.id === id)
  if (!current) return
  entries = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
  emit()
}

/** テスト用。積んであるトーストをすべて捨てる。 */
export function clearToasts() {
  for (const id of timers.keys()) clearTimer(id)
  timers.clear()
  entries = []
  emit()
}

/** 文言だけの通知。呼び出し側は state を持たず pushToast に渡す。 */
export function ToastMessage({ message }: { message: ReactNode }) {
  return <p className="m-0 px-3 py-2 text-xs break-words">{message}</p>
}

/** 画面下中央のホスト。App で 1 回だけ描画する。 */
export function ToastStack() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      data-toast-stack
      className="pointer-events-none fixed inset-x-0 bottom-5 z-[95] flex flex-col items-center"
      style={{ gap: 8 }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-toast-item
          role="status"
          aria-live="polite"
          className="pointer-events-auto max-w-[92vw] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--raised)] text-xs text-[var(--text-primary)] shadow-[var(--shadow-panel)] motion-safe:animate-[toast-in_var(--duration-fast)_var(--ease-standard)]"
          style={item.width ? { width: item.width } : undefined}
        >
          {item.content}
        </div>
      ))}
    </div>,
    document.body,
  )
}
