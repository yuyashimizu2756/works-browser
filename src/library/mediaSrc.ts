import { convertFileSrc } from '@tauri-apps/api/core'

/**
 * ライトボックス / プレイヤー用のメディア URL（#5）。
 *
 * Rust 側のカスタムスキーム `wbm` は `files.id` だけを受け取り、DB から実パスを引いて
 * Range 対応で返す（10GB の動画でもメモリに載らない）。パスを UI から渡さないので、
 * 索引に無いファイルは配信されない。
 *
 * Tauri の外（ベンチ / headless Chrome）では URL を作れないので空文字を返す。
 * 呼び出し側はサムネイル（`thumb_path` の data URL）にフォールバックすること。
 */
export function mediaSrc(fileId: number | null | undefined): string | null {
  if (fileId === null || fileId === undefined) return null
  const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  if (!internals) return null
  try {
    return convertFileSrc(String(fileId), 'wbm')
  } catch {
    return null
  }
}

/** 画像の表示に使う URL。実アプリは原寸、ベンチはサムネの data URL。 */
export function imageSrc(fileId: number, thumbPath: string | null): string | null {
  return mediaSrc(fileId) ?? thumbPath
}
