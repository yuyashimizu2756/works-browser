/**
 * キーボード操作の定義と判定（#71 / #82 / #88）。
 *
 * **表示用のキー表記と実キー判定を 1 箇所（`SHORTCUT_DEFINITIONS`）に集約**する。
 * `?` で開くショートカット一覧（`src/library/ShortcutsHelp.tsx`）はこの定義をそのまま
 * 描画し、一覧・詳細のキー処理（`resolveListShortcut` / `matchesShortcut`）も同じ定義を
 * 参照する。表記と挙動がずれないようにするための土台。
 *
 * 判定だけを純粋関数に切り出し、`useListShortcuts`（`src/library`）が
 * `KeyboardEvent` を渡して使う。入力欄・修飾キー付き・IME 変換中は何も返さないので、
 * `/` 検索・`Delete`・`Ctrl+1..9`（ルート切替）・`Ctrl+Shift+P`（シールド）と競合しない。
 *
 * Windows 専用なので `Ctrl` だけを見る（`⌘` は使わない）。
 */

import type { LibraryViewMode } from './viewMode'

/** `KeyboardEvent` から判定に必要な項目だけを抜いたもの（テストしやすくするため）。 */
export type KeyInput = {
  key: string
  code?: string
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
}

export type ListShortcut =
  | { kind: 'focus'; delta: 1 | -1 }
  | { kind: 'rate'; rating: number | null }
  | { kind: 'favorite' }
  | { kind: 'toggle-play' }
  | { kind: 'open' }
  | { kind: 'close' }

/**
 * ショートカット一覧の分類。並び順がそのままモーダルの表示順になる。
 * `list` 一覧 / `detail` 詳細 / `compare` 比較・差分 / `global` 全体。
 */
export type ShortcutGroup = 'list' | 'detail' | 'compare' | 'global'

export const SHORTCUT_GROUPS: readonly { id: ShortcutGroup; label: string }[] = [
  { id: 'list', label: '一覧' },
  { id: 'detail', label: '詳細' },
  { id: 'compare', label: '比較・差分' },
  { id: 'global', label: '全体' },
]

/** 実キー判定に使う条件。省略した修飾キーは「押されていない」とみなす（`shift` 以外）。 */
export type ShortcutMatch = {
  /** `KeyboardEvent.key`（`J` と `j` のように複数指定できる）。 */
  key?: string | string[]
  /** `KeyboardEvent.code`（配列のときはどれか 1 つ）。 */
  code?: string | string[]
  /** 数字キーなど、表示が範囲になっている場合の `key` 候補。 */
  values?: string[]
  /** `Ctrl` 必須か（省略時は `Ctrl` なし）。 */
  ctrl?: boolean
  /** `Alt` 必須か（省略時は `Alt` なし）。表示モード切替が使う（#88）。 */
  alt?: boolean
  /** 指定したときだけ `Shift` の有無を厳密に見る（`?` は Shift 付きで届くため）。 */
  shift?: boolean
}

/** 一覧・詳細の `resolveListShortcut` が返す動作。 */
type ListIntent =
  | { kind: 'focus'; delta: 1 | -1 }
  | { kind: 'rate' }
  | { kind: 'favorite' }
  | { kind: 'toggle-play' }
  | { kind: 'open' }
  | { kind: 'close' }

export type ShortcutDefinition = {
  /** 一意な id。キー処理から参照する。 */
  id: string
  group: ShortcutGroup
  /** 表示用のキー表記（Windows。`Ctrl+Shift+P` のように Ctrl → Shift の順）。 */
  keys: string
  description: string
  /**
   * 実キー判定に使う条件。無いものは表示だけ（比較ビューの起動など）。
   * 配列にすると、どれか 1 つに一致すればよい（同じ動作に複数のキーを割り当てる）。
   */
  match?: ShortcutMatch | ShortcutMatch[]
  /** `resolveListShortcut` の動作。一覧・詳細のキーに付ける。 */
  list?: ListIntent
}

/**
 * ショートカットの唯一の定義。
 *
 * 追加するときはここだけを直す。`keys`（ヘルプの表記）と `match`（実キー）を
 * 同じ行に並べておくことで、二重管理を避ける。
 */
export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  // ---------------------------------------------------------------------------
  // 一覧（ライブラリ / ファイルモード）
  // ---------------------------------------------------------------------------
  {
    id: 'focus-next',
    group: 'list',
    keys: 'J',
    description: '次の作品・ファイルへフォーカス',
    match: { key: ['j', 'J'] },
    list: { kind: 'focus', delta: 1 },
  },
  {
    id: 'focus-prev',
    group: 'list',
    keys: 'K',
    description: '前の作品・ファイルへフォーカス',
    match: { key: ['k', 'K'] },
    list: { kind: 'focus', delta: -1 },
  },
  {
    id: 'rate',
    group: 'list',
    keys: '1〜5',
    description: 'フォーカス中の作品を評価（1〜5）',
    match: { values: ['1', '2', '3', '4', '5'] },
    list: { kind: 'rate' },
  },
  {
    id: 'unrated',
    group: 'list',
    keys: '0',
    description: '評価を未評価に戻す',
    match: { values: ['0'] },
    list: { kind: 'rate' },
  },
  {
    id: 'favorite',
    group: 'list',
    keys: 'F',
    description: 'お気に入りを切り替え',
    match: { key: ['f', 'F'] },
    list: { kind: 'favorite' },
  },
  {
    id: 'toggle-play',
    group: 'list',
    keys: 'Space',
    description: 'フォーカス中の動画を開いて再生 / 停止',
    match: { key: ' ', code: 'Space' },
    list: { kind: 'toggle-play' },
  },
  {
    id: 'open',
    group: 'list',
    keys: 'Enter',
    description: '作品詳細 / ライトボックスを開く',
    match: { key: 'Enter' },
    list: { kind: 'open' },
  },
  {
    id: 'close',
    group: 'list',
    keys: 'Esc',
    description: '選択を解除する（詳細・比較ビューでは閉じる）',
    match: { key: 'Escape' },
    list: { kind: 'close' },
  },
  {
    id: 'search',
    group: 'list',
    keys: '/',
    description: '検索欄にフォーカス',
    match: { key: '/' },
  },
  {
    id: 'delete',
    group: 'list',
    keys: 'Delete',
    description: '選択中をゴミ箱へ移動（確認あり）',
    match: { key: 'Delete', shift: false },
  },
  {
    id: 'delete-permanent',
    group: 'list',
    keys: 'Shift+Delete',
    description: '選択中を完全に削除（確認あり・元に戻せない）',
    match: { key: 'Delete', shift: true },
  },
  {
    id: 'roots',
    group: 'list',
    keys: 'Ctrl+1…9 / Ctrl+0',
    description: 'ルートで絞り込む（0 はすべて）',
    match: { ctrl: true, values: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] },
  },
  {
    id: 'view-works',
    group: 'list',
    keys: 'Alt+1',
    description: '作品モードに切り替え',
    match: { alt: true, code: ['Digit1', 'Numpad1'] },
  },
  {
    id: 'view-files',
    group: 'list',
    keys: 'Alt+2',
    description: 'ファイルモードに切り替え',
    match: { alt: true, code: ['Digit2', 'Numpad2'] },
  },
  {
    id: 'view-timeline',
    group: 'list',
    keys: 'Alt+3 / Ctrl+Shift+T',
    description: 'タイムラインに切り替え（更新日の日付でまとめる）',
    // 従来の Ctrl+Shift+T も残す（#88）。ルート絞り込みの Ctrl+1..9 とは別キー。
    match: [
      { alt: true, code: ['Digit3', 'Numpad3'] },
      { ctrl: true, shift: true, code: ['KeyT'] },
    ],
  },

  // ---------------------------------------------------------------------------
  // 詳細（作品詳細 / ライトボックス）
  // ---------------------------------------------------------------------------
  {
    id: 'detail-next',
    group: 'detail',
    keys: '→',
    description: '次のファイルへ（動画は 5 秒進む）',
  },
  {
    id: 'detail-prev',
    group: 'detail',
    keys: '←',
    description: '前のファイルへ（動画は 5 秒戻る）',
  },
  {
    id: 'detail-next-video',
    group: 'detail',
    keys: 'Shift+→',
    description: '動画で次のファイルへ',
  },
  {
    id: 'detail-prev-video',
    group: 'detail',
    keys: 'Shift+←',
    description: '動画で前のファイルへ',
  },
  {
    id: 'detail-play',
    group: 'detail',
    keys: 'Space',
    description: '動画の再生 / 停止',
  },
  {
    id: 'detail-fullscreen',
    group: 'detail',
    keys: 'F',
    description: '全画面の切り替え',
  },
  {
    id: 'detail-reset',
    group: 'detail',
    keys: '0',
    description: '画像は原寸（100%）に戻す / 動画は先頭へ',
  },
  {
    id: 'detail-close',
    group: 'detail',
    keys: 'Esc',
    description: 'ライトボックスを閉じる',
  },

  // ---------------------------------------------------------------------------
  // 比較・差分
  // ---------------------------------------------------------------------------
  {
    id: 'compare-launch',
    group: 'compare',
    keys: '選択バー → 比較',
    description: '2〜4 件を選んで並べて比較',
  },
  {
    id: 'compare-diff',
    group: 'compare',
    keys: '比較ビュー → 差分',
    description: '2 枚の生成設定を差分表示',
  },
  {
    id: 'compare-zoom',
    group: 'compare',
    keys: 'ホイール',
    description: 'ズーム（20%〜800%）',
  },
  {
    id: 'compare-pan',
    group: 'compare',
    keys: 'ドラッグ',
    description: '拡大中の表示位置を移動',
  },
  {
    id: 'compare-reset',
    group: 'compare',
    keys: '0',
    description: 'ズームを原寸（100%）に戻す',
  },
  {
    id: 'compare-play',
    group: 'compare',
    keys: 'Space',
    description: 'フォーカス中の動画の再生 / 停止',
  },
  {
    id: 'compare-close',
    group: 'compare',
    keys: 'Esc',
    description: '比較ビューを閉じる',
  },

  // ---------------------------------------------------------------------------
  // 全体（アプリ共通）
  // ---------------------------------------------------------------------------
  {
    id: 'help',
    group: 'global',
    keys: '?',
    description: 'このショートカット一覧を開く',
    // Shift+/ は key が '?' になる（JIS でも同じ）。Shift の有無は見ない
    match: { key: '?' },
  },
  {
    id: 'shield',
    group: 'global',
    keys: 'Ctrl+Shift+P',
    description: 'プライバシーシールドを発動（解除は長押し）',
    match: { ctrl: true, shift: true, key: ['p', 'P'] },
  },
  {
    id: 'shield-hold',
    group: 'global',
    keys: 'Esc 長押し',
    description: 'シールドを発動（既定 1 秒）',
  },
  {
    id: 'thumbnails',
    group: 'global',
    keys: 'Ctrl+Shift+H',
    description: 'サムネイル表示を切り替え',
    match: { ctrl: true, shift: true, code: ['KeyH'] },
  },
  {
    id: 'nav-back',
    group: 'global',
    keys: 'Alt+←',
    description: '前の画面へ戻る',
  },
  {
    id: 'nav-forward',
    group: 'global',
    keys: 'Alt+→',
    description: '次の画面へ進む',
  },
]

/** 定義を id で引く。 */
export function shortcutById(id: string): ShortcutDefinition | undefined {
  return SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)
}

/** ヘルプやボタンのツールチップに出すキー表記。未定義なら空文字。 */
export function shortcutKeys(id: string): string {
  return shortcutById(id)?.keys ?? ''
}

/** 分類ごとの定義（定義の並び順を保つ）。 */
export function shortcutsInGroup(group: ShortcutGroup): ShortcutDefinition[] {
  return SHORTCUT_DEFINITIONS.filter((definition) => definition.group === group)
}

/** 入力欄・選択欄・contenteditable にフォーカスがあるか。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as HTMLElement & { isContentEditable?: boolean }
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return element.isContentEditable === true
}

/** ボタンなど、Space / Enter をその要素自身に任せるべきか。 */
export function isActivatableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as HTMLElement
  if (typeof element.closest !== 'function') return false
  return Boolean(
    element.closest(
      'button, a[href], select, input, textarea, summary, [role="checkbox"], [role="button"], [role="switch"]',
    ),
  )
}

/** 一覧の 1 行（作品カード / ファイルタイル）の中にフォーカスがあるか。 */
export function isListItemTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as HTMLElement
  if (typeof element.closest !== 'function') return false
  return Boolean(element.closest('[data-work-id], [data-file-id]'))
}

function toArray(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null
  return Array.isArray(value) ? value : [value]
}

/** 定義 1 件の `match` とイベントが一致するか。 */
function matchesCondition(match: ShortcutMatch, event: KeyInput): boolean {
  if (event.metaKey) return false
  if (Boolean(event.ctrlKey) !== Boolean(match.ctrl)) return false
  if (Boolean(event.altKey) !== Boolean(match.alt)) return false
  if (match.shift !== undefined && Boolean(event.shiftKey) !== match.shift) return false

  const keys = toArray(match.key)
  const codes = toArray(match.code)
  const values = match.values
  if (!keys && !codes && !values) return false
  if (values?.includes(event.key)) return true
  if (keys?.includes(event.key)) return true
  return Boolean(codes && event.code && codes.includes(event.code))
}

function matchesDefinition(definition: ShortcutDefinition, event: KeyInput): boolean {
  const match = definition.match
  if (!match) return false
  return Array.isArray(match)
    ? match.some((condition) => matchesCondition(condition, event))
    : matchesCondition(match, event)
}

/** id で指定した定義にイベントが一致するか（キー処理から定義を参照するための入口）。 */
export function matchesShortcut(id: string, event: KeyInput): boolean {
  const definition = shortcutById(id)
  return definition ? matchesDefinition(definition, event) : false
}

/**
 * `1`〜`5` → 1〜5、`0` → null（未評価）、それ以外 → undefined（評価キーではない）。
 * 対象の数字は `SHORTCUT_DEFINITIONS` の `rate` / `unrated` が持つ。
 */
export function ratingForKey(key: string): number | null | undefined {
  if (matchesShortcut('unrated', { key })) return null
  if (matchesShortcut('rate', { key })) return Number(key)
  return undefined
}

/**
 * `?`（Shift+/）でショートカット一覧を開いてよいか。
 *
 * 入力欄・選択欄・contenteditable と、IME 変換中・修飾キー付きは開かない
 * （`src/library/ShortcutsHelp.tsx` が window の keydown から呼ぶ）。
 */
export function shouldOpenHelp(
  event: KeyInput,
  target: EventTarget | null = null,
): boolean {
  if (event.isComposing) return false
  if (isEditableTarget(target)) return false
  return matchesShortcut('help', event)
}

/**
 * 一覧・詳細のショートカットを 1 つに解決する。
 *
 * - `j` / `k` … 次 / 前へフォーカス
 * - `1`〜`5` / `0` … 評価（0 は未評価）
 * - `F` … お気に入り切替
 * - `Space` … 動画の再生 / 停止（または開いて再生）
 * - `Enter` … 詳細を開く（カード自身の Enter に任せる場合は null）
 * - `Esc` … 比較ビュー / 詳細を閉じる
 *
 * `Ctrl` / `Alt` / `Meta` 付きと入力欄・IME 変換中は常に `null`。
 */
export function resolveListShortcut(
  event: KeyInput,
  target: EventTarget | null = null,
): ListShortcut | null {
  if (event.isComposing) return null
  if (isEditableTarget(target)) return null
  // `/` 検索・Delete・Ctrl+1..9・Ctrl+Shift+P・Alt+← 等には触れない
  if (event.ctrlKey || event.altKey || event.metaKey) return null

  const space = event.key === ' ' || event.code === 'Space'
  const enter = event.key === 'Enter'

  // ボタンやチェックボックスの Space / Enter は要素自身の操作を優先する
  if ((space || enter) && isActivatableTarget(target)) return null

  for (const definition of SHORTCUT_DEFINITIONS) {
    if (!definition.list) continue
    if (!matchesDefinition(definition, event)) continue
    // フォーカス中のカードは自分で開く（二重遷移を避ける）
    if (enter && isListItemTarget(target)) return null
    if (definition.list.kind === 'rate') {
      const rating = ratingForKey(event.key)
      if (rating === undefined) return null
      return { kind: 'rate', rating }
    }
    return { ...definition.list }
  }

  return null
}

/**
 * ライブラリ全体（ルート絞り込み・表示モード・サムネ表示）の動作（#88）。
 *
 * **同じキーを 2 つのリスナーが処理しない**ように、この 3 種類は 1 つの解決関数に集約する。
 * 呼び出し側（`useLibraryShortcuts`）は返った 1 件だけを実行する。
 * `Ctrl+1` は `select-root`、`Alt+1` は `view-mode` にだけ対応し、互いに重ならない。
 */
export type LibraryShortcutIntent =
  | { kind: 'view-mode'; mode: LibraryViewMode }
  | { kind: 'toggle-thumbnails' }
  | { kind: 'select-root'; index: number | null }

export function resolveLibraryShortcut(event: KeyInput): LibraryShortcutIntent | null {
  if (event.isComposing) return null
  if (event.metaKey) return null

  if (matchesShortcut('view-works', event)) return { kind: 'view-mode', mode: 'works' }
  if (matchesShortcut('view-files', event)) return { kind: 'view-mode', mode: 'files' }
  if (matchesShortcut('view-timeline', event)) return { kind: 'view-mode', mode: 'timeline' }
  if (matchesShortcut('thumbnails', event)) return { kind: 'toggle-thumbnails' }

  if (matchesShortcut('roots', event)) {
    if (event.key === '0') return { kind: 'select-root', index: null }
    const index = Number(event.key) - 1
    return { kind: 'select-root', index: Number.isInteger(index) ? index : null }
  }

  return null
}
