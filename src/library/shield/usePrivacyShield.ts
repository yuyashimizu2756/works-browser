import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { escHoldOutcome, hotkeyOutcome } from './hold'
import { silenceVideos } from './media'
import type { ShieldSettings } from './settings'
import { matchesHotkey } from './settings'

type Options = {
  settings: ShieldSettings
  initialShielded: boolean
  /** シールドを出す直前に呼ぶ（スクロール位置の記録など）。 */
  onBeforeActivate?: () => void
}

type PrivacyShield = {
  shielded: boolean
  activate: () => void
  deactivate: () => void
}

/**
 * プライバシーシールドの発動状態（#22）。
 *
 * - Rust のグローバルホットキー（`shield://hotkey`）と、アプリ内のキー入力を
 *   同じ経路で扱う。Tauri が無い headless / ブラウザでも後者だけで動く
 * - `Esc` 長押しで発動
 * - シールド中はホットキー長押し（`holdMs`）で解除
 * - 発動の瞬間に `<video>` を pause + mute する（アンマウント前）
 *
 * サムネイルの非表示自体は #21 の `useThumbnailVisible` を呼び出し側で
 * 合成して行う（新しい表示状態は持たない）。
 */
export function usePrivacyShield({ settings, initialShielded, onBeforeActivate }: Options): PrivacyShield {
  const [shielded, setShielded] = useState(initialShielded)
  const shieldedRef = useRef(initialShielded)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const restoreTimer = useRef<number | null>(null)
  const escTimer = useRef<number | null>(null)

  const clearRestoreTimer = useCallback(() => {
    if (restoreTimer.current !== null) {
      window.clearTimeout(restoreTimer.current)
      restoreTimer.current = null
    }
  }, [])

  const clearEscTimer = useCallback(() => {
    if (escTimer.current !== null) {
      window.clearTimeout(escTimer.current)
      escTimer.current = null
    }
  }, [])

  const activate = useCallback(() => {
    if (shieldedRef.current) return
    clearRestoreTimer()
    clearEscTimer()
    // Lightbox がアンマウントされる前に音を止める（100ms 以内の要件）
    if (typeof document !== 'undefined') {
      silenceVideos({
        querySelectorAll: (selector) => document.querySelectorAll<HTMLVideoElement>(selector),
      })
    }
    onBeforeActivate?.()
    shieldedRef.current = true
    setShielded(true)
  }, [clearEscTimer, clearRestoreTimer, onBeforeActivate])

  const deactivate = useCallback(() => {
    if (!shieldedRef.current) return
    clearRestoreTimer()
    clearEscTimer()
    shieldedRef.current = false
    setShielded(false)
  }, [clearEscTimer, clearRestoreTimer])

  /** ホットキー押下。シールド中だけ長押しタイマーを開始する。 */
  const beginHotkey = useCallback(() => {
    const holdMs = settingsRef.current.holdMs
    if (
      hotkeyOutcome({ shielded: shieldedRef.current, holdMs, heldMs: 0 }) === 'activate'
    ) {
      activate()
      return
    }
    clearRestoreTimer()
    restoreTimer.current = window.setTimeout(() => {
      restoreTimer.current = null
      if (
        hotkeyOutcome({
          shielded: shieldedRef.current,
          holdMs,
          heldMs: holdMs,
        }) === 'restore'
      ) {
        deactivate()
      }
    }, holdMs)
  }, [activate, clearRestoreTimer, deactivate])

  const endHotkey = useCallback(() => {
    clearRestoreTimer()
  }, [clearRestoreTimer])

  /** Esc 長押し。シールド中は何もしない。 */
  const beginEsc = useCallback(() => {
    if (shieldedRef.current || escTimer.current !== null) return
    const holdMs = settingsRef.current.holdMs
    escTimer.current = window.setTimeout(() => {
      escTimer.current = null
      if (
        escHoldOutcome({
          shielded: shieldedRef.current,
          holdMs,
          heldMs: holdMs,
        }) === 'activate'
      ) {
        activate()
      }
    }, holdMs)
  }, [activate])

  // Rust のグローバルホットキー（アプリ非アクティブでも発火する）
  useEffect(() => {
    let disposed = false
    const unlisteners: Array<() => void> = []

    const track = (pending: Promise<() => void>) => {
      pending
        .then((unlisten) => {
          if (disposed) unlisten()
          else unlisteners.push(unlisten)
        })
        .catch(() => {
          // ブラウザ単体（Tauri なし）ではイベントが無い
        })
    }

    track(
      listen<string>('shield://hotkey', (event) => {
        if (event.payload === 'pressed') beginHotkey()
        else if (event.payload === 'released') endHotkey()
      }),
    )

    return () => {
      disposed = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [beginHotkey, endHotkey])

  // アプリ内フォールバック（Esc 長押し / ホットキーのタップと長押し）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return

      if (event.key === 'Escape') {
        if (shieldedRef.current) {
          // シールド中は下の画面の Esc（選択解除・ライトボックスを閉じる）を止める
          event.preventDefault()
          event.stopPropagation()
          return
        }
        beginEsc()
        return
      }

      if (matchesHotkey(event, settingsRef.current.hotkey)) {
        event.preventDefault()
        beginHotkey()
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearEscTimer()
      if (matchesHotkey(event, settingsRef.current.hotkey)) endHotkey()
    }

    const onBlur = () => {
      clearEscTimer()
      clearRestoreTimer()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      clearEscTimer()
      clearRestoreTimer()
    }
  }, [beginEsc, beginHotkey, clearEscTimer, clearRestoreTimer, endHotkey])

  return { shielded, activate, deactivate }
}
