import { invoke } from '@tauri-apps/api/core'

/** Rust 側 `db::Root` と対応。 */
export type Root = {
  id: number
  path: string
  real_path: string
  label: string
  depth: number
  enabled: boolean
  duplicate_of: number | null
  created_at: number
}

/** Rust 側 `db::RootInfo`（ルート + 集計）。 */
export type RootInfo = {
  root: Root
  works: number
  files: number
  total_bytes: number
  last_scan_at: number | null
  last_scan_status: string | null
  /** #55: パスが実在するか。 */
  exists: boolean
}

export type WorkKind = 'image' | 'video' | 'mixed'

/** ライブラリ画面の種類フィルタ。 */
export type WorkKindFilter = 'all' | 'video' | 'image'

export type WorkSummary = {
  id: number
  root_id: number
  rel_path: string
  title: string
  kind: WorkKind
  cover_file_id: number | null
  /** #3 が生成するカバーサムネイルの絶対パス。未生成なら null。 */
  cover_thumb: string | null
  /** 先頭 4 ファイルのサムネイル絶対パス（#21 のホバープレビュー / モザイク）。 */
  preview_thumbs: string[]
  file_count: number
  total_bytes: number
  mtime: number
}

export type FileEntry = {
  id: number
  work_id: number
  rel_path: string
  name: string
  kind: 'image' | 'video'
  bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  mtime: number
  /** #19 が生成するファイル単位のサムネイルパス。未生成なら null。 */
  thumb_path: string | null
  /** 前回の再生位置（動画のみ・#5）。未保存なら null。 */
  position_ms: number | null
}

export type WorkDetail = {
  work: WorkSummary
  root_label: string
  root_real_path: string
  files: FileEntry[]
}

/** 作品 1 件のヘッダ情報（ファイル一覧なし・#5）。 */
export type WorkInfo = {
  work: WorkSummary
  root_label: string
  root_real_path: string
}

/** 動画の再生位置（#5）。 */
export type FilePosition = {
  file_id: number
  position_ms: number
  duration_ms: number | null
  updated_at: number
}

/** #60: ファイルから抽出した生成情報。 */
export type GenerationMeta = {
  prompt: string | null
  negative_prompt: string | null
  model: string | null
  loras: string[]
  steps: string | null
  sampler: string | null
  cfg: string | null
  seed: string | null
  size: string | null
  raw: string | null
  source: string
  /** #73: ComfyUI の `workflow`（UI 形式）全文。無ければ null。 */
  workflow_json: string | null
  /** #73: ComfyUI の `prompt`（API 形式）全文。無ければ null。 */
  api_prompt: string | null
}

/** #60: 生成メタデータ検索の 1 件（`search_meta`）。 */
export type FileMetaHit = {
  file_id: number
  work_id: number
  work_title: string
  name: string
  rel_path: string
  kind: 'image' | 'video'
  /** ヒット箇所の抜粋。 */
  snippet: string
}

/** #60: 生成メタデータ付与率の 1 ルート分。 */
export type MetaRootReport = {
  root_id: number
  label: string
  with_meta: number
  total: number
}

/** #60: 生成メタデータ付与率（全体 + ルート別）。 */
export type MetaReport = {
  total: number
  with_meta: number
  without_meta: number
  by_root: MetaRootReport[]
}

/** #60: `index_meta` の結果。 */
export type MetaIndexSummary = {
  total: number
  with_meta: number
  without_meta: number
  failed: number
  /** まだ索引していない件数。0 になるまで繰り返す。 */
  remaining: number
}

/** #73: 「ComfyUI へ」の結果。 */
export type ComfyExport = {
  /** `workflow`（保存してブラウザで開いた）| `api`（コピー用の JSON）。 */
  mode: 'workflow' | 'api'
  /** 保存した workflow のフルパス（workflow のとき）。 */
  path: string | null
  url: string | null
  /** API 形式の JSON（api のとき）。 */
  api_prompt: string | null
  file_name: string
  message: string
}

/** #73: 「この設定で再実行」の結果。 */
export type ComfyQueueResult = {
  prompt_id: string
  number: number | null
  url: string
}

/** #73: 接続確認（`GET /system_stats`）の結果。 */
export type ComfyStatus = {
  ok: boolean
  url: string
  version: string | null
  message: string
}

/** `meta://progress` イベント（#60）。 */
export type MetaProgress = {
  done: number
  total: number
  with_meta: number
}

/** #67: 重複グループの 1 ファイル。 */
export type DupFile = {
  id: number
  work_id: number
  name: string
  rel_path: string
  kind: 'image' | 'video'
  bytes: number
  width: number | null
  height: number | null
  mtime: number
  /** 残す 1 枚（画素数 → バイト数 → 新しい順）。 */
  keeper: boolean
}

/** #67: 重複・類似の 1 グループ。 */
export type DupGroup = {
  /** `exact:<hash>` / `similar:<hash>` */
  key: string
  files: DupFile[]
  total_bytes: number
  /** 1 枚だけ残したときに空くバイト数。 */
  wasted_bytes: number
}

/** #67: 重複判定の状態。 */
export type DupesStats = {
  total: number
  hashed: number
  pending: number
  analyzed_images: number
  exact_groups: number
  exact_wasted_bytes: number
}

/** #67: 1 回の解析結果。 */
export type DupesAnalyzeSummary = {
  total: number
  hashed: number
  images: number
  failed: number
  /** まだ解析していない件数（0 になるまで繰り返す）。 */
  remaining: number
  cancelled: boolean
  elapsed_ms: number
}

/** `dupes://progress` イベント（#67）。 */
export type DupesProgress = {
  done: number
  total: number
}

export type LibraryStats = {  roots: number
  works: number
  files: number
  total_bytes: number
  last_scan_at: number | null
  last_scan_status: string | null
}

/** ルート追加前のパス検証結果（Rust 側 `roots::PathCheck`）。#25 */
export type PathCheck = {
  path: string
  kind: 'directory' | 'file' | 'missing'
  is_drive_root: boolean
  is_system: boolean
  /** 同じ実体パスの既存ルート（追加すると深さだけ更新）。 */
  duplicate_of: number | null
  /** volume serial + file index が一致する別ルート。 */
  same_identity_root: number | null
  warning: string | null
  error: string | null
}

/** ルート追加の候補（`root_suggestions`）。#25 */
export type RootSuggestionsInfo = {
  recent: string[]
  drives: string[]
  known: string[]
}

export type ScanProgress = {
  root_id: number
  phase: string
  files: number
  works: number
  bytes: number
}

export type ScanSummary = {
  root_id: number
  status: 'done' | 'cancelled' | 'duplicate'
  files: number
  works: number
  total_bytes: number
  added: number
  updated: number
  removed: number
  unchanged: number
  duplicates: number
  duration_ms: number
  duplicate_of: number | null
}

export type SortKey =
  | 'mtime'
  | 'created'
  | 'title'
  | 'size'
  | 'files'
  | 'last_opened'
  | 'open_count'

/** ファイルモード（#21）の並び順。`duration` は動画だけ値がある。 */
export type FileSortKey = 'mtime' | 'name' | 'size' | 'duration'

/** ファイルモードの種類フィルタ。 */
export type FileKindFilter = 'all' | 'video' | 'image'

/** ファイルモードの 1 行（`list_files` の `files` 要素）。 */
export type FileSummary = {
  id: number
  work_id: number
  /** ルートからの相対パス。 */
  rel_path: string
  name: string
  kind: 'image' | 'video'
  bytes: number
  width: number | null
  height: number | null
  duration_ms: number | null
  mtime: number
  /** ファイル単位のサムネイルパス（未生成なら null）。 */
  thumb_path: string | null
  /** 所属作品のタイトル（カード左上に小さく出す）。 */
  work_title: string
  /** 所属作品の相対パス。 */
  work_rel_path: string
  root_id: number
  /** 前回の再生位置（動画のみ・#5）。未保存なら null。 */
  position_ms: number | null
  /** #60: 生成情報がキャッシュされているか（「meta」バッジ用）。 */
  has_meta: boolean
}

/** `list_files` / `get_work_files` に渡す条件。 */
export type FileQuery = {
  limit: number
  offset: number
  sort: FileSortKey
  /** #59: `asc` で昇順。省略時はキーごとの既定。 */
  dir?: 'asc' | 'desc'
  /** ファイル名 / 相対パスの部分一致。 */
  search?: string
  kind?: Exclude<FileKindFilter, 'all'>
  rootId?: number | null
  /** 作品 1 件に絞る（#5 の作品詳細ギャラリー）。 */
  workId?: number | null
  /** #60: 生成情報（プロンプト・モデル等）の検索語。 */
  metaQuery?: string
}

export type FilePage = {
  files: FileSummary[]
  total: number
}

/** 削除できなかった 1 件（#15）。 */
export type DeleteFailure = {
  id: number
  reason: string
}

/** `delete_files` の戻り値（#15）。 */
export type DeleteResult = {
  /** 削除できた件数。 */
  deleted: number
  failed: DeleteFailure[]
  /** 恒久削除だったか（false = ゴミ箱）。 */
  permanent: boolean
  /** ゴミ箱から戻せる場合の Undo トークン。 */
  undo_id: string | null
  /** 削除できたファイルの合計サイズ。 */
  deleted_bytes: number
  cancelled: boolean
}

/** `delete://progress` イベント（#15）。 */
export type DeleteProgress = {
  done: number
  total: number
  id: number
  name: string
}

/** `undo_delete` の戻り値（#15）。 */
export type UndoResult = {
  restored: number
  reindexed: number
  failed: string[]
  root_ids: number[]
}

/** 移動前の確認内容（Rust 側 `move_work::MovePlan`）。#57 */
export type MovePlan = {
  work_id: number
  title: string
  source_root_id: number
  source_root_label: string
  target_root_id: number
  target_root_label: string
  /** 移動元のフルパス。 */
  source_path: string
  /** 移動先のフルパス（同名リネーム後）。 */
  target_path: string
  /** 実際に付けるフォルダ名（`"name (2)"` を含む）。 */
  target_name: string
  file_count: number
  total_bytes: number
  /** true = rename で一瞬 / false = コピー + 削除で時間がかかる。 */
  same_volume: boolean
  /** 同名があったため `"name (2)"` にしたか。 */
  conflict_renamed: boolean
  warning: string | null
}

/** `move://progress` イベント（#57）。 */
export type MoveProgress = {
  moved_bytes: number
  total_bytes: number
}

/** `move_work` の戻り値（#57）。失敗しても「どこまで進んだか」を返す。 */
export type MoveOutcome = {
  moved: boolean
  cancelled: boolean
  work_id: number
  source_root_id: number
  target_root_id: number
  source_path: string
  target_path: string
  new_title: string
  conflict_renamed: boolean
  same_volume: boolean
  files: number
  moved_bytes: number
  /** 同一ボリュームの成功時だけ入る（5 秒間有効）。 */
  undo_id: string | null
  failures: string[]
}

/** `undo_move` の戻り値（#57）。 */
export type MoveUndoResult = {
  restored: boolean
  work_id: number
  root_ids: number[]
}

/** #63: `watch://changed` のペイロード（Rust 側 `watch::WatchChanged`）。 */
export type WatchChanged = {
  root_id: number
  /** 追加 + 更新の件数。 */
  added: number
  removed: number
  /** 上限超過で再走査へフォールバックしたか。 */
  rescan: boolean
}

/** #63: ルート別の新着件数（`watch_pending` の 1 行）。 */
export type WatchPending = {
  root_id: number
  added: number
  removed: number
}

/** 表示設定（Rust 側 `config::AppConfig` と対応）。 */
export type AppConfig = {
  /** #81: `timeline` は更新日のローカル日付ごとにまとめるタイムライン。 */
  view_mode: 'works' | 'files' | 'timeline'
  /**
   * #22: 互換のため残す旧キー。起動時のサムネイル表示には使わない
   * （表示状態は保存せず、起動ごとに必ず非表示）。
   */
  thumbnails_visible: boolean
  /** #22: グローバルホットキー（例 `Ctrl+Shift+P`）。 */
  shield_hotkey: string
  /** #22: 解除の長押し時間（500 / 1000 / 2000）。 */
  shield_hold_ms: number
  /** #22: 起動直後からシールドするか。 */
  shield_start_hidden: boolean
  /** #22: シールド中の見た目（`files` | `plain`）。 */
  shield_appearance: 'files' | 'plain'
  /** #8: 走査から除外する glob（1 行 1 件）。 */
  exclude_patterns: string[]
  /** #8: ffmpeg のパス。空文字なら自動検出。 */
  ffmpeg_path: string
  /** #8: サムネイルの WebP 品質（1–100）。 */
  thumb_quality: number
  /** #8: サムネイルキャッシュの上限（MB、0 は無制限）。 */
  thumb_cache_limit_mb: number
  /** #8: 動画の音量を次回起動時に復元するか（既定 false = 毎回ミュート）。 */
  remember_volume: boolean
  /** #7: フォルダ監視（UI ではまだ編集しない。保存時は Rust が既存値を保つ）。 */
  watch_enabled?: boolean
  /** #7: 監視から除外する glob。 */
  watch_exclude?: string[]
  /** #7: ネットワークドライブも監視するか。 */
  watch_network_drives?: boolean
  /** #39: `.ts` を MPEG-TS として索引するか（既定 `false`）。 */
  index_mpeg_ts?: boolean
  /** #73: ComfyUI の URL（例 `http://127.0.0.1:8188`）。 */
  comfy_url: string
  /** #73: ComfyUI の workflows フォルダ。空なら未設定。 */
  comfy_workflows_dir: string
}

/** サムネイルキャッシュの使用量（#8）。 */
export type CacheUsage = {
  path: string
  bytes: number
  files: number
  /** 0 は無制限。 */
  limit_bytes: number
}

/** ffmpeg の検出結果（#8）。 */
export type FfmpegProbe = {
  path: string | null
  source: 'setting' | 'sidecar' | 'path' | 'fallback' | 'none' | string
  version: string | null
  error: string | null
}

/** `get_settings` / `update_settings` の返り値（#8）。 */
export type AppSettings = {
  config: AppConfig
  config_path: string
  roots: RootInfo[]
  thumbs: ThumbSettings
  cache: CacheUsage
  ffmpeg: FfmpegProbe
}

/** `update_settings` の差分（#8）。 */
export type SettingsPatch = {
  view_mode?: AppConfig['view_mode']
  thumbnails_visible?: boolean
  shield_hotkey?: string
  shield_hold_ms?: number
  shield_start_hidden?: boolean
  shield_appearance?: AppConfig['shield_appearance']
  exclude_patterns?: string[]
  ffmpeg_path?: string
  thumb_quality?: number
  thumb_cache_limit_mb?: number
  remember_volume?: boolean
  /** #73: ComfyUI の URL / workflows フォルダ。 */
  comfy_url?: string
  comfy_workflows_dir?: string
}

/** `clear_thumb_cache` の結果（#8）。 */
export type ClearThumbCacheResult = {
  removed: number
  freed_bytes: number
  cache: CacheUsage
}

/** #69: 保存したスマートフォルダ（Rust 側 `db::SmartFolder`）。 */
export type SmartFolder = {
  id: number
  name: string
  /** UI の絞り込み条件（`SmartFolderQuery`）の JSON 文字列。 */
  query_json: string
  sort_order: number
  created_at: number
}

/** `find_works` に渡すページング条件。 */
export type WorkQuery = {
  limit: number
  offset: number
  sort: SortKey
  /** #59: `asc` で昇順。省略時はキーごとの既定。 */
  dir?: 'asc' | 'desc'
  /** タイトル / 作品パスの部分一致。 */
  search?: string
  /** `video`（動画あり）| `image`（画像のみ）。未指定なら全件。 */
  kind?: Exclude<WorkKindFilter, 'all'>
  rootId?: number | null
  /** #6: このタグが付いている作品だけ。 */
  tagId?: number | null
  /** #6: `true` でお気に入りのみ。 */
  favorite?: boolean
  /** #6: `marks.rating >= minRating`。 */
  minRating?: number | null
  /** #60: 生成情報（プロンプト・モデル等）の検索語。 */
  metaQuery?: string
}

/** ライブラリ全体で共有するタグ（#6）。 */
export type Tag = {
  id: number
  name: string
  /** `#rrggbb`（小文字）。 */
  color: string
  created_at: number
  /** このタグが付いている作品数。 */
  works: number
}

/** #79: 生成情報の頻出語から出したタグ候補。`count` はその語を含むファイル数。 */
export type TagSuggestion = {
  name: string
  count: number
}

/** 作品 1 件のお気に入り・評価・開封回数（#6）。 */
export type WorkMark = {
  work_id: number
  favorite: boolean
  /** 1〜5。未評価は null。 */
  rating: number | null
  note: string | null
  /** 最後に作品詳細を開いた時刻（ms）。未開封は null。 */
  last_opened_at: number | null
  open_count: number
}

/** 条件に一致する総数 + 1 ページ分の作品。 */
export type WorkPage = {
  works: WorkSummary[]
  total: number
}

/** サムネイル生成の進捗（`thumbs://progress` イベント）。 */
export type ThumbProgress = {
  done: number
  total: number
}

/** `generate_thumbs` の結果。 */
export type ThumbSummary = {
  total: number
  generated: number
  failed: number
  cancelled: boolean
  elapsed_ms: number
}

export type ThumbQueueStats = {
  pending: number
  ready: number
  total: number
}

export type ThumbSettings = {
  max_edge: number
  quality: number
  parallelism: number
  cache_dir: string
  ffmpeg: string | null
  ffmpeg_source: 'setting' | 'sidecar' | 'path' | 'fallback' | 'none' | string
}

/** `thumb_status` の返り値。 */
export type ThumbStatusInfo = {
  queue: ThumbQueueStats
  settings: ThumbSettings
  generating: boolean
}

export const api = {
  addRoot: (path: string, depth: number) => invoke<Root>('add_root', { path, depth }),
  /** 選択 / ドロップされたパスを追加前に検証する（#25）。 */
  inspectRootPaths: (paths: string[]) =>
    invoke<PathCheck[]>('inspect_root_paths', { paths }),
  /** 最近追加したフォルダ・ドライブ・既知の候補（#25）。 */
  rootSuggestions: () => invoke<RootSuggestionsInfo>('root_suggestions'),
  listRoots: () => invoke<RootInfo[]>('list_roots'),
  scanRoot: (rootId: number) => invoke<ScanSummary>('scan_root', { rootId }),
  cancelScan: () => invoke<boolean>('cancel_scan'),
  listWorks: (limit: number, offset: number, sort: SortKey, filters?: Pick<WorkQuery, 'tagId' | 'favorite' | 'minRating'>) =>
    invoke<WorkSummary[]>('list_works', {
      limit,
      offset,
      sort,
      tagId: filters?.tagId ?? null,
      favorite: filters?.favorite ?? null,
      minRating: filters?.minRating ?? null,
    }),
  findWorks: (query: WorkQuery) =>
    invoke<WorkPage>('find_works', {
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      search: query.search ?? null,
      kind: query.kind ?? null,
      rootId: query.rootId ?? null,
      tagId: query.tagId ?? null,
      favorite: query.favorite ?? null,
      minRating: query.minRating ?? null,
      dir: query.dir ?? null,
      metaQuery: query.metaQuery ?? null,
    }),
  /** #6: タグの CRUD と作品への付与。 */
  listTags: () => invoke<Tag[]>('list_tags'),
  createTag: (name: string, color: string) => invoke<Tag>('create_tag', { name, color }),
  deleteTag: (tagId: number) => invoke<void>('delete_tag', { tagId }),
  getWorkTags: (workId: number) => invoke<Tag[]>('get_work_tags', { workId }),
  setWorkTags: (workId: number, tagIds: number[]) =>
    invoke<Tag[]>('set_work_tags', { workId, tagIds }),
  /** #79: 生成情報の頻出語からタグ候補（この作品だけ）。生成情報が無ければ空配列。 */
  tagSuggestions: (workId: number, limit = 20) =>
    invoke<TagSuggestion[]>('tag_suggestions', { workId, limit }),
  /** #6: お気に入り・評価（1〜5 / null）・メモ。 */
  getWorkMark: (workId: number) => invoke<WorkMark>('get_work_mark', { workId }),
  setWorkMark: (
    workId: number,
    mark: { favorite: boolean; rating: number | null; note?: string | null },
  ) =>
    invoke<WorkMark>('set_work_mark', {
      workId,
      favorite: mark.favorite,
      rating: mark.rating,
      note: mark.note ?? null,
    }),
  /** #6: 作品詳細を開いた記録（`open_count += 1`）。 */
  recordOpen: (workId: number) => invoke<WorkMark>('record_open', { workId }),
  /** ファイルモード（#21）。`files` + `works` を JOIN して 600 件ずつ返す。 */
  listFiles: (query: FileQuery) =>
    invoke<FilePage>('list_files', {
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      kind: query.kind ?? null,
      rootId: query.rootId ?? null,
      query: query.search ?? null,
      dir: query.dir ?? null,
      metaQuery: query.metaQuery ?? null,
    }),
  /** 表示設定（`config.json`）の読み書き（#21 / #22）。 */
  loadConfig: () => invoke<AppConfig>('load_config'),
  saveConfig: (config: AppConfig) => invoke<AppConfig>('save_config', { config }),
  /** #8: 設定画面の初期表示（config.json + ルート + サムネイル + ffmpeg）。 */
  getSettings: () => invoke<AppSettings>('get_settings'),
  /** #8: 設定の差分を保存して更新後の内容を受け取る。 */
  updateSettings: (patch: SettingsPatch) => invoke<AppSettings>('update_settings', { patch }),
  /** #8: サムネイルキャッシュを削除する（DB の参照も外す）。 */
  clearThumbCache: () => invoke<ClearThumbCacheResult>('clear_thumb_cache'),
  /** #8: ffmpeg を確認する。`path` 省略で自動検出。 */
  ffmpegProbe: (path?: string | null) =>
    invoke<FfmpegProbe>('ffmpeg_probe', { path: path ?? null }),
  /** #8: ルートの深さ・有効 / 無効を更新する。 */
  updateRoot: (rootId: number, patch: { depth?: number; enabled?: boolean }) =>
    invoke<Root>('update_root', {
      rootId,
      depth: patch.depth ?? null,
      enabled: patch.enabled ?? null,
    }),
  /** #8: ルートを削除する（作品・ファイル・走査履歴も消える）。 */
  deleteRoot: (rootId: number) => invoke<void>('delete_root', { rootId }),
  /** #22: シールドの ON / OFF をウィンドウ（タイトル・Alt+Tab・キャプチャ除外）へ反映する。 */
  setShieldActive: (active: boolean) => invoke<void>('set_shield_active', { active }),
  /** #22: 設定変更後のグローバルホットキー再登録。衝突時は reject される。 */
  applyShieldHotkey: (hotkey: string) => invoke<void>('apply_shield_hotkey', { hotkey }),
  getWork: (workId: number) => invoke<WorkDetail>('get_work', { workId }),
  /** 作品詳細のヘッダだけ（ファイル一覧なし・#5）。 */
  getWorkSummary: (workId: number) => invoke<WorkInfo>('get_work_summary', { workId }),
  /** 作品内のファイル一覧（#5）。300 件ずつ読み、仮想スクロールで並べる。 */
  getWorkFiles: (query: FileQuery) =>
    invoke<FilePage>('get_work_files', {
      workId: query.workId ?? 0,
      limit: query.limit,
      offset: query.offset,
      sort: query.sort,
      kind: query.kind ?? null,
      query: query.search ?? null,
      metaQuery: query.metaQuery ?? null,
    }),
  /** 動画の再生位置（#5）。0 以下を渡すと「最初から」に戻る。 */
  saveFilePosition: (fileId: number, positionMs: number, durationMs: number | null) =>
    invoke<void>('save_file_position', { fileId, positionMs, durationMs }),
  getFilePosition: (fileId: number) =>
    invoke<FilePosition | null>('get_file_position', { fileId }),
  clearFilePosition: (fileId: number) => invoke<void>('clear_file_position', { fileId }),
  /** #60: ファイルに埋め込まれた生成情報（プロンプト・モデル等）を読む。 */
  getGenerationMeta: (fileId: number) =>
    invoke<GenerationMeta | null>('get_generation_meta', { fileId }),
  /** #60: 生成情報の検索（FTS5 + LIKE フォールバック）。 */
  searchMeta: (query: string, limit = 100) =>
    invoke<FileMetaHit[]>('search_meta', { query, limit }),
  /** #60: 生成情報の付与率（設定画面の表示用）。 */
  metaReport: () => invoke<MetaReport>('meta_report'),
  /** #60: 未抽出のファイルを `limit` 件だけ索引する。進捗は `meta://progress`。 */
  indexMeta: (limit = 500) => invoke<MetaIndexSummary>('index_meta', { limit }),
  /** #73: workflow を保存して ComfyUI を開く / API 形式を返す（コピー用）。 */
  comfyOpen: (fileId: number) => invoke<ComfyExport>('comfy_open', { fileId }),
  /** #73: 保存済みの API 形式プロンプトを ComfyUI のキューへ送る。 */
  comfyQueuePrompt: (fileId: number) =>
    invoke<ComfyQueueResult>('comfy_queue_prompt', { fileId }),
  /** #73: 設定の URL に `GET /system_stats` して接続を確認する。 */
  comfyCheck: () => invoke<ComfyStatus>('comfy_check'),
  /** #15: 作品 id から削除対象のファイル id を引く（UI はパスを渡さない）。 */
  workFileIds: (workIds: number[]) => invoke<number[]>('work_file_ids', { workIds }),
  /** #15: 選択したファイルを削除する。既定はゴミ箱、`permanent` で恒久削除。 */
  deleteFiles: (ids: number[], permanent = false) =>
    invoke<DeleteResult>('delete_files', { ids, permanent }),
  /** #15: 実行中の削除をキャンセルする（成功分は確定済み）。 */
  cancelDelete: () => invoke<boolean>('cancel_delete'),
  /** #15: 直前のゴミ箱移動を取り消す（5 秒以内）。 */
  undoDelete: (undoId: string) => invoke<UndoResult>('undo_delete', { undoId }),
  /** #57: 移動前の確認内容（移動先パス・サイズ・同一 / 別ボリューム）。 */
  inspectMove: (workId: number, targetRootId: number) =>
    invoke<MovePlan>('inspect_move', { workId, targetRootId }),
  /** #57: 作品フォルダを移動先ルートへ移す。同名は `"name (2)"` にリネーム。 */
  moveWork: (workId: number, targetRootId: number, onConflict: 'rename' | 'skip' = 'rename') =>
    invoke<MoveOutcome>('move_work', { workId, targetRootId, onConflict }),
  /** #57: 実行中の移動をキャンセルする（コピー先の部分データは削除）。 */
  cancelMove: () => invoke<boolean>('cancel_move'),
  /** #57: 直前に移動した作品を元へ戻す（同一ボリュームのみ・5 秒以内）。 */
  undoMove: (moveId: string) => invoke<MoveUndoResult>('undo_move', { moveId }),
  /** #63: ルート別の新着件数（監視で増えた累計・メモリのみ）。 */
  watchPending: () => invoke<WatchPending[]>('watch_pending'),
  /** #63: そのルートを開いたので新着バッジを消す。 */
  clearWatchPending: (rootId: number) => invoke<void>('clear_watch_pending', { rootId }),
  /** #69: 保存したスマートフォルダの一覧（並び順 → id 順）。 */
  listSmartFolders: () => invoke<SmartFolder[]>('list_smart_folders'),
  /** #69: 現在の条件を名前付きで保存する（同じ名前は条件の更新）。 */
  saveSmartFolder: (name: string, queryJson: string) =>
    invoke<SmartFolder>('save_smart_folder', { name, queryJson }),
  /** #69: スマートフォルダの名前を変える。 */
  renameSmartFolder: (id: number, name: string) =>
    invoke<SmartFolder>('rename_smart_folder', { id, name }),
  /** #69: スマートフォルダを消す（保存した条件だけ）。 */
  deleteSmartFolder: (id: number) => invoke<void>('delete_smart_folder', { id }),
  /** エクスプローラでファイルを選択 / 作品フォルダを開く（#5）。 */
  revealFile: (fileId: number) => invoke<void>('reveal_file', { fileId }),
  revealWork: (workId: number) => invoke<void>('reveal_work', { workId }),
  libraryStats: () => invoke<LibraryStats>('library_stats'),
  searchFiles: (query: string, limit = 100) =>
    invoke<FileEntry[]>('search_files', { query, limit }),
  // サムネイル（#19）。UI からの生成キックは ThumbStatus が 1 回だけ行う。
  thumbStatus: () => invoke<ThumbStatusInfo>('thumb_status'),
  thumbQueueSize: () => invoke<number>('thumb_queue_size'),
  generateThumbs: (limit = 500, force = false) =>
    invoke<ThumbSummary>('generate_thumbs', { limit, force }),
  cancelThumbs: () => invoke<boolean>('cancel_thumbs'),
  resetThumbs: (deleteFiles = true) => invoke<number>('reset_thumbs', { deleteFiles }),
  /** #67: 重複・類似の解析（重いので明示実行）。 */
  dupesStats: () => invoke<DupesStats>('dupes_stats'),
  dupesGroups: (mode: 'exact' | 'similar', threshold = 8, limit = 60) =>
    invoke<DupGroup[]>('dupes_groups', { mode, threshold, limit }),
  dupesAnalyze: (limit = 1200) => invoke<DupesAnalyzeSummary>('dupes_analyze', { limit }),
  cancelDupes: () => invoke<boolean>('cancel_dupes'),
}
