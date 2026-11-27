/**
 * #22: サムネイル表示状態は保存しない。
 *
 * - `LibraryPreferences` に `thumbnailsVisible` が入らない
 * - 旧バージョンの localStorage / `config.json`（`thumbnails_visible`）は読み捨てる
 * - 保存しても `thumbnailsVisible` は書き込まれない（起動時は必ず非表示）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/api'

const { loadConfig, saveConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}))

vi.mock('../src/api', () => ({ api: { loadConfig, saveConfig } }))

import {
  loadPreferences,
  readLocalPreferences,
  savePreferences,
} from '../src/library/preferences'
import { DEFAULT_SHIELD_SETTINGS } from '../src/library/shield/settings'

const STORAGE_KEY = 'works-browser.library-prefs'

const CONFIG: AppConfig = {
  view_mode: 'works',
  thumbnails_visible: true,
  shield_hotkey: 'Ctrl+Shift+P',
  shield_hold_ms: 1000,
  shield_start_hidden: false,
  shield_appearance: 'files',
  exclude_patterns: [],
  ffmpeg_path: '',
  thumb_quality: 75,
  thumb_cache_limit_mb: 512,
  remember_volume: false,
  comfy_url: 'http://127.0.0.1:8188',
  comfy_workflows_dir: '',
}

function storedPreferences(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
    string,
    unknown
  >
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  loadConfig.mockResolvedValue({ ...CONFIG })
  saveConfig.mockImplementation(async (config: AppConfig) => config)
})

describe('#22 サムネイル表示は保存しない', () => {
  it('localStorage に残った thumbnailsVisible は読み捨てる', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ viewMode: 'timeline', thumbnailsVisible: true, shield: {} }),
    )

    const prefs = readLocalPreferences()
    expect(prefs).not.toBeNull()
    expect(prefs?.viewMode).toBe('timeline')
    expect(prefs).not.toHaveProperty('thumbnailsVisible')
  })

  it('config.json の thumbnails_visible は起動時の復元に使わない', async () => {
    loadConfig.mockResolvedValue({ ...CONFIG, thumbnails_visible: true })

    const prefs = await loadPreferences()

    expect(prefs).not.toHaveProperty('thumbnailsVisible')
    expect(prefs.viewMode).toBe('works')
    // 同期用に写した localStorage にも入らない
    expect(storedPreferences()).not.toHaveProperty('thumbnailsVisible')
  })

  it('保存しても thumbnailsVisible は含まれない（旧キーは書き換えない）', async () => {
    await savePreferences({ viewMode: 'files', shield: DEFAULT_SHIELD_SETTINGS })

    expect(storedPreferences()).not.toHaveProperty('thumbnailsVisible')
    expect(storedPreferences().viewMode).toBe('files')

    expect(saveConfig).toHaveBeenCalledTimes(1)
    const saved = saveConfig.mock.calls[0][0] as AppConfig
    expect(saved.view_mode).toBe('files')
    // 互換のため config.json の旧キーは残るが、トグルでは書き換えない
    expect(saved.thumbnails_visible).toBe(true)
    expect(saved).not.toHaveProperty('thumbnailsVisible')
  })

  it('config.json が読めなくても localStorage の旧値を復元しない', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ viewMode: 'works', thumbnailsVisible: true, shield: {} }),
    )
    loadConfig.mockRejectedValue(new Error('Tauri 未接続'))

    const prefs = await loadPreferences()

    expect(prefs).not.toHaveProperty('thumbnailsVisible')
    expect(storedPreferences()).not.toHaveProperty('thumbnailsVisible')
  })
})
