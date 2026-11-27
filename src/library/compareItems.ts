/**
 * 比較ビュー（#71）に渡す 1 枚分。
 *
 * ライブラリの作品選択からはカバー（動画なら先頭フレーム）を、
 * 作品詳細のファイル選択からはそのファイルを使う。
 * `fileId` は Tauri の `wbm:` スキームで原寸を読むための `files.id`
 * （ベンチ / headless では null で、`thumbPath` の data URL にフォールバックする）。
 */
import type { FileSummary, WorkSummary } from '../api'

export type CompareItem = {
  /** React の key / 個別再生の識別子。 */
  key: string
  title: string
  subtitle?: string
  kind: 'image' | 'video'
  fileId: number | null
  thumbPath: string | null
}

/** 作品の選択（チェックボックス）から比較用の 4 枚以下を作る。 */
export function compareItemsFromWorks(works: WorkSummary[]): CompareItem[] {
  return works.slice(0, 4).map((work) => ({
    key: `work-${work.id}`,
    title: work.title,
    subtitle: work.kind === 'mixed' ? '混在' : work.kind === 'video' ? '動画' : '画像',
    // DB のカバーは動画優先なので、`image` 以外は動画として先頭フレームで比較する
    kind: work.kind === 'image' ? 'image' : 'video',
    fileId: work.cover_file_id,
    thumbPath: work.cover_thumb,
  }))
}

/** 作品詳細 / ファイルモードのファイル選択から比較用の 4 枚以下を作る。 */
export function compareItemsFromFiles(files: FileSummary[]): CompareItem[] {
  return files.slice(0, 4).map((file) => ({
    key: `file-${file.id}`,
    title: file.name,
    subtitle: file.work_title,
    kind: file.kind,
    fileId: file.id,
    thumbPath: file.thumb_path,
  }))
}
