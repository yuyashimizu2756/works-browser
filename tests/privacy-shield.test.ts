import { expect, test } from 'vitest'
import { escHoldOutcome, heldFor, hotkeyOutcome } from '../src/library/shield/hold.ts'
import { silenceVideos } from '../src/library/shield/media.ts'
import {
  canonicalHotkey,
  hotkeyFromKeyboardEvent,
  matchesHotkey,
  normalizeShieldSettings,
  shieldSettingsFromConfig,
  shieldSettingsToConfig,
} from '../src/library/shield/settings.ts'

// ---------------------------------------------------------------------------
// ホットキー押下 → 状態遷移
// ---------------------------------------------------------------------------

test('ホットキーのタップでシールドがONになり、長押しでOFFに戻る', () => {
  let shielded = false
  const press = (heldMs: number) => {
    const outcome = hotkeyOutcome({ shielded, holdMs: 1000, heldMs })
    if (outcome === 'activate') shielded = true
    if (outcome === 'restore') shielded = false
  }

  // 非シールド中は押した瞬間に発動
  press(0)
  expect(shielded).toBe(true)

  // シールド中の短い押下では解除しない（誤操作防止）
  press(300)
  expect(shielded).toBe(true)

  // 1 秒押し続けたら解除
  press(1000)
  expect(shielded).toBe(false)
})

test('Esc は非シールド中だけ長押しで発動する', () => {
  expect(escHoldOutcome({ shielded: false, holdMs: 1000, heldMs: 999 })).toBe(null)
  expect(escHoldOutcome({ shielded: false, holdMs: 1000, heldMs: 1000 })).toBe('activate')
  expect(escHoldOutcome({ shielded: true, holdMs: 1000, heldMs: 5000 })).toBe(null)
})

test('長押し時間の設定（0.5 / 1 / 2 秒）が判定に効く', () => {
  for (const holdMs of [500, 1000, 2000]) {
    expect(hotkeyOutcome({ shielded: true, holdMs, heldMs: holdMs - 1 })).toBe(null)
    expect(hotkeyOutcome({ shielded: true, holdMs, heldMs: holdMs })).toBe('restore')
  }
  expect(heldFor(120, 100)).toBe(0)
  expect(heldFor(100, 350)).toBe(250)
})

// ---------------------------------------------------------------------------
// 設定（ホットキー・長押し時間・起動時状態・見た目）の永続化
// ---------------------------------------------------------------------------

test('設定の既定値と丸め', () => {
  const defaults = normalizeShieldSettings(undefined)
  expect(defaults).toEqual({
    hotkey: 'Ctrl+Shift+P',
    holdMs: 1000,
    startHidden: false,
    appearance: 'files',
  })

  const normalized = normalizeShieldSettings({
    hotkey: 'ctrl+alt+s',
    holdMs: 730,
    startHidden: true,
    appearance: 'video',
  })
  expect(normalized.hotkey).toBe('Ctrl+Alt+S')
  expect(normalized.holdMs).toBe(1000)
  expect(normalized.startHidden).toBe(true)
  expect(normalized.appearance).toBe('files')
})

test('config.json（snake_case）との往復で値が保たれる', () => {
  const settings = normalizeShieldSettings({
    hotkey: 'Ctrl+Shift+F9',
    holdMs: 2000,
    startHidden: true,
    appearance: 'plain',
  })
  const config = shieldSettingsToConfig(settings)
  expect(config).toEqual({
    shield_hotkey: 'Ctrl+Shift+F9',
    shield_hold_ms: 2000,
    shield_start_hidden: true,
    shield_appearance: 'plain',
  })
  expect(shieldSettingsFromConfig(config)).toEqual(settings)
})

test('不正なホットキーは既定値へ戻す', () => {
  expect(canonicalHotkey('P')).toBe(null)
  expect(canonicalHotkey('Ctrl+P+Q')).toBe(null)
  expect(normalizeShieldSettings({ hotkey: 'P' }).hotkey).toBe('Ctrl+Shift+P')
})

test('入力イベントと設定ホットキーの照合', () => {
  const event = {
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    code: 'KeyP',
  }
  expect(matchesHotkey(event, 'Ctrl+Shift+P')).toBe(true)
  expect(matchesHotkey(event, 'Ctrl+P')).toBe(false)
  expect(
    hotkeyFromKeyboardEvent({
      ctrlKey: true,
      shiftKey: false,
      altKey: true,
      metaKey: false,
      code: 'KeyS',
    }),
  ).toBe('Ctrl+Alt+S')
})

// ---------------------------------------------------------------------------
// 動画の pause / mute（DOM モック）
// ---------------------------------------------------------------------------

function fakeVideo() {
  const calls: string[] = []
  const dataset: Record<string, string> = {}
  return {
    calls,
    dataset,
    video: {
      paused: false,
      muted: false,
      currentTime: 42.5,
      dataset,
      pause() {
        calls.push('pause')
      },
    },
  }
}

test('再生中の動画を pause + mute し、復帰用の状態を記録する', () => {
  const { video, calls, dataset } = fakeVideo()
  const count = silenceVideos({ querySelectorAll: (selector) => (selector === 'video' ? [video] : []) })

  expect(count).toBe(1)
  expect(calls).toEqual(['pause'])
  expect(video.muted).toBe(true)
  expect(dataset.shieldWasPlaying).toBe('1')
  expect(dataset.shieldWasMuted).toBe('0')
  expect(dataset.shieldPositionMs).toBe('42500')
})

test('停止中の動画は「再生中」と記録しない（複数件にも対応）', () => {
  const first = fakeVideo()
  first.video.paused = true
  const second = fakeVideo()
  second.video.muted = true

  const count = silenceVideos({
    querySelectorAll: () => [first.video, second.video],
  })

  expect(count).toBe(2)
  expect(first.dataset.shieldWasPlaying).toBe(undefined)
  expect(second.dataset.shieldWasMuted).toBe('1')
  expect(second.video.muted).toBe(true)
})
