/**
 * プライバシーシールド（#22）の設定値。
 *
 * 純粋なデータ変換だけを置き、React / Tauri に依存させない。
 * そのため Node の `node --test` から直接読み込んでユニットテストできる。
 */

export type ShieldHoldMs = 500 | 1000 | 2000
export type ShieldAppearance = 'plain' | 'files'

export type ShieldSettings = {
  /** `Ctrl+Shift+P` のような表示用のホットキー。 */
  hotkey: string
  /** 解除（と Esc 発動）に必要な長押し時間。 */
  holdMs: ShieldHoldMs
  /** 起動直後からシールドするか。 */
  startHidden: boolean
  /** `files`（ファイル名リスト）| `plain`（無地）。 */
  appearance: ShieldAppearance
}

/** `config.json` のうちシールド関連の項目（Rust 側 `config::AppConfig`）。 */
export type ShieldConfigFields = {
  shield_hotkey?: string
  shield_hold_ms?: number
  shield_start_hidden?: boolean
  shield_appearance?: ShieldAppearance
}

export const SHIELD_HOLD_OPTIONS: { value: ShieldHoldMs; label: string }[] = [
  { value: 500, label: '0.5 秒' },
  { value: 1000, label: '1 秒（既定）' },
  { value: 2000, label: '2 秒' },
]

export const SHIELD_APPEARANCE_LABEL: Record<ShieldAppearance, string> = {
  files: 'ファイル名リスト',
  plain: '無地',
}

export const DEFAULT_SHIELD_SETTINGS: ShieldSettings = {
  hotkey: 'Ctrl+Shift+P',
  holdMs: 1000,
  startHidden: false,
  appearance: 'files',
}

export type ParsedHotkey = {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  /** `KeyP` / `Digit1` / `F2` のような `KeyboardEvent.code`。 */
  code: string
}

function isHoldMs(value: unknown): value is ShieldHoldMs {
  return value === 500 || value === 1000 || value === 2000
}

function isAppearance(value: unknown): value is ShieldAppearance {
  return value === 'files' || value === 'plain'
}

/**
 * 文字列のホットキーを検証して `KeyboardEvent.code` 形式へ分解する。
 *
 * 修飾キー 1 つ以上 + キー 1 つを必須にする（修飾なしは通常のタイピングを
 * 奪うため）。Rust 側の `shield::parse_hotkey` と同じ制約。
 */
export function parseHotkey(text: string): ParsedHotkey | null {
  const tokens = text
    .trim()
    .split('+')
    .map((token) => token.trim().toLowerCase())
  if (tokens.length < 2 || tokens.some((token) => token === '')) return null

  const parsed: ParsedHotkey = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
    code: '',
  }
  let keyToken: string | null = null

  for (const token of tokens) {
    if (token === 'ctrl' || token === 'control') parsed.ctrl = true
    else if (token === 'shift') parsed.shift = true
    else if (token === 'alt' || token === 'option') parsed.alt = true
    else if (token === 'meta' || token === 'super' || token === 'win' || token === 'cmd')
      parsed.meta = true
    else {
      if (keyToken !== null) return null
      keyToken = token
    }
  }

  if (!KeyTokenToCode[keyToken ?? '']) return null
  if (!parsed.ctrl && !parsed.shift && !parsed.alt && !parsed.meta) return null
  parsed.code = KeyTokenToCode[keyToken ?? ''] as string
  return parsed
}

const KeyTokenToCode: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    map[letter] = `Key${letter.toUpperCase()}`
  }
  for (const digit of '0123456789') {
    map[digit] = `Digit${digit}`
  }
  for (let index = 1; index <= 12; index += 1) {
    map[`f${index}`] = `F${index}`
  }
  map.space = 'Space'
  return map
})()

/** `Ctrl+Shift+p` のような入力を `Ctrl+Shift+P` に整える。不正なら null。 */
export function canonicalHotkey(text: string): string | null {
  const parsed = parseHotkey(text)
  if (!parsed) return null
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.shift) parts.push('Shift')
  if (parsed.alt) parts.push('Alt')
  if (parsed.meta) parts.push('Win')
  parts.push(keyLabel(parsed.code))
  return parts.join('+')
}

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code === 'Space') return 'Space'
  return code
}

/** 修飾キーを押していない単独キーは無視する。 */
export function hotkeyFromKeyboardEvent(event: {
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  code: string
}): string | null {
  if (!event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) return null
  const label = keyLabel(event.code)
  const known =
    /^Key[A-Z]$/.test(event.code) ||
    /^Digit[0-9]$/.test(event.code) ||
    /^F([1-9]|1[0-2])$/.test(event.code) ||
    event.code === 'Space'
  if (!known) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.shiftKey) parts.push('Shift')
  if (event.altKey) parts.push('Alt')
  if (event.metaKey) parts.push('Win')
  parts.push(label)
  return parts.join('+')
}

/** 入力イベントが設定済みホットキーと一致するか。 */
export function matchesHotkey(
  event: {
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    metaKey: boolean
    code: string
  },
  hotkey: string,
): boolean {
  const parsed = parseHotkey(hotkey)
  if (!parsed) return false
  return (
    parsed.ctrl === event.ctrlKey &&
    parsed.shift === event.shiftKey &&
    parsed.alt === event.altKey &&
    parsed.meta === event.metaKey &&
    parsed.code === event.code
  )
}

/** localStorage / 古い設定から来た値を既定値へ丸める。 */
export function normalizeShieldSettings(input: unknown): ShieldSettings {
  const record = (input ?? {}) as Partial<ShieldSettings>
  const hotkey =
    typeof record.hotkey === 'string' ? canonicalHotkey(record.hotkey) : null
  return {
    hotkey: hotkey ?? DEFAULT_SHIELD_SETTINGS.hotkey,
    holdMs: isHoldMs(record.holdMs) ? record.holdMs : DEFAULT_SHIELD_SETTINGS.holdMs,
    startHidden:
      typeof record.startHidden === 'boolean'
        ? record.startHidden
        : DEFAULT_SHIELD_SETTINGS.startHidden,
    appearance: isAppearance(record.appearance)
      ? record.appearance
      : DEFAULT_SHIELD_SETTINGS.appearance,
  }
}

/** Rust の `config.json` から読む。 */
export function shieldSettingsFromConfig(config: ShieldConfigFields | null | undefined): ShieldSettings {
  if (!config) return { ...DEFAULT_SHIELD_SETTINGS }
  return normalizeShieldSettings({
    hotkey: config.shield_hotkey,
    holdMs: config.shield_hold_ms,
    startHidden: config.shield_start_hidden,
    appearance: config.shield_appearance,
  })
}

/** Rust の `config.json` へ書く形。 */
export function shieldSettingsToConfig(settings: ShieldSettings): Required<ShieldConfigFields> {
  const normalized = normalizeShieldSettings(settings)
  return {
    shield_hotkey: normalized.hotkey,
    shield_hold_ms: normalized.holdMs,
    shield_start_hidden: normalized.startHidden,
    shield_appearance: normalized.appearance,
  }
}
