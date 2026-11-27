import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * サムネイルのキャッシュパスを `<img src>` に変換する。
 *
 * `asset` protocol のスコープ設定に依存すると環境差で表示されないことがあるため、
 * キャッシュ直下の `<hash>.webp` だけを返す専用スキーム `thumb` を使う
 * （Rust 側: `src-tauri/src/thumbs/serve.rs`）。
 *
 * ベンチ / headless / デモ（#97）用に `data:` / `blob:` / `http(s):` / ルート相対
 * （`/demo/...`）が渡ることがあるので、その場合はそのまま返す。
 * 呼び出し側はサムネ非表示中にこの関数を**呼ばない**こと（#21）。
 */
export function thumbSrc(path: string | null | undefined): string | null {
  if (!path) return null
  if (
    path.startsWith('data:') ||
    path.startsWith('blob:') ||
    path.startsWith('http') ||
    path.startsWith('/')
  ) {
    return path
  }
  const name = path.split(/[\\/]/).pop()
  if (!name) return null
  return convertFileSrc(name, 'thumb')
}
