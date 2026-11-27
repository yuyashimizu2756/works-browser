import { expect, test } from 'vitest'
import {
  backNav,
  canGoBack,
  canGoForward,
  createNavHistory,
  currentEntry,
  currentRoute,
  forwardNav,
  NAV_HISTORY_LIMIT,
  pushNav,
  replaceCurrentNav,
  sameRoute,
} from '../src/lib/navStack.ts'

type Snapshot = { scrollTop: number; selection: number[] }

const LIBRARY = { kind: 'library' } as const
const work = (workId: number) => ({ kind: 'work', workId }) as const
const lightbox = (workId: number, fileIndex: number) =>
  ({ kind: 'lightbox', workId, fileIndex }) as const

// ---------------------------------------------------------------------------
// push / back / forward
// ---------------------------------------------------------------------------

test('初期状態はライブラリで、戻る履歴は空', () => {
  const history = createNavHistory<Snapshot>()
  expect(currentRoute(history)).toEqual(LIBRARY)
  expect(canGoBack(history)).toBe(false)
  expect(canGoForward(history)).toBe(false)
  // 履歴が空の「戻る」は no-op（同じ参照を返す）
  expect(backNav(history)).toBe(history)
})

test('ライブラリ → 詳細 → ライトボックス の順に push でき、1 段ずつ戻れる', () => {
  let history = createNavHistory<Snapshot>()
  history = pushNav(history, work(7))
  history = pushNav(history, lightbox(7, 3))

  expect(currentRoute(history)).toEqual(lightbox(7, 3))
  expect(canGoBack(history)).toBe(true)
  expect(canGoForward(history)).toBe(false)

  history = backNav(history)
  expect(currentRoute(history)).toEqual(work(7))

  history = backNav(history)
  expect(currentRoute(history)).toEqual(LIBRARY)
  expect(canGoBack(history)).toBe(false)

  // ライブラリより前には戻らない
  expect(backNav(history)).toBe(history)
})

test('戻った先から進むと元の画面に戻る（進む履歴がある場合のみ）', () => {
  let history = createNavHistory<Snapshot>()
  history = pushNav(history, work(3))
  history = backNav(history)
  expect(canGoForward(history)).toBe(true)

  history = forwardNav(history)
  expect(currentRoute(history)).toEqual(work(3))
  expect(canGoForward(history)).toBe(false)
  expect(forwardNav(history)).toBe(history)
})

test('戻ったあとに push すると、進む側の履歴は捨てる', () => {
  let history = createNavHistory<Snapshot>()
  history = pushNav(history, work(1))
  history = pushNav(history, lightbox(1, 0))
  history = backNav(history) // work(1)
  history = backNav(history) // library
  history = forwardNav(history) // work(1)
  history = pushNav(history, work(2))

  expect(currentRoute(history)).toEqual(work(2))
  expect(canGoForward(history)).toBe(false)
  history = backNav(history)
  expect(currentRoute(history)).toEqual(work(1))
})

test('同じ画面への push は履歴を増やさない', () => {
  let history = createNavHistory<Snapshot>()
  const pushed = pushNav(history, LIBRARY)
  expect(pushed.index).toBe(history.index)
  expect(pushed.entries.length).toBe(1)

  history = pushNav(history, work(9))
  const again = pushNav(history, work(9))
  expect(again.entries.length).toBe(history.entries.length)
  expect(currentRoute(again)).toEqual(work(9))
})

// ---------------------------------------------------------------------------
// スクロール位置・選択の保持
// ---------------------------------------------------------------------------

test('離れるときの状態を控え、戻ったときにその画面の状態を復元できる', () => {
  let history = createNavHistory<Snapshot>()
  const libraryState: Snapshot = { scrollTop: 1200, selection: [4, 8] }

  // ライブラリを離れる瞬間の状態を push に渡す
  history = pushNav(history, work(4), libraryState)
  expect(currentEntry(history).snapshot).toBeUndefined() // 詳細には状態なし
  history = backNav(history)

  expect(currentRoute(history)).toEqual(LIBRARY)
  expect(currentEntry(history).snapshot).toEqual(libraryState)
})

test('戻る・進むを繰り返しても、それぞれの画面の状態が保たれる', () => {
  let history = createNavHistory<Snapshot>()
  const libraryState: Snapshot = { scrollTop: 400, selection: [] }
  const detailState: Snapshot = { scrollTop: 80, selection: [2] }

  history = pushNav(history, work(2), libraryState)
  history = pushNav(history, lightbox(2, 5), detailState)

  // ライトボックス → 詳細（詳細を離れたときの状態が残っている）
  history = backNav(history)
  expect(currentEntry(history).snapshot).toEqual(detailState)

  // 詳細 → ライブラリ
  history = backNav(history)
  expect(currentEntry(history).snapshot).toEqual(libraryState)

  // 進むとまた詳細へ戻れる
  history = forwardNav(history)
  expect(currentRoute(history)).toEqual(work(2))
})

// ---------------------------------------------------------------------------
// ライトボックスの index 更新（履歴を積まない）
// ---------------------------------------------------------------------------

test('ライトボックスの index 変更は置き換えで、履歴の段数は変わらない', () => {
  let history = createNavHistory<Snapshot>()
  history = pushNav(history, work(5))
  history = pushNav(history, lightbox(5, 0))
  const depth = history.entries.length

  history = replaceCurrentNav(history, lightbox(5, 12))
  expect(currentRoute(history)).toEqual(lightbox(5, 12))
  expect(history.entries.length).toBe(depth)
})

// ---------------------------------------------------------------------------
// ダイアログ優先の「戻る」
// ---------------------------------------------------------------------------

test('ダイアログが開いている間は、戻るがダイアログを閉じる方を優先する', () => {
  let history = createNavHistory<Snapshot>()
  history = pushNav(history, work(1))
  let closed = 0
  const closeDialog = () => {
    closed += 1
    return true // ダイアログを閉じたので履歴は動かさない
  }

  // useNavStack の back と同じ順序: priority が true なら履歴を動かさない
  const depth = history.entries.length
  if (!closeDialog()) history = backNav(history)
  expect(closed).toBe(1)
  expect(history.entries.length).toBe(depth)
  expect(currentRoute(history)).toEqual(work(1))

  // ダイアログが無ければ通常の戻る
  const nothingToClose = () => false
  if (!nothingToClose()) history = backNav(history)
  expect(currentRoute(history)).toEqual(LIBRARY)
})

// ---------------------------------------------------------------------------
// その他
// ---------------------------------------------------------------------------

test('ルートの同一判定は種類と ID（ライトボックスは index も）を見る', () => {
  expect(sameRoute(LIBRARY, LIBRARY)).toBe(true)
  expect(sameRoute(work(1), work(1))).toBe(true)
  expect(sameRoute(work(1), work(2))).toBe(false)
  expect(sameRoute(lightbox(1, 0), lightbox(1, 0))).toBe(true)
  expect(sameRoute(lightbox(1, 0), lightbox(1, 1))).toBe(false)
  expect(sameRoute(work(1), lightbox(1, 0))).toBe(false)
})

test('履歴が上限を超えたら古いものから捨てる', () => {
  let history = createNavHistory<Snapshot>()
  for (let index = 0; index < NAV_HISTORY_LIMIT + 5; index += 1) {
    history = pushNav(history, work(index + 1))
  }
  expect(history.entries.length).toBe(NAV_HISTORY_LIMIT)
  expect(history.index).toBe(NAV_HISTORY_LIMIT - 1)
  expect(currentRoute(history)).toEqual(work(NAV_HISTORY_LIMIT + 5))
})
