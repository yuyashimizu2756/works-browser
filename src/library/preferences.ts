import { api } from '../api'
import type { LibraryViewMode } from '../lib/viewMode'
import type { ShieldSettings } from './shield/settings'
import {
  DEFAULT_SHIELD_SETTINGS,
  normalizeShieldSettings,
  shieldSettingsFromConfig,
  shieldSettingsToConfig,
} from './shield/settings'

/**
 * 表示モード・サムネ表示トグル（#21）とプライバシーシールド（#22）の保存。
 *
 * 正は Rust 側の `config.json`（`%APPDATA%\works-browser\config.json`）。
 * 起動直後のちらつきを避けるため、同じ内容を localStorage にも写して
 * 同期的に初期値として読む。Tauri が無いベンチ / headless では localStorage だけが残る。
 */
export type LibraryPreferences = {
  viewMode: LibraryViewMode
  thumbnailsVisible: boolean
  shield: ShieldSettings
}

const STORAGE_KEY = 'works-browser.library-prefs'

/** 保存値を `works` / `files` / `timeline` のどれかに丸める（#81）。 */
function normalizeViewMode(value: unknown): LibraryViewMode {
  return value === 'files' || value === 'timeline' ? value : 'works'
}

const DEFAULTS: LibraryPreferences = {
  viewMode: 'works',
  // 既定はサムネ非表示（オーナー指示）。グリッドは維持し、プレースホルダを表示する
  thumbnailsVisible: false,
  shield: DEFAULT_SHIELD_SETTINGS,
}

export function readLocalPreferences(): LibraryPreferences | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LibraryPreferences>
    return {
      viewMode: normalizeViewMode(parsed.viewMode),
      thumbnailsVisible: parsed.thumbnailsVisible === true,
      shield: normalizeShieldSettings(parsed.shield),
    }
  } catch {
    return null
  }
}

function writeLocalPreferences(prefs: LibraryPreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // ストレージが使えない環境では保存しない（表示自体は動く）
  }
}

/** `config.json` を優先して読み、無ければ localStorage、最後に既定値。 */
export async function loadPreferences(): Promise<LibraryPreferences> {
  try {
    const config = await api.loadConfig()
    const prefs: LibraryPreferences = {
      viewMode: normalizeViewMode(config.view_mode),
      thumbnailsVisible: config.thumbnails_visible,
      shield: shieldSettingsFromConfig(config),
    }
    writeLocalPreferences(prefs)
    return prefs
  } catch {
    return readLocalPreferences() ?? DEFAULTS
  }
}

/** 変更を `config.json`（と localStorage）へ保存する。失敗しても UI は止めない。 */
export async function savePreferences(prefs: LibraryPreferences): Promise<void> {
  writeLocalPreferences(prefs)
  try {
    // #8: 設定画面が書いた項目（除外パターン・ffmpeg・サムネイル・音量）を
    // 表示モードの保存で消さないよう、今の config.json に重ねる。
    const current = await api.loadConfig()
    await api.saveConfig({
      ...current,
      // #81: タイムラインも作品 / ファイルと同じく次回起動時に復元する。
      view_mode: prefs.viewMode,
      thumbnails_visible: prefs.thumbnailsVisible,
      ...shieldSettingsToConfig(prefs.shield),
    })
  } catch {
    // Tauri 未接続（ベンチ / headless）では localStorage のみ
  }
}
