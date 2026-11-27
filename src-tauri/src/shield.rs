//! プライバシーシールド（#22）の Rust 側。
//!
//! - グローバルホットキーの登録・解除（`tauri-plugin-global-shortcut`）
//! - ウィンドウタイトルを `works-browser` に固定
//! - Windows の Alt+Tab / タスクバー プレビュー除外（`DWMWA_EXCLUDED_FROM_PEEK`）
//! - 画面キャプチャ除外（`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`）
//!
//! Windows 固有の API は失敗してもアプリを落とさない（古い Windows や
//! リモートセッションでは利用できないことがある）。

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::config::DEFAULT_SHIELD_HOTKEY;

/// ホットキーが押された / 離されたことを UI に伝えるイベント。
pub const HOTKEY_EVENT: &str = "shield://hotkey";
/// シールドの表示タイトル。作品名・ファイル名を出さない。
pub const SHIELD_TITLE: &str = "works-browser";

/// `Ctrl+Shift+P` のような文字列を [`Shortcut`] に変換する。
///
/// 設定 UI から来る文字列を検証するために、修飾キー 1 つ以上 + キー 1 つを
/// 必須にする（修飾キーなしは通常のタイピングを奪うため拒否）。
pub fn parse_hotkey(text: &str) -> Result<Shortcut, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("ホットキーが空です".to_string());
    }

    let mut modifiers = Modifiers::empty();
    let mut key: Option<Code> = None;

    for raw in trimmed.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(format!("ホットキーの書式が不正です: {trimmed}"));
        }
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= Modifiers::CONTROL,
            "shift" => modifiers |= Modifiers::SHIFT,
            "alt" | "option" => modifiers |= Modifiers::ALT,
            "super" | "meta" | "win" | "command" | "cmd" => modifiers |= Modifiers::SUPER,
            other => {
                if key.is_some() {
                    return Err("キーは 1 つだけ指定してください".to_string());
                }
                key = Some(parse_code(other)?);
            }
        }
    }

    if modifiers.is_empty() {
        return Err("修飾キー（Ctrl / Shift / Alt / Win）を 1 つ以上含めてください".to_string());
    }
    let key = key.ok_or_else(|| "キーが指定されていません".to_string())?;
    Ok(Shortcut::new(Some(modifiers), key))
}

fn parse_code(token: &str) -> Result<Code, String> {
    let code = match token {
        "a" => Code::KeyA,
        "b" => Code::KeyB,
        "c" => Code::KeyC,
        "d" => Code::KeyD,
        "e" => Code::KeyE,
        "f" => Code::KeyF,
        "g" => Code::KeyG,
        "h" => Code::KeyH,
        "i" => Code::KeyI,
        "j" => Code::KeyJ,
        "k" => Code::KeyK,
        "l" => Code::KeyL,
        "m" => Code::KeyM,
        "n" => Code::KeyN,
        "o" => Code::KeyO,
        "p" => Code::KeyP,
        "q" => Code::KeyQ,
        "r" => Code::KeyR,
        "s" => Code::KeyS,
        "t" => Code::KeyT,
        "u" => Code::KeyU,
        "v" => Code::KeyV,
        "w" => Code::KeyW,
        "x" => Code::KeyX,
        "y" => Code::KeyY,
        "z" => Code::KeyZ,
        "0" => Code::Digit0,
        "1" => Code::Digit1,
        "2" => Code::Digit2,
        "3" => Code::Digit3,
        "4" => Code::Digit4,
        "5" => Code::Digit5,
        "6" => Code::Digit6,
        "7" => Code::Digit7,
        "8" => Code::Digit8,
        "9" => Code::Digit9,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        "space" => Code::Space,
        _ => return Err(format!("対応していないキーです: {token}")),
    };
    Ok(code)
}

/// 設定されたホットキーを登録し直す。
///
/// 旧ホットキーは先に解除する。他アプリと衝突して登録できなかった場合は
/// `Err` を返す（呼び出し側は設定を保存したうえでユーザーに知らせる）。
pub fn register(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let shortcut = parse_hotkey(hotkey)?;
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    manager
        .register(shortcut)
        .map_err(|error| format!("ホットキー {hotkey} を登録できません: {error}"))
}

/// プラグインのハンドラ。押下 / 離上をそのまま UI に流す。
///
/// 解除は「1 秒長押し」なので、UI 側が押下時間を測れるよう Released も送る。
pub fn handle_shortcut_event(app: &AppHandle, event: ShortcutState) {
    let payload = match event {
        ShortcutState::Pressed => "pressed",
        ShortcutState::Released => "released",
    };
    let _ = app.emit(HOTKEY_EVENT, payload);
}

/// シールドの ON / OFF をウィンドウへ反映する。
#[tauri::command]
pub fn set_shield_active(app: AppHandle, active: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        set_title(&window);
        apply_windows_exclusions(&window, active);
    }
    Ok(())
}

/// 設定 UI からホットキーを登録し直す。
#[tauri::command]
pub fn apply_shield_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    register(&app, &hotkey)
}

fn set_title(window: &WebviewWindow) {
    // 作品名・ファイル名を出さない。復帰後もアプリ名だけに戻す。
    let _ = window.set_title(SHIELD_TITLE);
}

/// Windows: Alt+Tab / タスクバーのプレビューと画面キャプチャから除外する。
///
/// 失敗は無視する（Windows 10 2004 未満、リモートセッション、DWM 無効時など）。
#[cfg(windows)]
fn apply_windows_exclusions(window: &WebviewWindow, shielded: bool) {
    use std::ffi::c_void;

    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_EXCLUDED_FROM_PEEK};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    let excluded: i32 = i32::from(shielded);
    // SAFETY: hwnd は Tauri が保持する有効なウィンドウハンドル。属性値は i32 1 個。
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_EXCLUDED_FROM_PEEK,
            &excluded as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        );
        let _ = SetWindowDisplayAffinity(
            hwnd,
            if shielded {
                WDA_EXCLUDEFROMCAPTURE
            } else {
                WDA_NONE
            },
        );
    }
}

#[cfg(not(windows))]
fn apply_windows_exclusions(_window: &WebviewWindow, _shielded: bool) {}

/// 起動時に設定済みのホットキーを登録する。失敗しても起動は続ける。
pub fn register_from_config(app: &AppHandle, hotkey: &str) {
    if let Err(error) = register(app, hotkey) {
        eprintln!("{error}。既定の {DEFAULT_SHIELD_HOTKEY} で再試行します");
        if let Err(default_error) = register(app, DEFAULT_SHIELD_HOTKEY) {
            eprintln!("{default_error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_hotkey() {
        let shortcut = parse_hotkey("Ctrl+Shift+P").unwrap();
        assert_eq!(shortcut.key, Code::KeyP);
        assert_eq!(shortcut.mods, Modifiers::CONTROL | Modifiers::SHIFT);
    }

    #[test]
    fn parses_lowercase_and_spaces() {
        let shortcut = parse_hotkey(" ctrl + alt + f2 ").unwrap();
        assert_eq!(shortcut.key, Code::F2);
        assert_eq!(shortcut.mods, Modifiers::CONTROL | Modifiers::ALT);
    }

    #[test]
    fn rejects_missing_modifier_or_key() {
        assert!(parse_hotkey("P").is_err());
        assert!(parse_hotkey("Ctrl+Shift").is_err());
        assert!(parse_hotkey("").is_err());
        assert!(parse_hotkey("Ctrl+Shift+,").is_err());
    }

    #[test]
    fn rejects_two_keys() {
        assert!(parse_hotkey("Ctrl+P+Q").is_err());
    }
}
