//! SQLite 索引（接続・マイグレーション・問い合わせ）。
//!
//! スキーマは `docs/scan-design.md` の 4 章が正。バージョンは `meta` テーブルの
//! `version` キーで管理し、`SCHEMA_VERSION` を上げたときに差分マイグレーションを足す。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;

use super::{IndexError, Result};

/// 現在のスキーマバージョン（`meta.version` に入る値）。
pub const SCHEMA_VERSION: i64 = 10;

/// 作品分割に指定できる最大の深さ。
pub const MAX_DEPTH: i64 = 8;

/// 初期スキーマ。ここを変更したら `SCHEMA_VERSION` を上げ、`migrate` に差分を足す。
const SCHEMA_V1: &str = r#"
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE roots (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,   -- 表示・設定用
  real_path    TEXT NOT NULL,          -- 正規化後（junction 解決済み）
  label        TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  duplicate_of INTEGER REFERENCES roots(id),
  created_at   INTEGER NOT NULL
);

CREATE TABLE works (
  id            INTEGER PRIMARY KEY,
  root_id       INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- 'video' | 'image' | 'mixed'
  cover_file_id INTEGER,
  file_count    INTEGER NOT NULL DEFAULT 0,
  total_bytes   INTEGER NOT NULL DEFAULT 0,
  mtime         INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (root_id, rel_path)
);

CREATE TABLE files (
  id            INTEGER PRIMARY KEY,
  work_id       INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- 'video' | 'image'
  bytes         INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,
  mtime         INTEGER NOT NULL,
  volume_serial INTEGER,
  file_index    INTEGER,
  thumb_path    TEXT,
  phash         TEXT,
  UNIQUE (work_id, rel_path)
);

CREATE INDEX idx_files_work  ON files(work_id, name);
CREATE INDEX idx_files_ident ON files(volume_serial, file_index);
CREATE INDEX idx_works_mtime ON works(mtime DESC);
CREATE INDEX idx_works_title ON works(title COLLATE NOCASE);

CREATE VIRTUAL TABLE files_fts USING fts5(name, content='files', content_rowid='id');

-- 外部コンテンツ FTS はトリガで同期する
CREATE TRIGGER files_fts_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
END;

CREATE TRIGGER files_fts_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.id, old.name);
END;

CREATE TRIGGER files_fts_au AFTER UPDATE OF name ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.id, old.name);
  INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
END;

CREATE TABLE scan_runs (
  id          INTEGER PRIMARY KEY,
  root_id     INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL DEFAULT 'running', -- running | done | cancelled | duplicate | failed
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  duplicates  INTEGER NOT NULL DEFAULT 0,
  files       INTEGER NOT NULL DEFAULT 0,
  works       INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_scan_runs_root ON scan_runs(root_id, id DESC);
"#;

/// サムネイル（#3）用の差分。
///
/// - `thumb_mtime` / `thumb_bytes` … サムネイル生成時点の元ファイルの mtime / size。
///   元ファイルが変わると再生成するための比較用（`files.mtime` / `files.bytes` と比較）。
/// - 既存 DB の作品カバーは「最初の画像」優先だったので、動画優先（最初の動画 → 最初の画像）に直す。
const SCHEMA_V2: &str = r#"
ALTER TABLE files ADD COLUMN thumb_mtime INTEGER;
ALTER TABLE files ADD COLUMN thumb_bytes INTEGER;

UPDATE works SET cover_file_id = COALESCE(
  (SELECT id FROM files WHERE files.work_id = works.id AND kind = 'video'
   ORDER BY name COLLATE NOCASE LIMIT 1),
  (SELECT id FROM files WHERE files.work_id = works.id AND kind = 'image'
   ORDER BY name COLLATE NOCASE LIMIT 1),
  (SELECT id FROM files WHERE files.work_id = works.id
   ORDER BY name COLLATE NOCASE LIMIT 1)
);
"#;

/// ファイルモード（#21）用の索引。
///
/// `files` を 65,000 件そのまま並べるので、並び替えと絞り込みの列に索引を張る。
/// `name` は `ORDER BY name COLLATE NOCASE` に合わせて NOCASE で作る。
const SCHEMA_V3: &str = r#"
CREATE INDEX idx_files_mtime ON files(mtime DESC);
CREATE INDEX idx_files_name ON files(name COLLATE NOCASE);
CREATE INDEX idx_files_bytes ON files(bytes DESC);
CREATE INDEX idx_files_duration ON files(duration_ms DESC);

CREATE INDEX idx_works_bytes ON works(total_bytes DESC);
CREATE INDEX idx_works_file_count ON works(file_count DESC);
"#;

/// 再生位置（#5）用の差分。
///
/// 動画の「続きから再生」を `file_id` 単位で残す。`position_ms` は 0 以上、
/// `duration_ms` は保存時点の長さ（メタデータが無ければ NULL）。
/// ファイルが消えると `ON DELETE CASCADE` で一緒に消える。
const SCHEMA_V4: &str = r#"
CREATE TABLE IF NOT EXISTS file_positions (
  file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_positions_updated ON file_positions(updated_at DESC);
"#;

/// タグ・評価・開封回数（#6 / スキーマ v5）。
///
/// - `tags` … ライブラリ全体で共有するタグ。名前は大文字小文字を区別しない。
/// - `work_tags` … 作品とタグの多対多。作品 / タグが消えたら一緒に消える。
/// - `marks` … 1 作品 1 行のお気に入り・5 段階評価・メモ・開封回数。
///   `works` を再走査しても行は更新されるだけなので、タグと評価は残る。
const SCHEMA_V5: &str = r#"
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color      TEXT NOT NULL DEFAULT '#22d3ee',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_tags (
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (work_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_work_tags_tag ON work_tags(tag_id);

CREATE TABLE IF NOT EXISTS marks (
  work_id        INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  favorite       INTEGER NOT NULL DEFAULT 0,
  rating         INTEGER,
  note           TEXT,
  last_opened_at INTEGER,
  open_count     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_marks_favorite ON marks(favorite, work_id);
CREATE INDEX IF NOT EXISTS idx_marks_last_opened ON marks(last_opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_marks_open_count ON marks(open_count DESC);
CREATE INDEX IF NOT EXISTS idx_marks_rating ON marks(rating DESC);
"#;

/// ルート絞り込み（#8 / #43）用の索引。
///
/// `find_files` / `find_works` は `w.root_id IN (SELECT id FROM roots WHERE enabled = 1)`
/// で無効化したルートを除外する。索引が無いと SQLite は `roots` を `SCAN` するため、
/// クエリプランに `SCAN` が出ないよう `enabled` に索引を張る。
const SCHEMA_V6: &str = r#"
CREATE INDEX IF NOT EXISTS idx_roots_enabled ON roots(enabled);
"#;

/// 生成メタデータのキャッシュ（#60、スキーマ v7）。
///
/// - `meta_json` … 正規化済み `GenerationMeta` の JSON。`NULL` は未抽出、
///   空文字は「抽出したが生成情報が無かった」を表す（再抽出を避けるため）。
/// - `meta_mtime` … 抽出時点の `files.mtime`。ファイルが変わったら再抽出する。
///
/// 検索用の FTS は v8 で作る（既存 DB でも列追加と FTS 構築を分けて流せるように）。
const SCHEMA_V7: &str = r#"
ALTER TABLE files ADD COLUMN meta_json TEXT;
ALTER TABLE files ADD COLUMN meta_mtime INTEGER;
CREATE INDEX IF NOT EXISTS idx_files_meta_mtime ON files(meta_mtime);
"#;

/// 生成メタデータ検索用の FTS5（#60、スキーマ v8）。
///
/// `files` の外部コンテンツにはせず、抽出時に明示的に入れ替える。
/// 生成情報が無いファイルは行を作らないので、`files_meta_fts` に載っている
/// `file_id` がそのまま「メタデータ付き」の判定に使える。
const SCHEMA_V8: &str = r#"
CREATE VIRTUAL TABLE IF NOT EXISTS files_meta_fts USING fts5(
  file_id UNINDEXED,
  prompt,
  negative_prompt,
  model,
  loras,
  tokenize = 'unicode61'
);

-- ファイルが消えたら FTS の行も消す（外部コンテンツにしていないため明示する）
CREATE TRIGGER IF NOT EXISTS files_meta_fts_ad AFTER DELETE ON files BEGIN
  DELETE FROM files_meta_fts WHERE file_id = old.id;
END;
"#;

/// 重複・類似検出用のハッシュ（#67、スキーマ v9）。
///
/// - `content_hash` … ファイル内容の SHA-1。バイト単位で同一なら完全一致の重複。
/// - `dhash` … 9x8 のグレースケール差分ハッシュ（64bit）。見た目が近い画像の判定に使う。
/// - `hash_mtime` / `hash_bytes` … 計算時点の `files.mtime` / `files.bytes`。
///   元ファイルが変わったら再計算する（`thumb_mtime` と同じ考え方）。
///
/// 既存の `phash TEXT` 列は v1 の未使用枠なので触らない。
const SCHEMA_V9: &str = r#"
ALTER TABLE files ADD COLUMN content_hash TEXT;
ALTER TABLE files ADD COLUMN dhash INTEGER;
ALTER TABLE files ADD COLUMN hash_mtime INTEGER;
ALTER TABLE files ADD COLUMN hash_bytes INTEGER;
CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);
CREATE INDEX IF NOT EXISTS idx_files_hash_mtime ON files(hash_mtime);
"#;

/// スマートフォルダ（保存検索、#69、スキーマ v10）。
///
/// - `name` … 表示名。大文字小文字を区別しない一意制約（タグと同じ扱い）。
/// - `query_json` … UI の絞り込み条件をそのまま JSON 文字列で保存する。
///   列を増やさず、条件の追加（例: 最低評価）にもスキーマ変更なしで追随できる。
/// - `sort_order` … サイドバーの並び順。保存時に末尾（`MAX + 1`）へ置く。
const SCHEMA_V10: &str = r#"
CREATE TABLE IF NOT EXISTS smart_folders (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  query_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_smart_folders_sort ON smart_folders(sort_order, id);
"#;

/// 現在時刻（UNIX エポックからのミリ秒）。
pub fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

fn system_time_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

/// ファイルの mtime をミリ秒で返す。
pub fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified().map(system_time_ms).unwrap_or_default()
}

/// `\\?\C:\...` のような拡張長パスプレフィックスを表示用に落とす。
pub fn display_path(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        raw
    }
}

/// 開発時はワークツリー内の `.cache/index.db`、リリース時は
/// `%APPDATA%\works-browser\index.db` を使う。
pub fn default_db_path() -> PathBuf {
    if let Ok(custom) = std::env::var("WORKS_BROWSER_DB") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }

    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache/index.db")
    } else {
        let base = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        base.join("works-browser").join("index.db")
    }
}

fn configure(conn: &Connection) -> Result<()> {
    // #50: 走査（大量の UPSERT）と深いページングのために読み取りキャッシュを広げる。
    // - `mmap_size` 256MB … 索引の読み取りをページキャッシュ経由のコピーにしない
    // - `cache_size` 64MB（負値は KiB 指定）… 既定 2MB では初回走査でページが溢れる
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
     PRAGMA synchronous = NORMAL;
     PRAGMA temp_store = MEMORY;
     PRAGMA foreign_keys = ON;
     PRAGMA mmap_size = 268435456;
     PRAGMA cache_size = -65536;",
    )?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

/// ファイル DB を開き、必要ならスキーマを作成する。
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| IndexError::Io {
            path: display_path(parent),
            source,
        })?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// テスト用のインメモリ DB。
pub fn open_in_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// `meta.version` を見て未適用のマイグレーションを流す。
pub fn migrate(conn: &Connection) -> Result<()> {
    let has_meta: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
        [],
        |row| row.get(0),
    )?;

    let current = if has_meta > 0 {
        schema_version(conn)?
    } else {
        0
    };
    if current > SCHEMA_VERSION {
        return Err(IndexError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }

    if current < 1 {
        conn.execute_batch(SCHEMA_V1)?;
    }

    if current < 2 {
        conn.execute_batch(SCHEMA_V2)?;
    }

    if current < 3 {
        conn.execute_batch(SCHEMA_V3)?;
    }

    if current < 4 {
        conn.execute_batch(SCHEMA_V4)?;
    }

    if current < 5 {
        conn.execute_batch(SCHEMA_V5)?;
    }

    if current < 6 {
        conn.execute_batch(SCHEMA_V6)?;
    }

    if current < 7 {
        conn.execute_batch(SCHEMA_V7)?;
    }

    if current < 8 {
        conn.execute_batch(SCHEMA_V8)?;
    }

    if current < 9 {
        conn.execute_batch(SCHEMA_V9)?;
    }

    if current < 10 {
        conn.execute_batch(SCHEMA_V10)?;
    }

    if current < SCHEMA_VERSION {
        conn.execute(
            "INSERT INTO meta(key, value) VALUES ('version', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [SCHEMA_VERSION.to_string()],
        )?;
    }

    Ok(())
}

/// `meta.version` の値。未設定なら 0。
pub fn schema_version(conn: &Connection) -> Result<i64> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(raw
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or_default())
}

/// `meta` テーブルの値を読む。
pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    let value: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(value)
}

/// `meta` テーブルの値を書く（無ければ作る）。
pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// `meta` テーブルの値を消す（既定値に戻す）。
pub fn remove_meta(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [key])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// モデル
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct Root {
    pub id: i64,
    pub path: String,
    pub real_path: String,
    pub label: String,
    pub depth: i64,
    pub enabled: bool,
    pub duplicate_of: Option<i64>,
    pub created_at: i64,
}

/// `list_roots` 用。ルート本体に件数の集計を足したもの。
#[derive(Debug, Clone, Serialize)]
pub struct RootInfo {
    pub root: Root,
    pub works: i64,
    pub files: i64,
    pub total_bytes: i64,
    pub last_scan_at: Option<i64>,
    pub last_scan_status: Option<String>,
    /// #55: パスが実在するか（ドライブ未接続・移動を検出する）。
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkSummary {
    pub id: i64,
    pub root_id: i64,
    pub rel_path: String,
    pub title: String,
    pub kind: String,
    pub cover_file_id: Option<i64>,
    /// カバー画像のサムネイル絶対パス（#3 が生成。未生成なら `None`）。
    pub cover_thumb: Option<String>,
    /// 先頭 4 ファイルのサムネイル絶対パス（#21 のホバープレビュー / モザイク）。
    /// 生成済みのものだけが名前順で入る。
    pub preview_thumbs: Vec<String>,
    pub file_count: i64,
    pub total_bytes: i64,
    pub mtime: i64,
}

/// `find_works` の絞り込み条件。UI のツールバーと 1 対 1 で対応する。
#[derive(Debug, Clone)]
pub struct WorkFilter {
    /// タイトル / 作品パスの部分一致（大文字小文字は ASCII のみ無視）。
    pub search: Option<String>,
    /// `video`（動画あり）/ `image`（画像のみ）。空なら絞り込まない。
    pub kind: Option<String>,
    pub root_id: Option<i64>,
    /// このタグが付いている作品だけ（#6）。
    pub tag_id: Option<i64>,
    /// `Some(true)` でお気に入りのみ、`Some(false)` でお気に入り以外（#6）。
    pub favorite: Option<bool>,
    /// `marks.rating >= min_rating` の作品だけ（#6）。
    pub min_rating: Option<i64>,
    /// #60: 生成メタデータ（プロンプト・モデル等）の検索語。FTS5 + LIKE。
    pub meta_query: Option<String>,
    /// `mtime` | `title` | `size` | `files` | `last_opened` | `open_count` | `created`。
    pub sort: String,
    /// #59: `asc` なら昇順（省略時はキーごとの既定）。
    pub dir: Option<String>,
    pub limit: i64,
    /// `OFFSET` 方式。`after_id` が指定されたときは無視する（互換のため残す）。
    pub offset: i64,
    /// #50: キーセット・ページングのカーソル。この作品の次から読む。
    /// `None` なら従来どおり `offset` を使う。
    pub after_id: Option<i64>,
}

impl Default for WorkFilter {
    fn default() -> Self {
        Self {
            search: None,
            kind: None,
            root_id: None,
            tag_id: None,
            favorite: None,
            min_rating: None,
            meta_query: None,
            sort: "mtime".to_string(),
            dir: None,
            limit: 50,
            offset: 0,
            after_id: None,
        }
    }
}

/// 1 ページ分の作品と、条件に一致する総数（仮想スクロールの行数に使う）。
#[derive(Debug, Clone, Serialize)]
pub struct WorkPage {
    pub works: Vec<WorkSummary>,
    pub total: i64,
}

/// ファイルモード（#21）の 1 行。作品名も一緒に返して JOIN を UI 側でやらない。
#[derive(Debug, Clone, Serialize)]
pub struct FileRow {
    pub id: i64,
    pub work_id: i64,
    /// ルートからの相対パス（`files.rel_path`）。
    pub rel_path: String,
    pub name: String,
    pub kind: String,
    pub bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub mtime: i64,
    pub thumb_path: Option<String>,
    /// 前回の再生位置（動画のみ。未保存なら `None`）。#5
    pub position_ms: Option<i64>,
    /// 所属作品のタイトル（カード左上に小さく出す）。
    pub work_title: String,
    /// 所属作品の相対パス（プレビューを開くときに使う）。
    pub work_rel_path: String,
    pub root_id: i64,
    /// #60: 生成情報がキャッシュされているか（「meta」バッジ用）。
    pub has_meta: bool,
}

/// `find_files` の絞り込み条件。UI のファイルモードのツールバーと対応する。
#[derive(Debug, Clone)]
pub struct FileFilter {
    /// ファイル名 / 相対パスの部分一致。
    pub search: Option<String>,
    /// `video` | `image`。空なら絞り込まない。
    pub kind: Option<String>,
    pub root_id: Option<i64>,
    /// 作品 1 件に絞る（#5 の作品詳細ギャラリー）。
    pub work_id: Option<i64>,
    /// #60: 生成メタデータ（プロンプト・モデル等）の検索語。FTS5 + LIKE。
    pub meta_query: Option<String>,
    /// `mtime` | `name` | `size` | `duration`。
    pub sort: String,
    /// #59: `asc` なら昇順（省略時はキーごとの既定）。
    pub dir: Option<String>,
    pub limit: i64,
    /// `OFFSET` 方式。`after_id` が指定されたときは無視する（互換のため残す）。
    pub offset: i64,
    /// #50: キーセット・ページングのカーソル。このファイルの次から読む。
    /// `None` なら従来どおり `offset` を使う。
    pub after_id: Option<i64>,
}

impl Default for FileFilter {
    fn default() -> Self {
        Self {
            search: None,
            kind: None,
            root_id: None,
            work_id: None,
            meta_query: None,
            sort: "mtime".to_string(),
            dir: None,
            limit: 600,
            offset: 0,
            after_id: None,
        }
    }
}

/// 1 ページ分のファイルと、条件に一致する総数。
#[derive(Debug, Clone, Serialize)]
pub struct FilePage {
    pub files: Vec<FileRow>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub id: i64,
    pub work_id: i64,
    pub rel_path: String,
    pub name: String,
    pub kind: String,
    pub bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub mtime: i64,
    /// サムネイルのキャッシュパス（未生成なら `None`。#3）。
    pub thumb_path: Option<String>,
    /// 前回の再生位置（動画のみ。未保存なら `None`）。#5
    pub position_ms: Option<i64>,
}

/// #60: 生成メタデータ検索の 1 件。`search_meta` が返す。
#[derive(Debug, Clone, Serialize)]
pub struct FileMetaHit {
    pub file_id: i64,
    pub work_id: i64,
    pub work_title: String,
    pub name: String,
    pub rel_path: String,
    pub kind: String,
    /// ヒット箇所の抜粋（FTS の `snippet`。LIKE フォールバックでは先頭）。
    pub snippet: String,
}

/// #60: 生成メタデータ付与率の 1 ルート分。
#[derive(Debug, Clone, Serialize)]
pub struct MetaRootReport {
    pub root_id: i64,
    pub label: String,
    pub with_meta: i64,
    pub total: i64,
}

/// #60: 生成メタデータ付与率の全体 + ルート別。
#[derive(Debug, Clone, Serialize)]
pub struct MetaReport {
    pub total: i64,
    pub with_meta: i64,
    pub without_meta: i64,
    pub by_root: Vec<MetaRootReport>,
}

/// #60: まだキャッシュしていないファイル 1 件（遅延抽出の入力）。
#[derive(Debug, Clone)]
pub struct PendingMetaFile {
    pub file_id: i64,
    pub path: PathBuf,
    pub mtime: i64,
}

/// #60: 生成メタデータの索引結果。
#[derive(Debug, Clone, Serialize)]
pub struct MetaIndexSummary {
    /// 今回処理した件数。
    pub total: i64,
    /// 生成情報が見つかってキャッシュした件数。
    pub with_meta: i64,
    /// 見つからなかった件数（空文字でキャッシュし、次回は飛ばす）。
    pub without_meta: i64,
    /// 読み取りに失敗した件数（次回に再試行）。
    pub failed: i64,
    /// まだ残っている件数（`limit` で打ち切った場合）。
    pub remaining: i64,
}

/// 動画の再生位置（#5）。`file_positions` テーブルと対応する。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FilePosition {
    pub file_id: i64,
    pub position_ms: i64,
    pub duration_ms: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkDetail {
    pub work: WorkSummary,
    pub root_label: String,
    /// ファイルの絶対パスを作るためのルート実体パス。
    pub root_real_path: String,
    pub files: Vec<FileEntry>,
}

/// 作品詳細のヘッダ用（ファイル一覧を含まない軽い版）。#5
#[derive(Debug, Clone, Serialize)]
pub struct WorkInfo {
    pub work: WorkSummary,
    pub root_label: String,
    pub root_real_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryStats {
    pub roots: i64,
    pub works: i64,
    pub files: i64,
    pub total_bytes: i64,
    pub last_scan_at: Option<i64>,
    pub last_scan_status: Option<String>,
}

/// ライブラリ全体で共有するタグ（#6）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    /// `#rrggbb`（小文字）。
    pub color: String,
    pub created_at: i64,
    /// このタグが付いている作品数（`list_tags` の表示用）。
    pub works: i64,
}

/// 作品 1 件のお気に入り・評価・メモ・開封回数（#6）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkMark {
    pub work_id: i64,
    pub favorite: bool,
    /// 1〜5。未評価は `None`。
    pub rating: Option<i64>,
    pub note: Option<String>,
    /// 最後に作品詳細を開いた時刻（ms）。未開封は `None`。
    pub last_opened_at: Option<i64>,
    pub open_count: i64,
}

impl WorkMark {
    fn empty(work_id: i64) -> Self {
        Self {
            work_id,
            favorite: false,
            rating: None,
            note: None,
            last_opened_at: None,
            open_count: 0,
        }
    }
}

/// 保存した絞り込み条件（スマートフォルダ、#69）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SmartFolder {
    pub id: i64,
    pub name: String,
    /// UI が組み立てた条件 JSON（`SmartFolderQuery`）をそのまま返す。
    pub query_json: String,
    /// サイドバーの並び順（小さいほど上）。
    pub sort_order: i64,
    pub created_at: i64,
}

/// スマートフォルダ名の上限（タグ名と揃える）。
pub const SMART_FOLDER_NAME_MAX: usize = 40;

// ---------------------------------------------------------------------------
// roots
// ---------------------------------------------------------------------------

fn map_root(row: &Row<'_>) -> rusqlite::Result<Root> {
    Ok(Root {
        id: row.get(0)?,
        path: row.get(1)?,
        real_path: row.get(2)?,
        label: row.get(3)?,
        depth: row.get(4)?,
        enabled: row.get::<_, i64>(5)? != 0,
        duplicate_of: row.get(6)?,
        created_at: row.get(7)?,
    })
}

const ROOT_COLUMNS: &str = "id, path, real_path, label, depth, enabled, duplicate_of, created_at";

/// ルートを登録する（同じパスなら深さなどを更新して既存を返す）。
pub fn add_root(conn: &Connection, path: &str, depth: i64) -> Result<Root> {
    if !(0..=MAX_DEPTH).contains(&depth) {
        return Err(IndexError::InvalidDepth {
            max: MAX_DEPTH,
            got: depth,
        });
    }

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(IndexError::NotADirectory(path.to_string()));
    }

    let given = PathBuf::from(trimmed);
    let meta = fs::metadata(&given).map_err(|source| IndexError::Io {
        path: trimmed.to_string(),
        source,
    })?;
    if !meta.is_dir() {
        return Err(IndexError::NotADirectory(trimmed.to_string()));
    }

    let real = fs::canonicalize(&given).map_err(|source| IndexError::Io {
        path: trimmed.to_string(),
        source,
    })?;
    let real_path = display_path(&real);
    let path = if given.is_absolute() {
        display_path(&given)
    } else {
        real_path.clone()
    };
    let label = given
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| real_path.clone());
    let created_at = now_ms();

    // 同じ表示パスのルートがあれば、深さなどを更新して既存を返す（追加のやり直し）
    let same_path: Option<i64> = conn
        .query_row(
            "SELECT id FROM roots WHERE path = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
            params![path],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = same_path {
        conn.execute(
            "UPDATE roots SET real_path = ?1, label = ?2, depth = ?3, enabled = 1 WHERE id = ?4",
            params![real_path, label, depth, id],
        )?;
        return get_root(conn, id);
    }

    // 表示パスは違うが実体が同じルート（junction など）。
    // 先に登録された側だけを索引するため、後から追加した側は `duplicate_of` を記録する。
    let duplicate_of: Option<i64> = conn
        .query_row(
            "SELECT id FROM roots WHERE real_path = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
            params![real_path],
            |row| row.get(0),
        )
        .optional()?;

    conn.execute(
        "INSERT INTO roots(path, real_path, label, depth, enabled, duplicate_of, created_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)",
        params![path, real_path, label, depth, duplicate_of, created_at],
    )?;
    let id = conn.last_insert_rowid();

    get_root(conn, id)
}

/// 1 ルートを取得する。
pub fn get_root(conn: &Connection, id: i64) -> Result<Root> {
    let sql = format!("SELECT {ROOT_COLUMNS} FROM roots WHERE id = ?1");
    conn.query_row(&sql, [id], map_root)
        .optional()?
        .ok_or(IndexError::RootNotFound(id))
}

/// 登録済みルートの一覧（件数付き）。
pub fn list_roots(conn: &Connection) -> Result<Vec<RootInfo>> {
    let sql = format!(
    "SELECT {ROOT_COLUMNS},
       (SELECT COUNT(*) FROM works w WHERE w.root_id = r.id),
       (SELECT COUNT(*) FROM files f JOIN works w ON w.id = f.work_id WHERE w.root_id = r.id),
       (SELECT COALESCE(SUM(f.bytes), 0) FROM files f JOIN works w ON w.id = f.work_id WHERE w.root_id = r.id),
       (SELECT MAX(s.finished_at) FROM scan_runs s WHERE s.root_id = r.id AND s.status = 'done'),
       (SELECT s.status FROM scan_runs s WHERE s.root_id = r.id ORDER BY s.id DESC LIMIT 1)
     FROM roots r ORDER BY r.id"
  );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |row| {
        let root = map_root(row)?;
        // #55: ドライブが抜けている・移動されたルートを UI で示す
        let exists = std::path::Path::new(&root.path).exists();
        Ok(RootInfo {
            root,
            works: row.get(8)?,
            files: row.get(9)?,
            total_bytes: row.get(10)?,
            last_scan_at: row.get(11)?,
            last_scan_status: row.get(12)?,
            exists,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// ルートを無効化する（索引は残す）。
pub fn set_root_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<()> {
    conn.execute(
        "UPDATE roots SET enabled = ?1 WHERE id = ?2",
        params![if enabled { 1_i64 } else { 0_i64 }, id],
    )?;
    Ok(())
}

/// ルートの深さ・有効 / 無効・表示名を更新する（指定した項目だけ。#8）。
///
/// 深さを変えた場合は索引を作り直すまで `works` の分割は古いままなので、
/// UI は「次回の走査から反映」と案内する。
pub fn update_root(
    conn: &Connection,
    id: i64,
    depth: Option<i64>,
    enabled: Option<bool>,
    label: Option<&str>,
) -> Result<Root> {
    if let Some(depth) = depth {
        if !(0..=MAX_DEPTH).contains(&depth) {
            return Err(IndexError::InvalidDepth {
                max: MAX_DEPTH,
                got: depth,
            });
        }
    }
    let current = get_root(conn, id)?;
    let next_label = match label.map(str::trim) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => current.label,
    };
    conn.execute(
        "UPDATE roots SET depth = COALESCE(?2, depth),
            enabled = COALESCE(?3, enabled), label = ?4
         WHERE id = ?1",
        params![
            id,
            depth,
            enabled.map(|value| if value { 1_i64 } else { 0_i64 }),
            next_label
        ],
    )?;
    get_root(conn, id)
}

/// ルートを削除する（作品・ファイル・走査履歴も `ON DELETE CASCADE` で消える）。
///
/// このルートを `duplicate_of` に持つ別ルートは、参照を外してから消す。
pub fn delete_root(conn: &Connection, id: i64) -> Result<()> {
    get_root(conn, id)?;
    conn.execute(
        "UPDATE roots SET duplicate_of = NULL WHERE duplicate_of = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM roots WHERE id = ?1", [id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// scan_runs
// ---------------------------------------------------------------------------

/// 走査開始を記録し、`scan_runs.id` を返す。
pub fn start_scan_run(conn: &Connection, root_id: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO scan_runs(root_id, started_at, status) VALUES (?1, ?2, 'running')",
        params![root_id, now_ms()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 走査結果を `scan_runs` に書き戻す。
pub struct ScanRunResult<'a> {
    pub status: &'a str,
    pub added: u64,
    pub updated: u64,
    pub removed: u64,
    pub duplicates: u64,
    pub files: u64,
    pub works: u64,
    pub total_bytes: i64,
}

pub fn finish_scan_run(conn: &Connection, run_id: i64, result: &ScanRunResult<'_>) -> Result<()> {
    conn.execute(
        "UPDATE scan_runs SET finished_at = ?1, status = ?2, added = ?3, updated = ?4,
       removed = ?5, duplicates = ?6, files = ?7, works = ?8, total_bytes = ?9
     WHERE id = ?10",
        params![
            now_ms(),
            result.status,
            result.added as i64,
            result.updated as i64,
            result.removed as i64,
            result.duplicates as i64,
            result.files as i64,
            result.works as i64,
            result.total_bytes,
            run_id
        ],
    )?;
    Ok(())
}

/// 走査が例外で落ちたときの後始末。
pub fn fail_scan_run(conn: &Connection, run_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE scan_runs SET finished_at = ?1, status = 'failed' WHERE id = ?2",
        params![now_ms(), run_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// works / files
// ---------------------------------------------------------------------------

fn map_work(row: &Row<'_>) -> rusqlite::Result<WorkSummary> {
    let preview_raw: Option<String> = row.get(10)?;
    Ok(WorkSummary {
        id: row.get(0)?,
        root_id: row.get(1)?,
        rel_path: row.get(2)?,
        title: row.get(3)?,
        kind: row.get(4)?,
        cover_file_id: row.get(5)?,
        cover_thumb: row.get(9)?,
        preview_thumbs: preview_raw
            .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
            .unwrap_or_default(),
        file_count: row.get(6)?,
        total_bytes: row.get(7)?,
        mtime: row.get(8)?,
    })
}

const WORK_COLUMNS: &str =
    "id, root_id, rel_path, title, kind, cover_file_id, file_count, total_bytes, mtime";

/// 一覧用の SELECT 列（カバーとホバープレビュー用の先頭 4 枚）。
fn work_select() -> String {
    format!(
        "{}, cf.thumb_path AS cover_thumb,
     (SELECT json_group_array(t.thumb_path) FROM (
        SELECT f2.thumb_path FROM files f2
        WHERE f2.work_id = w.id AND f2.thumb_path IS NOT NULL
        ORDER BY f2.name COLLATE NOCASE, f2.id LIMIT 4
      ) t) AS preview_thumbs",
        WORK_COLUMNS
            .split(", ")
            .map(|column| format!("w.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// 並び順の SQL。未知の値はエラーにする。
fn order_clause(sort: &str, dir: Option<&str>) -> Result<String> {
    let asc = match dir {
        Some("asc") => true,
        Some("desc") => false,
        // 未指定は従来どおり（名前だけ昇順）
        _ => matches!(sort, "title"),
    };
    let dir = if asc { "ASC" } else { "DESC" };
    Ok(match sort {
        "mtime" | "" => format!("w.mtime {dir}, w.id {dir}"),
        // #59: 「新しく追加した順」は created_at で見る（更新日とは別）
        "created" => format!("w.created_at {dir}, w.id {dir}"),
        "title" => format!("w.title COLLATE NOCASE {dir}, w.id {dir}"),
        "size" => format!("w.total_bytes {dir}, w.id {dir}"),
        "files" => format!("w.file_count {dir}, w.id {dir}"),
        // #6: 「最近見た」は未開封を末尾へ、「よく見る」は開封回数の多い順
        "last_opened" => {
            format!("m.last_opened_at IS NULL ASC, m.last_opened_at {dir}, w.id {dir}")
        }
        "open_count" => format!("m.open_count IS NULL ASC, m.open_count {dir}, w.id {dir}"),
        other => return Err(IndexError::InvalidSort(other.to_string())),
    })
}

/// 作品をページングで取得する（絞り込みなし・#2 の既存 API）。
pub fn list_works(
    conn: &Connection,
    limit: i64,
    offset: i64,
    sort: &str,
) -> Result<Vec<WorkSummary>> {
    let filter = WorkFilter {
        limit,
        offset,
        sort: sort.to_string(),
        ..Default::default()
    };
    Ok(find_works(conn, &filter)?.works)
}

/// `LIKE` 用のパターンを作る。`%` / `_` / `\` はエスケープする。
fn search_pattern(search: Option<&str>) -> Option<String> {
    let trimmed = search?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let escaped = trimmed
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Some(format!("%{escaped}%"))
}

/// #60: 生成メタデータ検索の FTS5 クエリを組み立てる。
///
/// ユーザー入力には FTS の演算子（`"` `*` `:` `(` `)` `^` `-`）が混ざり得るため、
/// 英数字・日本語・`_` だけを残した語を引用符で囲み、`AND` でつなぐ。
/// これで構文エラーにならず、空になったら `None`（フィルタ無し）にする。
fn fts_match_query(raw: &str) -> Option<String> {
    let tokens: Vec<String> = raw
        .split_whitespace()
        .filter_map(|token| {
            let cleaned: String = token
                .chars()
                .filter(|ch| ch.is_alphanumeric() || *ch == '_')
                .collect();
            if cleaned.is_empty() {
                None
            } else {
                Some(format!("\"{cleaned}\""))
            }
        })
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" AND "))
    }
}

/// #60: 生成メタデータの検索条件。FTS5 のヒットと、生 JSON への `LIKE`
/// （シード値など FTS に載せていない項目・部分一致）のどちらでも拾う。
///
/// `scope` は相関条件（例: `mf.work_id = w.id` / `mf.id = f.id`）。
fn meta_filter_clause(raw: Option<&str>, scope: &str) -> Option<(String, Vec<Value>)> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut values = Vec::new();
    let mut clauses = Vec::new();

    if let Some(match_query) = fts_match_query(trimmed) {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM files_meta_fts
               JOIN files mf ON mf.id = files_meta_fts.file_id
              WHERE {scope} AND files_meta_fts MATCH ?)"
        ));
        values.push(Value::Text(match_query));
    }
    if let Some(pattern) = search_pattern(Some(trimmed)) {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM files mf
              WHERE {scope} AND mf.meta_json LIKE ? ESCAPE '\\')"
        ));
        values.push(Value::Text(pattern));
    }

    if clauses.is_empty() {
        None
    } else {
        Some((format!("({})", clauses.join(" OR ")), values))
    }
}

/// 絞り込み条件を `WHERE` 句とプレースホルダの値に変換する。
fn filter_clause(filter: &WorkFilter) -> (String, Vec<Value>) {
    // #8: 無効化したルートはライブラリから即座に消す。
    let mut clauses = vec![
        "w.file_count > 0".to_string(),
        "w.root_id IN (SELECT id FROM roots WHERE enabled = 1)".to_string(),
    ];
    let mut values: Vec<Value> = Vec::new();

    if let Some(root_id) = filter.root_id {
        clauses.push("w.root_id = ?".to_string());
        values.push(Value::Integer(root_id));
    }

    match filter.kind.as_deref() {
        None | Some("") => {}
        Some("video") => clauses.push("w.kind IN ('video', 'mixed')".to_string()),
        Some("image") => clauses.push("w.kind = 'image'".to_string()),
        // 未知の種別は `find_works` が事前に弾く
        Some(_) => {}
    }

    // タイトル / パスの検索と生成情報の検索は「どちらかに当たれば」で OR する
    // （UI の「生成情報も検索」は既存の検索を置き換えず、対象を広げる）。
    let search_clause = search_pattern(filter.search.as_deref()).map(|pattern| {
        let clause = "(w.title LIKE ? ESCAPE '\\' OR w.rel_path LIKE ? ESCAPE '\\')".to_string();
        let clause_values = vec![Value::Text(pattern.clone()), Value::Text(pattern)];
        (clause, clause_values)
    });
    let meta = meta_filter_clause(filter.meta_query.as_deref(), "mf.work_id = w.id");
    match (search_clause, meta) {
        (Some((search_sql, search_values)), Some((meta_sql, meta_values))) => {
            clauses.push(format!("({search_sql} OR {meta_sql})"));
            values.extend(search_values);
            values.extend(meta_values);
        }
        (Some((search_sql, search_values)), None) => {
            clauses.push(search_sql);
            values.extend(search_values);
        }
        (None, Some((meta_sql, meta_values))) => {
            clauses.push(meta_sql);
            values.extend(meta_values);
        }
        (None, None) => {}
    }

    if let Some(tag_id) = filter.tag_id {
        clauses.push(
            "EXISTS (SELECT 1 FROM work_tags wt WHERE wt.work_id = w.id AND wt.tag_id = ?)"
                .to_string(),
        );
        values.push(Value::Integer(tag_id));
    }

    match filter.favorite {
        Some(true) => clauses.push(
            "EXISTS (SELECT 1 FROM marks mk WHERE mk.work_id = w.id AND mk.favorite = 1)"
                .to_string(),
        ),
        Some(false) => clauses.push(
            "NOT EXISTS (SELECT 1 FROM marks mk WHERE mk.work_id = w.id AND mk.favorite = 1)"
                .to_string(),
        ),
        None => {}
    }

    if let Some(min_rating) = filter.min_rating {
        clauses.push(
            "EXISTS (SELECT 1 FROM marks mk WHERE mk.work_id = w.id
               AND mk.rating IS NOT NULL AND mk.rating >= ?)"
                .to_string(),
        );
        values.push(Value::Integer(min_rating));
    }

    (clauses.join(" AND "), values)
}

/// キーセット・ページングで使う作品 1 行分のカーソル値。
struct WorkCursor {
    id: i64,
    mtime: i64,
    title: String,
    total_bytes: i64,
    file_count: i64,
    last_opened_at: Option<i64>,
    open_count: Option<i64>,
}

fn load_work_cursor(conn: &Connection, id: i64) -> Result<Option<WorkCursor>> {
    Ok(conn
        .query_row(
            "SELECT w.id, w.mtime, w.title, w.total_bytes, w.file_count,
                    m.last_opened_at, m.open_count
             FROM works w LEFT JOIN marks m ON m.work_id = w.id
             WHERE w.id = ?1",
            [id],
            |row| {
                Ok(WorkCursor {
                    id: row.get(0)?,
                    mtime: row.get(1)?,
                    title: row.get(2)?,
                    total_bytes: row.get(3)?,
                    file_count: row.get(4)?,
                    last_opened_at: row.get(5)?,
                    open_count: row.get(6)?,
                })
            },
        )
        .optional()?)
}

/// `after_id` の次から読むための条件と、ORDER BY を索引で満たすための索引名。
fn work_keyset_clause(sort: &str, cursor: &WorkCursor) -> (&'static str, String, Vec<Value>) {
    // 並び順は `order_clause` と 1 対 1。最後の `w.id` で同値を割る。
    match sort {
        "title" => (
            "idx_works_title",
            "(w.title COLLATE NOCASE > ? OR (w.title COLLATE NOCASE = ? AND w.id > ?))".to_string(),
            vec![
                Value::Text(cursor.title.clone()),
                Value::Text(cursor.title.clone()),
                Value::Integer(cursor.id),
            ],
        ),
        "size" => (
            "idx_works_bytes",
            "(w.total_bytes, w.id) < (?, ?)".to_string(),
            vec![
                Value::Integer(cursor.total_bytes),
                Value::Integer(cursor.id),
            ],
        ),
        "files" => (
            "idx_works_file_count",
            "(w.file_count, w.id) < (?, ?)".to_string(),
            vec![Value::Integer(cursor.file_count), Value::Integer(cursor.id)],
        ),
        // 未開封（NULL）は末尾。NULL 群の中では id の降順が続く。
        "last_opened" => match cursor.last_opened_at {
            None => (
                "",
                "(m.last_opened_at IS NULL AND w.id < ?)".to_string(),
                vec![Value::Integer(cursor.id)],
            ),
            Some(value) => (
                "",
                "(m.last_opened_at IS NULL
                  OR m.last_opened_at < ? OR (m.last_opened_at = ? AND w.id < ?))"
                    .to_string(),
                vec![
                    Value::Integer(value),
                    Value::Integer(value),
                    Value::Integer(cursor.id),
                ],
            ),
        },
        "open_count" => match cursor.open_count {
            None => (
                "",
                "(m.open_count IS NULL AND w.id < ?)".to_string(),
                vec![Value::Integer(cursor.id)],
            ),
            Some(value) => (
                "",
                "(m.open_count IS NULL
                  OR m.open_count < ? OR (m.open_count = ? AND w.id < ?))"
                    .to_string(),
                vec![
                    Value::Integer(value),
                    Value::Integer(value),
                    Value::Integer(cursor.id),
                ],
            ),
        },
        // `mtime` / 空（`order_clause` が未知の並び順を先に弾く）
        _ => (
            "idx_works_mtime",
            "(w.mtime, w.id) < (?, ?)".to_string(),
            vec![Value::Integer(cursor.mtime), Value::Integer(cursor.id)],
        ),
    }
}

/// 1 ページ分の SQL とプレースホルダ値を組み立てる（#50 でキーセット対応）。
fn work_page_query(
    conn: &Connection,
    filter: &WorkFilter,
    where_sql: &str,
    order: &str,
    mut values: Vec<Value>,
) -> Result<(String, Vec<Value>)> {
    let mut page_where = where_sql.to_string();
    let mut index_hint = "";

    if let Some(after_id) = filter.after_id.filter(|id| *id > 0) {
        match load_work_cursor(conn, after_id)? {
            Some(cursor) => {
                let (index, clause, cursor_values) = work_keyset_clause(&filter.sort, &cursor);
                index_hint = index;
                page_where = format!("({page_where}) AND {clause}");
                values.extend(cursor_values);
            }
            // カーソルが消えていたら空ページ（総数だけ返す）
            None => {
                page_where = "0".to_string();
                values.clear();
            }
        }
    }

    let hint = if index_hint.is_empty() {
        String::new()
    } else {
        format!(" INDEXED BY {index_hint}")
    };
    let sql = format!(
        "SELECT {} FROM works w{hint}
     LEFT JOIN files cf ON cf.id = w.cover_file_id
     LEFT JOIN marks m ON m.work_id = w.id
     WHERE {page_where} ORDER BY {order} LIMIT ? OFFSET ?",
        work_select()
    );
    Ok((sql, values))
}

/// 条件に一致する作品を 1 ページ分と総数で返す（ライブラリ画面用）。
///
/// #50: `after_id` を指定するとキーセット・ページングになる（`offset` は無視）。
/// 深いページでも先頭から読み飛ばさないため、件数によらず一定の時間で返る。
pub fn find_works(conn: &Connection, filter: &WorkFilter) -> Result<WorkPage> {
    if let Some(kind) = filter.kind.as_deref() {
        if !kind.is_empty() && kind != "video" && kind != "image" {
            return Err(IndexError::InvalidKind(kind.to_string()));
        }
    }
    let order = order_clause(&filter.sort, filter.dir.as_deref())?;
    let (where_sql, values) = filter_clause(filter);

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM works w WHERE {where_sql}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;

    let (sql, mut page_values) = work_page_query(conn, filter, &where_sql, &order, values)?;
    page_values.push(Value::Integer(filter.limit.clamp(0, 1000)));
    page_values.push(Value::Integer(if filter.after_id.is_some() {
        0
    } else {
        filter.offset.max(0)
    }));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(page_values.iter()), map_work)?;
    let works = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(WorkPage { works, total })
}

/// ファイルモードの並び順。未知の値はエラーにする。
///
/// `duration` は動画だけ値があるので、NULL（画像）を末尾へ送る。
/// `DESC` では SQLite が NULL を最後に並べるため、`IS NULL` の式を挟まずに索引の順序で
/// そのまま満たせる（#50: キーセットで全件ソートさせない）。
fn file_order_clause(sort: &str, dir: Option<&str>) -> Result<String> {
    let asc = match dir {
        Some("asc") => true,
        Some("desc") => false,
        _ => matches!(sort, "name"),
    };
    let dir = if asc { "ASC" } else { "DESC" };
    Ok(match sort {
        "mtime" | "" => format!("f.mtime {dir}, f.id {dir}"),
        "name" => format!("f.name COLLATE NOCASE {dir}, f.id {dir}"),
        "size" => format!("f.bytes {dir}, f.id {dir}"),
        "duration" => format!("f.duration_ms {dir}, f.id {dir}"),
        other => return Err(IndexError::InvalidSort(other.to_string())),
    })
}

fn map_file(row: &Row<'_>) -> rusqlite::Result<FileRow> {
    Ok(FileRow {
        id: row.get(0)?,
        work_id: row.get(1)?,
        rel_path: row.get(2)?,
        name: row.get(3)?,
        kind: row.get(4)?,
        bytes: row.get(5)?,
        width: row.get(6)?,
        height: row.get(7)?,
        duration_ms: row.get(8)?,
        mtime: row.get(9)?,
        thumb_path: row.get(10)?,
        work_title: row.get(11)?,
        work_rel_path: row.get(12)?,
        root_id: row.get(13)?,
        position_ms: row.get(14)?,
        has_meta: row.get(15)?,
    })
}

/// ファイルモードの `WHERE` 句とプレースホルダ値を組み立てる（#43 で `find_files` から分離）。
fn file_filter_clause(filter: &FileFilter) -> (String, Vec<Value>) {
    // #8: 無効化したルートはファイルモードからも消す。
    let mut clauses: Vec<String> =
        vec!["w.root_id IN (SELECT id FROM roots WHERE enabled = 1)".to_string()];
    let mut values: Vec<Value> = Vec::new();

    match filter.kind.as_deref() {
        Some("video") => clauses.push("f.kind = 'video'".to_string()),
        Some("image") => clauses.push("f.kind = 'image'".to_string()),
        _ => {}
    }
    if let Some(root_id) = filter.root_id {
        clauses.push("w.root_id = ?".to_string());
        values.push(Value::Integer(root_id));
    }
    if let Some(work_id) = filter.work_id {
        clauses.push("w.id = ?".to_string());
        values.push(Value::Integer(work_id));
    }
    // ファイル名検索と生成情報検索はどちらかに当たれば採用（UI の「生成情報も検索」用）
    let search_clause = search_pattern(filter.search.as_deref()).map(|pattern| {
        let clause = "(f.name LIKE ? ESCAPE '\\' OR f.rel_path LIKE ? ESCAPE '\\')".to_string();
        let clause_values = vec![Value::Text(pattern.clone()), Value::Text(pattern)];
        (clause, clause_values)
    });
    let meta = meta_filter_clause(filter.meta_query.as_deref(), "mf.id = f.id");
    match (search_clause, meta) {
        (Some((search_sql, search_values)), Some((meta_sql, meta_values))) => {
            clauses.push(format!("({search_sql} OR {meta_sql})"));
            values.extend(search_values);
            values.extend(meta_values);
        }
        (Some((search_sql, search_values)), None) => {
            clauses.push(search_sql);
            values.extend(search_values);
        }
        (None, Some((meta_sql, meta_values))) => {
            clauses.push(meta_sql);
            values.extend(meta_values);
        }
        (None, None) => {}
    }

    let where_sql = if clauses.is_empty() {
        "1 = 1".to_string()
    } else {
        clauses.join(" AND ")
    };
    (where_sql, values)
}

/// キーセット・ページングで使うファイル 1 行分のカーソル値。
struct FileCursor {
    id: i64,
    mtime: i64,
    name: String,
    bytes: i64,
    duration_ms: Option<i64>,
}

fn load_file_cursor(conn: &Connection, id: i64) -> Result<Option<FileCursor>> {
    Ok(conn
        .query_row(
            "SELECT id, mtime, name, bytes, duration_ms FROM files WHERE id = ?1",
            [id],
            |row| {
                Ok(FileCursor {
                    id: row.get(0)?,
                    mtime: row.get(1)?,
                    name: row.get(2)?,
                    bytes: row.get(3)?,
                    duration_ms: row.get(4)?,
                })
            },
        )
        .optional()?)
}

/// `after_id` の次から読むための条件と、ORDER BY を索引で満たすための索引名。
fn file_keyset_clause(sort: &str, cursor: &FileCursor) -> (&'static str, String, Vec<Value>) {
    // 並び順は `file_order_clause` と 1 対 1。最後の `f.id` で同値を割る。
    match sort {
        "name" => (
            "idx_files_name",
            "(f.name COLLATE NOCASE > ? OR (f.name COLLATE NOCASE = ? AND f.id > ?))".to_string(),
            vec![
                Value::Text(cursor.name.clone()),
                Value::Text(cursor.name.clone()),
                Value::Integer(cursor.id),
            ],
        ),
        "size" => (
            "idx_files_bytes",
            "(f.bytes, f.id) < (?, ?)".to_string(),
            vec![Value::Integer(cursor.bytes), Value::Integer(cursor.id)],
        ),
        // 尺の無い画像（NULL）は末尾。NULL 群の中では id の降順が続く。
        "duration" => match cursor.duration_ms {
            None => (
                "idx_files_duration",
                "(f.duration_ms IS NULL AND f.id < ?)".to_string(),
                vec![Value::Integer(cursor.id)],
            ),
            Some(value) => (
                "idx_files_duration",
                "(f.duration_ms IS NULL
                  OR f.duration_ms < ? OR (f.duration_ms = ? AND f.id < ?))"
                    .to_string(),
                vec![
                    Value::Integer(value),
                    Value::Integer(value),
                    Value::Integer(cursor.id),
                ],
            ),
        },
        // `mtime` / 空（`file_order_clause` が未知の並び順を先に弾く）
        _ => (
            "idx_files_mtime",
            "(f.mtime, f.id) < (?, ?)".to_string(),
            vec![Value::Integer(cursor.mtime), Value::Integer(cursor.id)],
        ),
    }
}

/// ファイルモードの 1 ページ分の SQL（`LIMIT ? OFFSET ?` を含む）。
///
/// `index` はキーセット・ページングのときに ORDER BY を索引で満たすための指定。
/// これを付けないと SQLite は `works` 側から引いて全件ソートする（#50 で実測）。
fn file_page_sql(where_sql: &str, order: &str, index: Option<&str>) -> String {
    let hint = index
        .map(|name| format!(" INDEXED BY {name}"))
        .unwrap_or_default();
    format!(
        "SELECT f.id, f.work_id, f.rel_path, f.name, f.kind, f.bytes, f.width, f.height,
            f.duration_ms, f.mtime, f.thumb_path, w.title, w.rel_path, w.root_id,
            fp.position_ms, (f.meta_json IS NOT NULL AND f.meta_json <> '') AS has_meta
     FROM files f{hint} JOIN works w ON w.id = f.work_id
     LEFT JOIN file_positions fp ON fp.file_id = f.id
     WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    )
}

/// 1 ページ分の SQL とプレースホルダ値を組み立てる（#50 でキーセット対応）。
fn file_page_query(
    conn: &Connection,
    filter: &FileFilter,
    where_sql: &str,
    order: &str,
    mut values: Vec<Value>,
) -> Result<(String, Vec<Value>)> {
    let mut page_where = where_sql.to_string();
    let mut index: Option<&str> = None;

    if let Some(after_id) = filter.after_id.filter(|id| *id > 0) {
        match load_file_cursor(conn, after_id)? {
            Some(cursor) => {
                let (hint, clause, cursor_values) = file_keyset_clause(&filter.sort, &cursor);
                index = Some(hint);
                page_where = format!("({page_where}) AND {clause}");
                values.extend(cursor_values);
            }
            // カーソルが消えていたら空ページ（総数だけ返す）
            None => {
                page_where = "0".to_string();
                values.clear();
            }
        }
    }

    let sql = file_page_sql(&page_where, order, index);
    values.push(Value::Integer(filter.limit.clamp(0, 1000)));
    values.push(Value::Integer(if filter.after_id.is_some() {
        0
    } else {
        filter.offset.max(0)
    }));
    Ok((sql, values))
}

/// テスト用: `find_files` が実際に使う SQL の `EXPLAIN QUERY PLAN`（#43）。
///
/// 計測テストだけでは「速いが `SCAN` している」状態を見逃すため、
/// クエリプランに `SCAN` が無いことをテストで確認する。
#[cfg(test)]
pub fn explain_find_files(conn: &Connection, filter: &FileFilter) -> Result<Vec<String>> {
    let order = file_order_clause(&filter.sort, filter.dir.as_deref())?;
    let (where_sql, values) = file_filter_clause(filter);
    let (sql, values) = file_page_query(conn, filter, &where_sql, &order, values)?;
    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let rows = stmt.query_map(params_from_iter(values.iter()), |row| {
        row.get::<_, String>(3)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// `files` を作品をまたいで直接ページングする（#21 のファイルモード）。
///
/// `limit` / `offset` で 600 件ずつ読み、`total` で仮想スクロールの行数を決める。
/// 65,000 件でも初回表示 300ms 以内に収まるよう、並び順の列には索引を張ってある。
///
/// #50: `after_id` を指定するとキーセット・ページングになる（`offset` は無視）。
/// 深いページでも先頭から読み飛ばさないため、件数によらず一定の時間で返る。
pub fn find_files(conn: &Connection, filter: &FileFilter) -> Result<FilePage> {
    match filter.kind.as_deref() {
        None | Some("") | Some("video") | Some("image") => {}
        Some(other) => return Err(IndexError::InvalidKind(other.to_string())),
    }
    let order = file_order_clause(&filter.sort, filter.dir.as_deref())?;

    let (where_sql, values) = file_filter_clause(filter);

    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM files f JOIN works w ON w.id = f.work_id WHERE {where_sql}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;

    let (sql, values) = file_page_query(conn, filter, &where_sql, &order, values)?;

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values.iter()), map_file)?;
    let files = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(FilePage { files, total })
}

/// 作品 1 件のヘッダ情報（ファイル一覧を含まない）。#5 の作品詳細で使う。
pub fn get_work_info(conn: &Connection, work_id: i64) -> Result<Option<WorkInfo>> {
    let sql = format!(
        "SELECT {} FROM works w LEFT JOIN files cf ON cf.id = w.cover_file_id WHERE w.id = ?1",
        work_select()
    );
    let mut stmt = conn.prepare(&sql)?;
    let work = stmt.query_row([work_id], map_work).optional()?;
    let Some(work) = work else {
        return Ok(None);
    };

    let (root_label, root_real_path): (String, String) = conn.query_row(
        "SELECT label, real_path FROM roots WHERE id = ?1",
        [work.root_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    Ok(Some(WorkInfo {
        work,
        root_label,
        root_real_path,
    }))
}

/// 作品 1 件とファイル一覧。
pub fn get_work(conn: &Connection, work_id: i64) -> Result<Option<WorkDetail>> {
    let Some(info) = get_work_info(conn, work_id)? else {
        return Ok(None);
    };

    let mut file_stmt = conn.prepare(
        "SELECT f.id, f.work_id, f.rel_path, f.name, f.kind, f.bytes, f.width, f.height,
            f.duration_ms, f.mtime, f.thumb_path, fp.position_ms
     FROM files f LEFT JOIN file_positions fp ON fp.file_id = f.id
     WHERE f.work_id = ?1 ORDER BY f.name COLLATE NOCASE",
    )?;
    let files = file_stmt
        .query_map([work_id], |row| {
            Ok(FileEntry {
                id: row.get(0)?,
                work_id: row.get(1)?,
                rel_path: row.get(2)?,
                name: row.get(3)?,
                kind: row.get(4)?,
                bytes: row.get(5)?,
                width: row.get(6)?,
                height: row.get(7)?,
                duration_ms: row.get(8)?,
                mtime: row.get(9)?,
                thumb_path: row.get(10)?,
                position_ms: row.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Some(WorkDetail {
        work: info.work,
        root_label: info.root_label,
        root_real_path: info.root_real_path,
        files,
    }))
}

/// ルートの実体パスと相対パスから絶対パスを組み立てる。
pub fn join_root(root_real_path: &str, rel_path: &str) -> PathBuf {
    Path::new(root_real_path).join(rel_path.replace('/', "\\"))
}

/// `files.id` から実ファイルの絶対パスを引く（#5 のメディア配信・エクスプローラ用）。
///
/// UI からはパスを渡さず ID だけを受け取るための入口。登録ルート外のパスは
/// 索引に存在しないので、ここで返るパスは走査済みのものだけになる。
pub fn file_absolute_path(conn: &Connection, file_id: i64) -> Result<Option<PathBuf>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT r.real_path, f.rel_path
             FROM files f
             JOIN works w ON w.id = f.work_id
             JOIN roots r ON r.id = w.root_id
             WHERE f.id = ?1",
            [file_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(root, rel)| join_root(&root, &rel)))
}

/// `files.id` から UI に渡すフルパス文字列を引く（#24）。
///
/// 解決方法は [`file_absolute_path`] と同じ（ルートの実パス + 相対パス）。
/// コピー用に `String` で返すだけで、UI 側ではパスを組み立てない。
pub fn file_absolute_path_text(conn: &Connection, file_id: i64) -> Result<Option<String>> {
    Ok(file_absolute_path(conn, file_id)?.map(|path| path.to_string_lossy().into_owned()))
}

/// `works.id` から作品フォルダの絶対パスを引く。
pub fn work_absolute_path(conn: &Connection, work_id: i64) -> Result<Option<PathBuf>> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT r.real_path, w.rel_path
             FROM works w JOIN roots r ON r.id = w.root_id
             WHERE w.id = ?1",
            [work_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(root, rel)| join_root(&root, &rel)))
}

// ---------------------------------------------------------------------------
// 削除（#15）
// ---------------------------------------------------------------------------

/// 削除対象 1 件のスナップショット。
///
/// 実ファイルを消す前に読む。削除成功後に `files` / `works` から行を消し、
/// Undo（ゴミ箱から復元）で同じ行を戻せるようにするための控え。
#[derive(Debug, Clone)]
pub struct FileSnapshot {
    pub id: i64,
    pub work_id: i64,
    pub root_id: i64,
    /// ルートの実体パス（`roots.real_path`）。パス検証とサムネイルキャッシュのキーに使う。
    pub root_real_path: String,
    pub work_rel_path: String,
    pub work_title: String,
    pub work_kind: String,
    pub rel_path: String,
    pub name: String,
    pub kind: String,
    pub bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub mtime: i64,
    pub volume_serial: Option<i64>,
    pub file_index: Option<i64>,
    pub thumb_path: Option<String>,
}

/// `remove_file_rows` の結果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RemovedRows {
    pub files: u64,
    pub works: u64,
}

fn placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// id の重複を落とす（UI の選択で同じ id が 2 回来ても 1 回だけ消す）。
pub fn unique_ids(ids: &[i64]) -> Vec<i64> {
    let mut seen = std::collections::HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

/// `files.id` の一覧から削除用のスナップショットを引く（入力順・不明 id は含めない）。
pub fn file_snapshots(conn: &Connection, ids: &[i64]) -> Result<Vec<FileSnapshot>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT f.id, f.work_id, w.root_id, r.real_path, w.rel_path, w.title, w.kind,
            f.rel_path, f.name, f.kind, f.bytes, f.width, f.height, f.duration_ms,
            f.mtime, f.volume_serial, f.file_index, f.thumb_path
     FROM files f
     JOIN works w ON w.id = f.work_id
     JOIN roots r ON r.id = w.root_id
     WHERE f.id IN ({})",
        placeholders(ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(ids.iter()), |row| {
        Ok(FileSnapshot {
            id: row.get(0)?,
            work_id: row.get(1)?,
            root_id: row.get(2)?,
            root_real_path: row.get(3)?,
            work_rel_path: row.get(4)?,
            work_title: row.get(5)?,
            work_kind: row.get(6)?,
            rel_path: row.get(7)?,
            name: row.get(8)?,
            kind: row.get(9)?,
            bytes: row.get(10)?,
            width: row.get(11)?,
            height: row.get(12)?,
            duration_ms: row.get(13)?,
            mtime: row.get(14)?,
            volume_serial: row.get(15)?,
            file_index: row.get(16)?,
            thumb_path: row.get(17)?,
        })
    })?;
    let by_id: std::collections::HashMap<i64, FileSnapshot> = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|snapshot| (snapshot.id, snapshot))
        .collect();
    Ok(ids.iter().filter_map(|id| by_id.get(id).cloned()).collect())
}

/// 作品 1 件に属する全ファイル id（UI は作品 id だけを渡す）。
pub fn work_file_ids(conn: &Connection, work_ids: &[i64]) -> Result<Vec<i64>> {
    if work_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id FROM files WHERE work_id IN ({}) ORDER BY work_id, name COLLATE NOCASE, id",
        placeholders(work_ids.len())
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(work_ids.iter()), |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---------------------------------------------------------------------------
// 移動（#57）
// ---------------------------------------------------------------------------

/// 作品フォルダの移動に必要な、移動元の情報。
///
/// UI からは `work_id` と移動先の `root_id` だけを受け取り、パスは必ずここから引く
/// （#15 の削除と同じ「任意パスを渡せない」方針）。
#[derive(Debug, Clone)]
pub struct WorkMoveSource {
    pub work_id: i64,
    pub root_id: i64,
    pub root_label: String,
    pub root_real_path: String,
    pub rel_path: String,
    pub title: String,
    pub file_count: i64,
    pub total_bytes: i64,
}

/// 移動元の作品 1 件を引く（見つからなければ `None`）。
pub fn work_move_source(conn: &Connection, work_id: i64) -> Result<Option<WorkMoveSource>> {
    Ok(conn
        .query_row(
            "SELECT w.id, w.root_id, r.label, r.real_path, w.rel_path, w.title,
                w.file_count, w.total_bytes
         FROM works w
         JOIN roots r ON r.id = w.root_id
         WHERE w.id = ?1",
            [work_id],
            |row| {
                Ok(WorkMoveSource {
                    work_id: row.get(0)?,
                    root_id: row.get(1)?,
                    root_label: row.get(2)?,
                    root_real_path: row.get(3)?,
                    rel_path: row.get(4)?,
                    title: row.get(5)?,
                    file_count: row.get(6)?,
                    total_bytes: row.get(7)?,
                })
            },
        )
        .optional()?)
}

/// 移動先ルートに同じ相対パスの作品が既にあるか（大文字小文字は無視）。
pub fn work_rel_exists(conn: &Connection, root_id: i64, rel_path: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM works WHERE root_id = ?1 AND rel_path = ?2 COLLATE NOCASE",
        params![root_id, rel_path],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 実ファイルの移動後に `works` / `files` の索引を移動先へ付け替える。
///
/// - `works.root_id` / `works.rel_path` / `works.title` を更新
/// - `files.rel_path` は移動前の作品パス接頭辞を落として、新しい接頭辞を付ける
///   （例: `旧作品\001.png` → `新作品\001.png`）
///
/// `rel_path` は Windows の区切り文字（`\`）で保存されているため、
/// 文字数で接頭辞を落とす（SQLite の `substr` は文字単位）。
pub fn apply_work_move(
    conn: &mut Connection,
    work_id: i64,
    target_root_id: i64,
    old_rel_path: &str,
    new_rel_path: &str,
    new_title: &str,
) -> Result<u64> {
    let transaction = conn.transaction()?;
    transaction.execute(
        "UPDATE works SET root_id = ?1, rel_path = ?2, title = ?3, updated_at = ?4
         WHERE id = ?5",
        params![target_root_id, new_rel_path, new_title, now_ms(), work_id],
    )?;

    let prefix_chars = old_rel_path.chars().count() as i64;
    let files = transaction.execute(
        "UPDATE files SET rel_path = ?1 || substr(rel_path, ?2)
         WHERE work_id = ?3",
        params![new_rel_path, prefix_chars + 1, work_id],
    )?;

    transaction.commit()?;
    Ok(files as u64)
}

/// 残ったファイルから作品の集計列を取り直す（#2 の走査と同じ計算）。
fn recompute_works(conn: &Connection, work_ids: &[i64]) -> Result<()> {
    if work_ids.is_empty() {
        return Ok(());
    }
    // ?1 = updated_at、?2.. = work id
    let ids = (0..work_ids.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let mut values = vec![Value::Integer(now_ms())];
    values.extend(work_ids.iter().map(|id| Value::Integer(*id)));

    conn.execute(
        &format!(
            "UPDATE works SET
           file_count = (SELECT COUNT(*) FROM files WHERE files.work_id = works.id),
           total_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM files WHERE files.work_id = works.id),
           mtime = (SELECT COALESCE(MAX(mtime), works.mtime) FROM files WHERE files.work_id = works.id),
           kind = CASE
             WHEN EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'image')
              AND EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'video') THEN 'mixed'
             WHEN EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id AND kind = 'video') THEN 'video'
             ELSE 'image'
           END,
           updated_at = ?1
         WHERE id IN ({ids})"
        ),
        params_from_iter(values.iter()),
    )?;

    refresh_covers(conn)?;
    Ok(())
}

/// 削除が成功したファイル行を消し、空になった作品も消す。
///
/// 残ったファイルがある作品は `file_count` / `total_bytes` / `mtime` / `kind` /
/// カバーを計算し直す。実ファイルの削除に成功した id だけを渡すこと。
pub fn remove_file_rows(conn: &mut Connection, ids: &[i64]) -> Result<RemovedRows> {
    let ids = unique_ids(ids);
    if ids.is_empty() {
        return Ok(RemovedRows::default());
    }
    let transaction = conn.transaction()?;
    let list = placeholders(ids.len());

    let work_ids: Vec<i64> = {
        let sql = format!("SELECT DISTINCT work_id FROM files WHERE id IN ({list})");
        let mut stmt = transaction.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(ids.iter()), |row| row.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let files = transaction.execute(
        &format!("DELETE FROM files WHERE id IN ({list})"),
        params_from_iter(ids.iter()),
    )? as u64;

    let mut works = 0u64;
    if !work_ids.is_empty() {
        let work_list = placeholders(work_ids.len());
        works = transaction.execute(
            &format!(
                "DELETE FROM works WHERE id IN ({work_list})
             AND NOT EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id)"
            ),
            params_from_iter(work_ids.iter()),
        )? as u64;
        recompute_works(&transaction, &work_ids)?;
    }

    transaction.commit()?;
    Ok(RemovedRows { files, works })
}

/// Undo 用: 削除前のスナップショットから `works` / `files` の行を戻す。
///
/// 実ファイルが既に戻っている前提。既存の行（同じ作品・相対パス）は触らない。
/// 返り値は挿入できたファイル行数。
pub fn restore_file_snapshots(conn: &mut Connection, snapshots: &[FileSnapshot]) -> Result<u64> {
    if snapshots.is_empty() {
        return Ok(0);
    }
    let transaction = conn.transaction()?;
    let mut work_ids: Vec<i64> = Vec::new();
    let mut inserted = 0u64;

    for snapshot in snapshots {
        transaction.execute(
            "INSERT INTO works(root_id, rel_path, title, kind, file_count, total_bytes, mtime, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?5, ?5)
             ON CONFLICT(root_id, rel_path) DO NOTHING",
            params![
                snapshot.root_id,
                snapshot.work_rel_path,
                snapshot.work_title,
                snapshot.work_kind,
                snapshot.mtime,
            ],
        )?;
        let work_id: i64 = transaction.query_row(
            "SELECT id FROM works WHERE root_id = ?1 AND rel_path = ?2",
            params![snapshot.root_id, snapshot.work_rel_path],
            |row| row.get(0),
        )?;
        if !work_ids.contains(&work_id) {
            work_ids.push(work_id);
        }

        inserted += transaction.execute(
            "INSERT INTO files(work_id, rel_path, name, kind, bytes, width, height, duration_ms,
                mtime, volume_serial, file_index, thumb_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(work_id, rel_path) DO NOTHING",
            params![
                work_id,
                snapshot.rel_path,
                snapshot.name,
                snapshot.kind,
                snapshot.bytes,
                snapshot.width,
                snapshot.height,
                snapshot.duration_ms,
                snapshot.mtime,
                snapshot.volume_serial,
                snapshot.file_index,
                // Undo 時はキャッシュを消しているので、次の生成で作り直す。
                Option::<String>::None,
            ],
        )? as u64;
    }

    recompute_works(&transaction, &work_ids)?;
    transaction.commit()?;
    Ok(inserted)
}

/// 動画の再生位置を保存する（#5）。`position_ms <= 0` なら削除して「最初から」に戻す。
pub fn save_file_position(
    conn: &Connection,
    file_id: i64,
    position_ms: i64,
    duration_ms: Option<i64>,
) -> Result<()> {
    if position_ms <= 0 {
        return clear_file_position(conn, file_id);
    }
    conn.execute(
        "INSERT INTO file_positions(file_id, position_ms, duration_ms, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(file_id) DO UPDATE SET
           position_ms = excluded.position_ms,
           duration_ms = excluded.duration_ms,
           updated_at = excluded.updated_at",
        params![file_id, position_ms, duration_ms, now_ms()],
    )?;
    Ok(())
}

/// 動画の再生位置を読む（#5）。未保存なら `None`。
pub fn get_file_position(conn: &Connection, file_id: i64) -> Result<Option<FilePosition>> {
    let position = conn
        .query_row(
            "SELECT file_id, position_ms, duration_ms, updated_at
             FROM file_positions WHERE file_id = ?1",
            [file_id],
            |row| {
                Ok(FilePosition {
                    file_id: row.get(0)?,
                    position_ms: row.get(1)?,
                    duration_ms: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(position)
}

/// 再生位置を消す（「最初から再生」）。
pub fn clear_file_position(conn: &Connection, file_id: i64) -> Result<()> {
    conn.execute("DELETE FROM file_positions WHERE file_id = ?1", [file_id])?;
    Ok(())
}

/// ライブラリ全体の集計（UI の「作品数・ファイル数・最終走査」）。
pub fn library_stats(conn: &Connection) -> Result<LibraryStats> {
    // #8: 無効化したルートは集計からも外す（ライブラリの見た目と一致させる）。
    let (roots, works, files, total_bytes) = conn.query_row(
        "SELECT
       (SELECT COUNT(*) FROM roots WHERE enabled = 1),
       (SELECT COUNT(*) FROM works w JOIN roots r ON r.id = w.root_id WHERE r.enabled = 1),
       (SELECT COUNT(*) FROM files f
          JOIN works w ON w.id = f.work_id
          JOIN roots r ON r.id = w.root_id
         WHERE r.enabled = 1),
       (SELECT COALESCE(SUM(f.bytes), 0) FROM files f
          JOIN works w ON w.id = f.work_id
          JOIN roots r ON r.id = w.root_id
         WHERE r.enabled = 1)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    let (last_scan_at, last_scan_status): (Option<i64>, Option<String>) = conn.query_row(
        "SELECT MAX(s.finished_at),
            (SELECT s2.status FROM scan_runs s2
               JOIN roots r ON r.id = s2.root_id
              WHERE r.enabled = 1
              ORDER BY s2.id DESC LIMIT 1)
     FROM scan_runs s
     JOIN roots r ON r.id = s.root_id
     WHERE r.enabled = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    Ok(LibraryStats {
        roots,
        works,
        files,
        total_bytes,
        last_scan_at,
        last_scan_status,
    })
}

/// 作品をまたいだファイル名検索（FTS5）。#4 以降の検索画面で使う。
pub fn search_files(conn: &Connection, query: &str, limit: i64) -> Result<Vec<FileEntry>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.work_id, f.rel_path, f.name, f.kind, f.bytes,
            f.width, f.height, f.duration_ms, f.mtime, f.thumb_path, fp.position_ms
     FROM files_fts
     JOIN files f ON f.id = files_fts.rowid
     JOIN works w ON w.id = f.work_id
     JOIN roots r ON r.id = w.root_id
     LEFT JOIN file_positions fp ON fp.file_id = f.id
     WHERE files_fts MATCH ?1 AND r.enabled = 1
     ORDER BY rank LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![query, limit.max(0)], |row| {
        Ok(FileEntry {
            id: row.get(0)?,
            work_id: row.get(1)?,
            rel_path: row.get(2)?,
            name: row.get(3)?,
            kind: row.get(4)?,
            bytes: row.get(5)?,
            width: row.get(6)?,
            height: row.get(7)?,
            duration_ms: row.get(8)?,
            mtime: row.get(9)?,
            thumb_path: row.get(10)?,
            position_ms: row.get(11)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---------------------------------------------------------------------------
// 生成メタデータ（#60）
// ---------------------------------------------------------------------------

/// 抽出済みの生成情報をキャッシュし、FTS を入れ替える。
///
/// `meta` が `None` のときは空文字を保存する（「抽出したが無かった」）。
/// これで毎回の索引で同じファイルを読み直さない。
pub fn save_file_meta(
    conn: &Connection,
    file_id: i64,
    mtime: i64,
    meta: Option<&crate::meta::GenerationMeta>,
) -> Result<()> {
    let json = meta
        .and_then(|meta| serde_json::to_string(meta).ok())
        .unwrap_or_default();
    conn.execute(
        "UPDATE files SET meta_json = ?2, meta_mtime = ?3 WHERE id = ?1",
        params![file_id, json, mtime],
    )?;
    conn.execute("DELETE FROM files_meta_fts WHERE file_id = ?1", [file_id])?;
    if let Some(meta) = meta {
        conn.execute(
            "INSERT INTO files_meta_fts(file_id, prompt, negative_prompt, model, loras)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                file_id,
                meta.prompt.as_deref().unwrap_or(""),
                meta.negative_prompt.as_deref().unwrap_or(""),
                meta.model.as_deref().unwrap_or(""),
                meta.loras.join("\n"),
            ],
        )?;
    }
    Ok(())
}

/// キャッシュ済みの生成情報（`meta_json` / `meta_mtime` / 現在の `mtime`）。
pub type CachedFileMeta = (Option<String>, Option<i64>, i64);

/// キャッシュ済みの生成情報。
pub fn cached_file_meta(conn: &Connection, file_id: i64) -> Result<Option<CachedFileMeta>> {
    Ok(conn
        .query_row(
            "SELECT meta_json, meta_mtime, mtime FROM files WHERE id = ?1",
            [file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?)
}

/// まだ抽出していない（またはファイルが更新された）ファイルを返す。
///
/// #60 の遅延抽出。`limit` 件ずつ読み、`index_meta` が実ファイルから読む。
pub fn pending_meta_files(conn: &Connection, limit: i64) -> Result<Vec<PendingMetaFile>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, r.real_path, f.rel_path, f.mtime
           FROM files f
           JOIN works w ON w.id = f.work_id
           JOIN roots r ON r.id = w.root_id
          WHERE r.enabled = 1
            AND (f.meta_mtime IS NULL OR f.meta_mtime <> f.mtime)
          ORDER BY f.id
          LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit.max(0)], |row| {
        let real_path: String = row.get(1)?;
        let rel_path: String = row.get(2)?;
        Ok(PendingMetaFile {
            file_id: row.get(0)?,
            path: join_root(&real_path, &rel_path),
            mtime: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// まだ抽出していないファイルの件数。
pub fn pending_meta_count(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM files f
           JOIN works w ON w.id = f.work_id
           JOIN roots r ON r.id = w.root_id
          WHERE r.enabled = 1
            AND (f.meta_mtime IS NULL OR f.meta_mtime <> f.mtime)",
        [],
        |row| row.get(0),
    )?)
}

fn map_meta_hit(row: &Row<'_>) -> rusqlite::Result<FileMetaHit> {
    Ok(FileMetaHit {
        file_id: row.get(0)?,
        work_id: row.get(1)?,
        work_title: row.get(2)?,
        name: row.get(3)?,
        rel_path: row.get(4)?,
        kind: row.get(5)?,
        snippet: row.get(6)?,
    })
}

/// 生成メタデータを検索する（#60）。
///
/// FTS5 を先に引き、ヒットが無ければ生 JSON への `LIKE` に落とす。
/// どちらも無効化ルートは除外する。壊れた JSON は `LIKE` の対象になるだけで、
/// JSON としてパースしないため落ちない。
pub fn search_meta(conn: &Connection, query: &str, limit: i64) -> Result<Vec<FileMetaHit>> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(0, 1000);

    if let Some(match_query) = fts_match_query(trimmed) {
        let mut stmt = conn.prepare(
            "SELECT f.id, f.work_id, w.title, f.name, f.rel_path, f.kind,
                snippet(files_meta_fts, -1, '[', ']', '…', 16) AS snip
           FROM files_meta_fts
           JOIN files f ON f.id = files_meta_fts.file_id
           JOIN works w ON w.id = f.work_id
           JOIN roots r ON r.id = w.root_id
          WHERE files_meta_fts MATCH ?1 AND r.enabled = 1
          ORDER BY rank, f.id
          LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![match_query, limit], map_meta_hit)?;
        let hits = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if !hits.is_empty() {
            return Ok(hits);
        }
    }

    let Some(pattern) = search_pattern(Some(trimmed)) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT f.id, f.work_id, w.title, f.name, f.rel_path, f.kind,
            substr(f.meta_json, 1, 160) AS snip
       FROM files f
       JOIN works w ON w.id = f.work_id
       JOIN roots r ON r.id = w.root_id
      WHERE r.enabled = 1
        AND f.meta_json IS NOT NULL AND f.meta_json <> ''
        AND f.meta_json LIKE ?1 ESCAPE '\\'
      ORDER BY f.mtime DESC, f.id DESC
      LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pattern, limit], map_meta_hit)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 生成メタデータの付与率（#60）。`meta_report` の実体。
pub fn meta_report(conn: &Connection) -> Result<MetaReport> {
    let (total, with_meta): (i64, i64) = conn.query_row(
        "SELECT COUNT(*),
            COALESCE(SUM(CASE WHEN f.meta_json IS NOT NULL AND f.meta_json <> '' THEN 1 ELSE 0 END), 0)
       FROM files f
       JOIN works w ON w.id = f.work_id
       JOIN roots r ON r.id = w.root_id
      WHERE r.enabled = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let mut stmt = conn.prepare(
        "SELECT r.id, r.label, COUNT(f.id),
            COALESCE(SUM(CASE WHEN f.meta_json IS NOT NULL AND f.meta_json <> '' THEN 1 ELSE 0 END), 0)
       FROM roots r
       LEFT JOIN works w ON w.root_id = r.id
       LEFT JOIN files f ON f.work_id = w.id
      WHERE r.enabled = 1
      GROUP BY r.id
      ORDER BY r.label COLLATE NOCASE, r.id",
    )?;
    let by_root = stmt
        .query_map([], |row| {
            Ok(MetaRootReport {
                root_id: row.get(0)?,
                label: row.get(1)?,
                total: row.get(2)?,
                with_meta: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(MetaReport {
        total,
        with_meta,
        without_meta: total - with_meta,
        by_root,
    })
}

/// 作品カバーを「最初の動画 → 最初の画像 → 先頭ファイル」の順で選び直す。///
/// 走査後（`scan.rs`）とマイグレーションで使う。動画があればその 1 フレームが
/// グリッドの見た目として一番わかりやすい、という判断（Issue #3）。
pub fn refresh_covers(conn: &Connection) -> Result<u64> {
    conn.execute(
        "UPDATE works SET cover_file_id = COALESCE(
       (SELECT id FROM files WHERE files.work_id = works.id AND kind = 'video'
        ORDER BY name COLLATE NOCASE LIMIT 1),
       (SELECT id FROM files WHERE files.work_id = works.id AND kind = 'image'
        ORDER BY name COLLATE NOCASE LIMIT 1),
       (SELECT id FROM files WHERE files.work_id = works.id
        ORDER BY name COLLATE NOCASE LIMIT 1)
     )
     WHERE EXISTS (SELECT 1 FROM files WHERE files.work_id = works.id)",
        [],
    )?;
    Ok(conn.changes())
}

// ---------------------------------------------------------------------------
// tags / marks（#6）
// ---------------------------------------------------------------------------

fn map_tag(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        created_at: row.get(3)?,
        works: row.get(4)?,
    })
}

/// `#rrggbb` / `#rgb` 以外は既定色に丸める。空文字は既定色。
pub fn normalize_tag_color(color: Option<&str>) -> String {
    let raw = color.unwrap_or("").trim().to_ascii_lowercase();
    let hex = raw.strip_prefix('#').unwrap_or(&raw);
    let valid = matches!(hex.len(), 3 | 6) && hex.chars().all(|ch| ch.is_ascii_hexdigit());
    if !valid {
        return "#22d3ee".to_string();
    }
    if hex.len() == 3 {
        let expanded: String = hex.chars().flat_map(|ch| [ch, ch]).collect();
        return format!("#{expanded}");
    }
    format!("#{hex}")
}

fn work_exists(conn: &Connection, work_id: i64) -> Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM works WHERE id = ?1",
        [work_id],
        |row| row.get(0),
    )?;
    if found == 0 {
        return Err(IndexError::WorkNotFound(work_id));
    }
    Ok(())
}

fn get_tag(conn: &Connection, tag_id: i64) -> Result<Tag> {
    conn.query_row(
        "SELECT t.id, t.name, t.color, t.created_at,
           (SELECT COUNT(*) FROM work_tags wt WHERE wt.tag_id = t.id)
         FROM tags t WHERE t.id = ?1",
        [tag_id],
        map_tag,
    )
    .optional()?
    .ok_or(IndexError::TagNotFound(tag_id))
}

/// タグの一覧（名前順・作品数付き）。
pub fn list_tags(conn: &Connection) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.created_at,
           (SELECT COUNT(*) FROM work_tags wt WHERE wt.tag_id = t.id)
         FROM tags t ORDER BY t.name COLLATE NOCASE, t.id",
    )?;
    let rows = stmt.query_map([], map_tag)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// タグを作る。同じ名前（大文字小文字を無視）があれば色だけ更新して既存を返す。
pub fn create_tag(conn: &Connection, name: &str, color: Option<&str>) -> Result<Tag> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IndexError::InvalidTag(
            "タグ名を入力してください".to_string(),
        ));
    }
    if name.chars().count() > 40 {
        return Err(IndexError::InvalidTag(
            "タグ名は 40 文字までです".to_string(),
        ));
    }
    let color = normalize_tag_color(color);
    conn.execute(
        "INSERT INTO tags(name, color, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET color = excluded.color",
        params![name, color, now_ms()],
    )?;
    let tag_id: i64 = conn.query_row("SELECT id FROM tags WHERE name = ?1", [name], |row| {
        row.get(0)
    })?;
    get_tag(conn, tag_id)
}

/// タグを消す（付与も `ON DELETE CASCADE` で消える）。
pub fn delete_tag(conn: &Connection, tag_id: i64) -> Result<()> {
    let changed = conn.execute("DELETE FROM tags WHERE id = ?1", [tag_id])?;
    if changed == 0 {
        return Err(IndexError::TagNotFound(tag_id));
    }
    Ok(())
}

/// 作品に付いているタグ（名前順）。
pub fn get_work_tags(conn: &Connection, work_id: i64) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name, t.color, t.created_at,
           (SELECT COUNT(*) FROM work_tags wt2 WHERE wt2.tag_id = t.id)
         FROM tags t JOIN work_tags wt ON wt.tag_id = t.id
         WHERE wt.work_id = ?1 ORDER BY t.name COLLATE NOCASE, t.id",
    )?;
    let rows = stmt.query_map([work_id], map_tag)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 生成情報の頻出語からタグ候補を返す（#79）。
///
/// `files.meta_json`（#60 のキャッシュ）だけを読み、実ファイルは開かない。
/// 1 リクエストでこの作品の全ファイルを集計するので、UI から全作品を走査しない。
///
/// - 既にこの作品に付いているタグ（候補と同じ正規化で比較）は候補から外す
/// - 生成情報が無い作品は空配列
pub fn tag_suggestions(
    conn: &Connection,
    work_id: i64,
    limit: i64,
) -> Result<Vec<crate::tagsuggest::TagSuggestion>> {
    work_exists(conn, work_id)?;

    let mut stmt = conn.prepare(
        "SELECT meta_json FROM files
          WHERE work_id = ?1 AND meta_json IS NOT NULL AND meta_json <> ''
          ORDER BY id",
    )?;
    let rows = stmt.query_map([work_id], |row| row.get::<_, String>(0))?;
    // 壊れたキャッシュ（古い形式など）は読み飛ばす
    let metas: Vec<crate::meta::GenerationMeta> = rows
        .filter_map(|row| row.ok())
        .filter_map(|json| serde_json::from_str(&json).ok())
        .collect();

    let existing: std::collections::HashSet<String> = get_work_tags(conn, work_id)?
        .into_iter()
        .map(|tag| crate::tagsuggest::tag_key(&tag.name))
        .collect();
    let counts = crate::tagsuggest::count_terms(metas.iter());
    Ok(crate::tagsuggest::rank(
        &counts,
        &existing,
        limit.clamp(1, 50) as usize,
    ))
}

/// 作品のタグを丸ごと差し替える。存在しないタグ ID は無視する。
pub fn set_work_tags(conn: &Connection, work_id: i64, tag_ids: &[i64]) -> Result<Vec<Tag>> {
    work_exists(conn, work_id)?;
    let transaction = conn.unchecked_transaction()?;
    transaction.execute("DELETE FROM work_tags WHERE work_id = ?1", [work_id])?;
    let now = now_ms();
    let mut unique = Vec::new();
    for tag_id in tag_ids {
        if !unique.contains(tag_id) {
            unique.push(*tag_id);
        }
    }
    for tag_id in unique {
        transaction.execute(
            "INSERT INTO work_tags(work_id, tag_id, created_at)
             SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM tags WHERE id = ?2)",
            params![work_id, tag_id, now],
        )?;
    }
    transaction.commit()?;
    get_work_tags(conn, work_id)
}

fn map_mark(row: &Row<'_>) -> rusqlite::Result<WorkMark> {
    Ok(WorkMark {
        work_id: row.get(0)?,
        favorite: row.get::<_, i64>(1)? != 0,
        rating: row.get(2)?,
        note: row.get(3)?,
        last_opened_at: row.get(4)?,
        open_count: row.get(5)?,
    })
}

fn read_mark(conn: &Connection, work_id: i64) -> Result<Option<WorkMark>> {
    let mark = conn
        .query_row(
            "SELECT work_id, favorite, rating, note, last_opened_at, open_count
             FROM marks WHERE work_id = ?1",
            [work_id],
            map_mark,
        )
        .optional()?;
    Ok(mark)
}

/// 作品の評価・お気に入り・メモ。未設定なら既定値（全 false / 未評価 / 0 回）を返す。
pub fn get_work_mark(conn: &Connection, work_id: i64) -> Result<WorkMark> {
    work_exists(conn, work_id)?;
    Ok(read_mark(conn, work_id)?.unwrap_or_else(|| WorkMark::empty(work_id)))
}

/// お気に入り・評価・メモを保存する。開封回数と最終閲覧は保持する。
pub fn set_work_mark(
    conn: &Connection,
    work_id: i64,
    favorite: bool,
    rating: Option<i64>,
    note: Option<String>,
) -> Result<WorkMark> {
    work_exists(conn, work_id)?;
    if let Some(value) = rating {
        if !(1..=5).contains(&value) {
            return Err(IndexError::InvalidRating(value));
        }
    }
    let note = note.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    conn.execute(
        "INSERT INTO marks(work_id, favorite, rating, note, last_opened_at, open_count)
         VALUES (?1, ?2, ?3, ?4, NULL, 0)
         ON CONFLICT(work_id) DO UPDATE SET
           favorite = excluded.favorite,
           rating = excluded.rating,
           note = excluded.note",
        params![work_id, if favorite { 1_i64 } else { 0_i64 }, rating, note],
    )?;
    get_work_mark(conn, work_id)
}

/// 作品詳細を開いたことを記録する（`open_count += 1` / `last_opened_at` 更新）。
///
/// OS はファイルの開封回数を残さないため、アプリ側で数える。
pub fn record_open(conn: &Connection, work_id: i64) -> Result<WorkMark> {
    work_exists(conn, work_id)?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO marks(work_id, favorite, rating, note, last_opened_at, open_count)
         VALUES (?1, 0, NULL, NULL, ?2, 1)
         ON CONFLICT(work_id) DO UPDATE SET
           last_opened_at = excluded.last_opened_at,
           open_count = marks.open_count + 1",
        params![work_id, now],
    )?;
    Ok(read_mark(conn, work_id)?.unwrap_or_else(|| WorkMark::empty(work_id)))
}

// ---------------------------------------------------------------------------
// スマートフォルダ（保存検索、#69）
// ---------------------------------------------------------------------------

fn map_smart_folder(row: &Row<'_>) -> rusqlite::Result<SmartFolder> {
    Ok(SmartFolder {
        id: row.get(0)?,
        name: row.get(1)?,
        query_json: row.get(2)?,
        sort_order: row.get(3)?,
        created_at: row.get(4)?,
    })
}

fn get_smart_folder(conn: &Connection, id: i64) -> Result<SmartFolder> {
    conn.query_row(
        "SELECT id, name, query_json, sort_order, created_at
         FROM smart_folders WHERE id = ?1",
        [id],
        map_smart_folder,
    )
    .optional()?
    .ok_or(IndexError::SmartFolderNotFound(id))
}

fn normalize_smart_folder_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(IndexError::InvalidSmartFolder(
            "名前を入力してください".to_string(),
        ));
    }
    if name.chars().count() > SMART_FOLDER_NAME_MAX {
        return Err(IndexError::InvalidSmartFolder(format!(
            "名前は {SMART_FOLDER_NAME_MAX} 文字までです"
        )));
    }
    Ok(name.to_string())
}

/// 条件 JSON を検証する（オブジェクト以外は受け付けない）。
///
/// 列を増やさずに条件を足せるよう、中身のキーは UI に任せる。壊れた JSON を
/// 保存すると一覧の適用で毎回失敗するため、ここで弾いておく。並び順を保つため
/// 中身は詰め直さず、検証だけして元の文字列を保存する。
fn normalize_smart_folder_query(query_json: &str) -> Result<String> {
    let value: serde_json::Value = serde_json::from_str(query_json)
        .map_err(|_| IndexError::InvalidSmartFolder("条件の JSON を読み取れません".to_string()))?;
    if !value.is_object() {
        return Err(IndexError::InvalidSmartFolder(
            "条件は JSON オブジェクトで指定してください".to_string(),
        ));
    }
    Ok(query_json.trim().to_string())
}

/// 保存したスマートフォルダの一覧（並び順 → id 順）。
pub fn list_smart_folders(conn: &Connection) -> Result<Vec<SmartFolder>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, query_json, sort_order, created_at
         FROM smart_folders ORDER BY sort_order, id",
    )?;
    let rows = stmt.query_map([], map_smart_folder)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 名前付きで条件を保存する。同じ名前（大文字小文字を無視）があれば条件だけ更新する。
///
/// 新規は末尾（`MAX(sort_order) + 1`）に置き、既存の並び順と作成日時は保つ。
pub fn save_smart_folder(conn: &Connection, name: &str, query_json: &str) -> Result<SmartFolder> {
    let name = normalize_smart_folder_name(name)?;
    let query_json = normalize_smart_folder_query(query_json)?;

    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM smart_folders WHERE name = ?1",
            [&name],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        conn.execute(
            "UPDATE smart_folders SET query_json = ?1 WHERE id = ?2",
            params![query_json, id],
        )?;
        return get_smart_folder(conn, id);
    }

    let sort_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM smart_folders",
        [],
        |row| row.get(0),
    )?;
    conn.execute(
        "INSERT INTO smart_folders(name, query_json, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![name, query_json, sort_order, now_ms()],
    )?;
    get_smart_folder(conn, conn.last_insert_rowid())
}

/// 名前を変える。他のスマートフォルダと同じ名前にはできない。
pub fn rename_smart_folder(conn: &Connection, id: i64, name: &str) -> Result<SmartFolder> {
    let name = normalize_smart_folder_name(name)?;
    get_smart_folder(conn, id)?;
    let conflict: Option<i64> = conn
        .query_row(
            "SELECT id FROM smart_folders WHERE name = ?1 AND id <> ?2",
            params![name, id],
            |row| row.get(0),
        )
        .optional()?;
    if conflict.is_some() {
        return Err(IndexError::InvalidSmartFolder(format!(
            "「{name}」は既にあります"
        )));
    }
    conn.execute(
        "UPDATE smart_folders SET name = ?1 WHERE id = ?2",
        params![name, id],
    )?;
    get_smart_folder(conn, id)
}

/// スマートフォルダを消す（保存した条件だけ。作品には触れない）。
pub fn delete_smart_folder(conn: &Connection, id: i64) -> Result<()> {
    let changed = conn.execute("DELETE FROM smart_folders WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(IndexError::SmartFolderNotFound(id));
    }
    Ok(())
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    /// バージョン 1 の DB を開くと、サムネイル列が足されてカバーが動画優先になる（#3）。
    #[test]
    fn v1_database_is_migrated_to_v2() {
        let conn = Connection::open_in_memory().unwrap();
        configure(&conn).unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        conn.execute("INSERT INTO meta(key, value) VALUES ('version', '1')", [])
            .unwrap();

        conn.execute_batch(
            "INSERT INTO roots(path, real_path, label, depth, enabled, created_at)
       VALUES ('r', 'r', 'r', 1, 1, 0);
       INSERT INTO works(root_id, rel_path, title, kind, cover_file_id, file_count, total_bytes, mtime, created_at, updated_at)
       VALUES (1, 'w', 'w', 'mixed', NULL, 2, 0, 0, 0, 0);
       INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime)
       VALUES (1, 'w/a.png', 'a.png', 'image', 1, 0);
       INSERT INTO files(work_id, rel_path, name, kind, bytes, mtime)
       VALUES (1, 'w/b.mp4', 'b.mp4', 'video', 1, 0);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);

        let mut stmt = conn.prepare("PRAGMA table_info(files)").unwrap();
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "thumb_mtime"));
        assert!(columns.iter().any(|column| column == "thumb_bytes"));

        // #21 のファイルモード用索引（スキーマ v3）
        let index_names: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        for expected in [
            "idx_files_mtime",
            "idx_files_name",
            "idx_files_bytes",
            "idx_files_duration",
        ] {
            assert!(
                index_names.iter().any(|name| name == expected),
                "{expected} がありません: {index_names:?}"
            );
        }

        // #5 の再生位置テーブル（スキーマ v4）
        let positions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'file_positions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(positions, 1, "file_positions が作られていません");

        let cover: String = conn
            .query_row(
                "SELECT f.name FROM works w JOIN files f ON f.id = w.cover_file_id",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cover, "b.mp4", "video should be the cover after migration");

        // #6 のタグ・評価・開封回数（スキーマ v5）
        for table in ["tags", "work_tags", "marks"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{table} が作られていません");
        }
        for index in [
            "idx_work_tags_tag",
            "idx_marks_favorite",
            "idx_marks_last_opened",
            "idx_marks_open_count",
            // #43: roots.enabled の絞り込みを索引で引く（スキーマ v6）
            "idx_roots_enabled",
            // #69: スマートフォルダの並び順（スキーマ v10）
            "idx_smart_folders_sort",
        ] {
            assert!(
                index_names.iter().any(|name| name == index),
                "{index} がありません: {index_names:?}"
            );
        }

        // #69: スマートフォルダ（スキーマ v10）
        let smart: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'smart_folders'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(smart, 1, "smart_folders が作られていません");
    }
}
