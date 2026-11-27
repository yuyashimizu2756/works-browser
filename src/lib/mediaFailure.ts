/**
 * #26: 動画の再生失敗・シーク不可を調べる小さなヘルパー。
 *
 * `<video>` の `error` は「どの形式を、どれくらいのサイズで、どのコードで
 * 失敗したか」しか持たない。原因を追えるように、ファイル名（拡張子）から
 * コーデックの当たりを付け、サイズ・エラーコードを 1 つの警告にまとめる。
 * DOM に依存しない純粋関数だけを置き、単体テストで確認する。
 */

/** ファイル名から、再生に使われそうなコーデックの当たりを返す（診断用）。 */
export function codecHint(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'H.264 / AAC（mp4）'
    case 'webm':
      return 'VP8 / VP9 / Opus（webm）'
    case 'mov':
      return 'H.264 / ProRes（mov）'
    case 'mkv':
      return 'Matroska（mkv）'
    case 'avi':
      return 'AVI'
    case 'ts':
    case 'm2ts':
      return 'MPEG-TS'
    default:
      return ext ? `${ext}（不明なコンテナ）` : '不明'
  }
}

type SeekableLike = {
  seekable: TimeRanges | null
  duration: number
  readyState: number
}

/**
 * シークバーを有効にしてよいか。
 *
 * `seekable.length === 0` は「Range 非対応の配信」や「まだインデックスが
 * 無い」ことを示す。ただしメタデータ前（`readyState < 1`）や、`seekable` を
 * 実装しない環境（jsdom）では判定できないので、有効のままにする。
 */
export function hasSeekableRange(media: SeekableLike): boolean {
  const ranges = media.seekable
  if (ranges && ranges.length > 0) {
    try {
      const end = ranges.end(ranges.length - 1)
      return !Number.isFinite(end) || end > 0
    } catch {
      // 実装差で end() が投げる場合は「範囲あり」とみなして操作を止めない
      return true
    }
  }
  if (media.readyState < 1) return true
  // メタデータ後でも長さが 0 なら、まだ判定できない
  return !(media.duration > 0)
}

export type MediaFailureInfo = {
  file: string
  bytes: number
  durationMs: number | null
  /** デコードできた場合は実フレームのサイズ、できなければファイルの記録値。 */
  width: number
  height: number
  codec: string
  errorCode: number | null
  errorMessage: string | null
  readyState: number
  networkState: number
  cause: string | null
}

type MediaFailureSource = {
  name: string
  bytes: number
  duration_ms: number | null
  width: number | null
  height: number | null
}

type VideoFailureSource = {
  videoWidth: number
  videoHeight: number
  readyState: number
  networkState: number
  error: MediaError | null
}

/** `console.warn` に渡す 1 つのオブジェクトを作る（#26）。 */
export function mediaFailureInfo(
  file: MediaFailureSource,
  video: VideoFailureSource,
  cause?: unknown,
): MediaFailureInfo {
  return {
    file: file.name,
    bytes: file.bytes,
    durationMs: file.duration_ms,
    width: video.videoWidth || file.width || 0,
    height: video.videoHeight || file.height || 0,
    codec: codecHint(file.name),
    errorCode: video.error?.code ?? null,
    errorMessage: video.error?.message ?? null,
    readyState: video.readyState,
    networkState: video.networkState,
    cause: cause === undefined ? null : String(cause),
  }
}
