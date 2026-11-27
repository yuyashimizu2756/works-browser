# 走査・索引の設計（#2 実装用）

Issue #2 の実装者が迷わないように、決め事を先に固定しておく。

## 1. 対応拡張子

```rust
// 画像
const IMAGE_EXT: &[&str] = &["jpg","jpeg","png","webp","gif","bmp","avif"];
// 動画
const VIDEO_EXT: &[&str] = &["mp4","mkv","mov","avi","webm","m4v","wmv","flv"];
// `.ts` は既定で索引しない（TypeScript と衝突するため）。設定 `index_mpeg_ts` が
// true のときだけ MPEG-TS として動画に含める（#39）。
```

上記以外は索引に載せない（サイドカーや字幕は後回し）。

## 2. 走査

- `jwalk::WalkDir` を `follow_links(false)` で使い、ディレクトリ単位で並列に列挙する
  （ジャンクション無限ループ防止。監視の再走査は件数が少ないので `walkdir` のまま）
- 除外: `.` 始まりのディレクトリ、`node_modules`、`__pycache__`、設定の glob
- 書き込みは 10,000 件を 1 トランザクションにまとめる（#50）
- 深さ: ルート設定 `depth` に従い、`rel_path` の先頭 `depth` 要素を作品キーにする
  - `depth = 1`: `作品名/ファイル`
  - `depth = 2`: `作品名/サブ/ファイル`
  - `depth = 0`: ルート直下のファイルを 1 作品として扱う（フラット）
- 作品キーは小文字化せず**そのまま**保存（表示はそのまま、検索時のみ `COLLATE NOCASE`）

## 3. 重複パスの判定

Windows は `std::os::windows::fs::MetadataExt` から取れる：

```rust
let m = fs::metadata(path)?;
let volume = m.volume_serial_number(); // Option<u32>
let index  = m.file_index();           // Option<u64>
```

`(volume, index)` が一致するファイルは同一実体。
`D:\ComfyUI\output` と `D:\Projects\Blender\04_comfy_output` のような「同じ実体を別パスから見ている」ケースを検出し、**先に登録されたルート側だけ**を索引する（後から追加したルートは `duplicate_of` を記録してスキップ）。

## 4. スキーマ（初期マイグレーション）

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE roots (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,   -- 表示・設定用
  real_path    TEXT NOT NULL,          -- 正規化後
  label        TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  duplicate_of INTEGER REFERENCES roots(id),
  created_at   INTEGER NOT NULL
);

CREATE TABLE works (
  id         INTEGER PRIMARY KEY,
  root_id    INTEGER NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- 'video' | 'image' | 'mixed'
  cover_file_id INTEGER,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (root_id, rel_path)
);

CREATE TABLE files (
  id         INTEGER PRIMARY KEY,
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- 'video' | 'image'
  bytes      INTEGER NOT NULL,
  width      INTEGER, height INTEGER,
  duration_ms INTEGER,
  mtime      INTEGER NOT NULL,
  volume_serial INTEGER, file_index INTEGER,
  thumb_path TEXT,
  phash      TEXT,
  UNIQUE (work_id, rel_path)
);

CREATE INDEX idx_files_work   ON files(work_id, name);
CREATE INDEX idx_files_ident  ON files(volume_serial, file_index);
CREATE INDEX idx_works_mtime  ON works(mtime DESC);
CREATE INDEX idx_works_title  ON works(title COLLATE NOCASE);

CREATE VIRTUAL TABLE files_fts USING fts5(name, content='files', content_rowid='id');
```

FTS5 は SQLite バンドル版に含まれる（`rusqlite` の `bundled` feature で有効）。

### 再生位置（#5 / スキーマ v4）

作品詳細の動画プレイヤーは、ファイル単位で再生位置を残す（「続きから再生」）。

```sql
CREATE TABLE file_positions (
  file_id     INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER,
  updated_at  INTEGER NOT NULL
);
```

`position_ms` が 1,000ms 未満 / 終端 2 秒前以降の保存は「最初から」として行を消す。
ファイルが索引から消えると `ON DELETE CASCADE` で一緒に消える。

### タグ・評価・開封回数（#6 / スキーマ v5）

作品を分類し、よく見るものを上に出すためのテーブル。走査は `works` を upsert するだけで
行を作り直さないため、タグ・評価・開封回数は再走査後も残る。

```sql
CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color      TEXT NOT NULL DEFAULT '#22d3ee',   -- #rrggbb（小文字）
  created_at INTEGER NOT NULL
);

CREATE TABLE work_tags (
  work_id    INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (work_id, tag_id)
);

CREATE TABLE marks (
  work_id        INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  favorite       INTEGER NOT NULL DEFAULT 0,
  rating         INTEGER,             -- 1〜5（未評価は NULL）
  note           TEXT,
  last_opened_at INTEGER,             -- 作品詳細を開いた最終時刻（ms）
  open_count     INTEGER NOT NULL DEFAULT 0
);
```

- `find_works` / `list_works` は `tag_id`（`work_tags` の EXISTS）/ `favorite` /
  `min_rating` で絞り込める。並び順に `last_opened` / `open_count` を追加した
  （未開封は末尾）
- `record_open(work_id)` が `open_count += 1` と `last_opened_at` を更新する。
  OS は開封回数を残さないためアプリ側で数える
- タグ名の一意制約は `COLLATE NOCASE`。同じ名前の作成は色の更新として扱う

### ルート絞り込みの索引（#43 / スキーマ v6）

`find_files` / `find_works` は `w.root_id IN (SELECT id FROM roots WHERE enabled = 1)` で
無効化したルートを除外する。索引が無いと SQLite が `roots` を `SCAN` するため、
`enabled` に索引を張る（`roots` は数行なので実害は小さいが、クエリプランを `SCAN` 無しに保つ）。

```sql
CREATE INDEX idx_roots_enabled ON roots(enabled);
```

`src/index/file_tests.rs` の `find_files_query_plan_uses_indexes_and_never_scans_tables` が
`EXPLAIN QUERY PLAN` に `SCAN` が出ないことを確認する。

### 重複・類似のハッシュ（#67 / スキーマ v9）

`files` に解析結果をキャッシュする列を追加する（v1 の未使用 `phash TEXT` は触らない）。

- `content_hash` … 内容の SHA-1。バイト単位で同じファイル（完全一致）の判定に使う
- `dhash` … 9x8 グレースケールの隣接差分 64bit。見た目が近い画像（類似）の判定に使う
- `hash_mtime` / `hash_bytes` … 計算時点の `files.mtime` / `files.bytes`。
  値が変わったときだけ再計算する（`thumb_mtime` と同じ考え方）

```sql
ALTER TABLE files ADD COLUMN content_hash TEXT;
ALTER TABLE files ADD COLUMN dhash INTEGER;
ALTER TABLE files ADD COLUMN hash_mtime INTEGER;
ALTER TABLE files ADD COLUMN hash_bytes INTEGER;
CREATE INDEX idx_files_content_hash ON files(content_hash);
CREATE INDEX idx_files_hash_mtime ON files(hash_mtime);
```

類似のクラスタリングは「グループの代表との距離」だけで判定する（union-find の連鎖で
無関係な画像が混ざらないようにするため）。代表の選択は画素数 → バイト数 → 新しい順で、
近傍探索は BK-tree（ハミング距離）を使う。動画は `content_hash` のみ。

### スマートフォルダ（#69 / スキーマ v10）

いまの絞り込み条件を名前付きで保存する。条件は列に展開せず JSON 文字列で持つ
（項目が増えてもスキーマ変更が要らない。壊れた JSON は保存時に拒否する）。

```sql
CREATE TABLE smart_folders (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  query_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_smart_folders_sort ON smart_folders(sort_order, id);
```

- 同名（大文字小文字を無視）の保存は条件だけを更新し、並び順と作成日時は保つ
- 件数は保存しない。表示するときは既存の `find_works` / `find_files` の `total` を使う

## 5. 書き込み手順

1. `roots` を upsert
2. 走査は別スレッド（`std::thread` or `tauri::async_runtime::spawn_blocking`）で実施
3. 1,000 ファイルごとに 1 トランザクションで `files` を `INSERT ... ON CONFLICT DO UPDATE`
4. 作品ごとの集計（`file_count`, `total_bytes`, `mtime`, カバー）は**走査後に SQL 1 本**で再計算
5. 差分: 既存の `(volume_serial, file_index)` / `(work_id, rel_path)` と突き合わせ
   - 既存にない → 追加
   - mtime/size が違う → 更新
   - 走査で見つからない → 削除（`files` から DELETE、作品が空なら作品も削除）
6. `scan_runs` に結果を記録（started/finished/added/removed、ミリ秒）

## 6. 進捗イベント

```rust
#[derive(Serialize, Clone)]
struct ScanProgress { root_id: i64, phase: String, files: u64, works: u64 }

app.emit("scan://progress", ScanProgress { .. })?;   // 200ms 間隔で間引き
app.emit("scan://done", ScanSummary { .. })?;
```

UI は `scan://progress` を購読して進捗バーを出す（#4 で実装）。

## 7. キャンセル

`Arc<AtomicBool>` をコマンド引数で受け取り、1,000 ファイルごとに確認。
キャンセル時は**書き込み済みのトランザクションまでは確定**させ、`scan_runs` に `cancelled` を残す。

## 8. 性能目標（#10 で検証）

| 項目 | 目標 |
|---|---|
| 初回 65,000 ファイル | 90 秒以内 |
| 再走査（差分のみ） | 3 秒以内 |
| メモリ | 走査中 +100MB 以内 |

## 9. テスト

- 一時ディレクトリに 100 ファイルの擬似ツリーを作り、深さ 1/2/0 の作品分割を検証
- 同じファイルへの 2 ルート（コピーではなく同一実体）で重複判定を検証
- 削除 → 再走査で `works` が空になれば作品も消えることを検証

## 10. 実装メモ（#2）

実装は `src-tauri/src/index/db.rs`（DB）と `src-tauri/src/index/scan.rs`（走査）に置いた。
設計から決めた差分・補足は次のとおり。

### 10.1 スキーマ

- `meta.version` は `1`。空 DB なら 4 章のスキーマを作成し、`meta` に `version=1` を書く。
  `meta.version` がアプリの対応版より新しい DB は開かない。
- `scan_runs` は「開始・終了（ms）、added / updated / removed / duplicates / files / works /
  total_bytes、status（`running` / `done` / `cancelled` / `duplicate` / `failed`）」を持つ。
- `files_fts` は外部コンテンツ FTS5 のため、`files` の INSERT / DELETE / `name` の UPDATE で
  同期するトリガを 4 章のスキーマに追加した。
- `files` の削除検出は全ファイルをメモリに持たず、走査中に一時テーブル `scan_seen(file_id)` へ
  id を積み、走査後に「`scan_seen` に無いファイル」を DELETE する（チャンク書き込みと両立）。
- バージョン 2（#3）で `files` に `thumb_mtime` / `thumb_bytes` を追加し、作品カバーを
  「最初の動画 → 最初の画像」の順に選び直した。サムネイル側の詳細は
  [thumb-design.md](./thumb-design.md) を参照。

### 10.2 作品キーの扱い

4 章の深さの定義に加え、`depth = 1` / `2` で**指定より浅い位置**にあるファイル
（ルート直下のバラ置きなど）は、存在する階層までを作品キーにする（ルート直下なら `""`）。
これがないと `D:\ComfyUI\output` 直下の 83 ファイルが件数から漏れ、Explorer と一致しない。
`depth = 0` は定義どおりルート直下のファイルだけを 1 作品にする。

### 10.3 重複の判定タイミング

- `add_root`: 正規化した `real_path` が既存ルートと一致する場合、新しい行を作り
  `duplicate_of` に既存ルート id を入れる（既存ルートの設定は書き換えない）。
  表示パスまで同一の場合は「同じルートの再追加」として深さだけ更新する。
- `scan_root`: `duplicate_of` が入っているルートは走査せず `status = "duplicate"` を返す。
- 実体 ID が別ルートに索引済みのファイルは、走査中に `duplicates` として数えてスキップする。
  1 件も固有ファイルが無ければ、そのルートに `duplicate_of` を記録し、索引済みの作品を削除する。

### 10.4 DB の場所

| ビルド | パス |
|---|---|
| リリース | `%APPDATA%\works-browser\index.db` |
| 開発（`debug_assertions`） | `<repo>\.cache\index.db` |
| 上書き | 環境変数 `WORKS_BROWSER_DB` |

### 10.5 実測（release ビルド）

| 対象 | 初回 | 再走査 | ピークメモリ |
|---|---:|---:|---:|
| `D:\ComfyUI\output`（391 ファイル） | 9 ms | 5 ms | — |
| `D:\Projects\Blender\03_generated`（73 ファイル） | 3 ms | 2 ms | — |
| 合成 20,000 ファイル | 464 ms | 204 ms | 約 11 MB |

再走査は mtime / size が同じファイルを書き換えないため、`unchanged` 件数だけが増える。
