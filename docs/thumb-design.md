# サムネイル生成・キャッシュの設計（#3 実装メモ）

Issue #3 の実装で決めたことと、仕様から少し動かした点を残す。コードは
`src-tauri/src/thumbs/`（`mod.rs` / `photo.rs` / `video.rs`）。

## 1. 生成の流れ

```
generate_thumbs(limit, force)
  └ spawn_blocking
      ├ DB から未生成を拾う（ORDER BY works.mtime DESC, files.id / LIMIT）
      ├ rayon 専用プール（既定: CPU コア数 − 2 スレッド）でチャンク（並列数 × 2 件）ごとに処理
      │   ├ 画像: image でデコード → EXIF の向き → 長辺 512 に縮小 → webp 品質 75
      │   └ 動画: ffmpeg -i で尺を確認 → -ss 10% → -frames:v 1 → scale=512:-2
      │            → 一時 PNG → 画像と同じ経路で WebP（失敗時は 1 秒 → 0 秒 → プレースホルダ）
      ├ 一時ファイル（`.<name>.<pid>.<n>.tmp`）に書いてから rename
      └ files.thumb_path / thumb_mtime / thumb_bytes / duration_ms を UPDATE
```

`thumbs://progress` は `{ done, total }` をチャンクごとに emit する。
キャンセルは `AtomicBool` をチャンクの先頭で確認する（最大 16 件待つだけ）。

## 2. スキーマ（v2）

`docs/scan-design.md` のスキーマに対して 2 列追加した。

```sql
ALTER TABLE files ADD COLUMN thumb_mtime INTEGER; -- 生成時点の元ファイル mtime
ALTER TABLE files ADD COLUMN thumb_bytes INTEGER; -- 生成時点の元ファイル size
```

未生成の条件は次の 1 本。`thumb_path` があるだけでは不足で、元ファイルが変われば
`thumb_mtime/bytes` と `files.mtime/bytes` がずれるので再生成対象になる。

```sql
f.thumb_path IS NULL
OR f.thumb_mtime IS NULL OR f.thumb_mtime <> f.mtime
OR f.thumb_bytes IS NULL OR f.thumb_bytes <> f.bytes
```

マイグレーション時に、既存 DB の作品カバーを「最初の動画 → 最初の画像」の順に
選び直す（v1 は画像優先だった）。走査後も `db::refresh_covers` で同じ順に更新する。

## 3. キャッシュキー

`%LOCALAPPDATA%\works-browser\thumbs\<sha1>.webp`。

Issue の指定は `<sha1(rel_path)>` だが、**ルートの実体パスも混ぜている**。
`files.rel_path` はルートからの相対パスなので、別ルートに同名ファイルがあると
同じハッシュになり、別の作品のサムネイルが出てしまうため。ルートを移動すると
キーが変わり作り直しになる（実害は小さい）。

`WORKS_BROWSER_THUMBS_DIR` で上書きできる（テスト・計測用）。

### 壊れない書き込み

同一ディレクトリの一時ファイルに書いて `rename`。Windows の `rename` は既存
ファイルを置き換えられないため、対象が存在するときだけ先に削除する。削除と
rename の間に落ちた場合は「キャッシュが無い」状態になるので、`reset_thumbs` →
再生成で復旧できる。

## 4. 動画

- ffmpeg の探索順: 設定（`meta.thumbs.ffmpeg_path` / `WORKS_BROWSER_FFMPEG`）→
  アプリと同じフォルダの `ffmpeg.exe`（Tauri sidecar / `bundle.externalBin`）→
  PATH → `D:\Projects\08_media_tools\media-tools\bin\ffmpeg.exe`。
  見つからなければ動画はプレースホルダ（アプリは落とさない）。
- 10% 地点を狙うには尺が要る。`files.duration_ms` が無ければ `ffmpeg -i` の
  stderr（`Duration: HH:MM:SS.cc`）から読み、DB に書き戻す（UI でも使える）。
- 試す位置は `10% → 1 秒 → 0 秒`。duration を超える位置・重複は捨てる。
- `-ss` は入力の前（高速シーク）、`-frames:v 1`、`-vf scale=512:-2`、
  出力は一時 PNG（`libwebp` の有無に依存しないため ffmpeg では WebP を作らない）。
- 子プロセスは `CREATE_NO_WINDOW` で起動する（コンソールが点滅しない）。

## 5. 画像

- `ImageReader::into_decoder` → `ImageDecoder::orientation()` → `apply_orientation`。
  EXIF が無い形式では `NoTransforms`。
- `DynamicImage::thumbnail(512, 512)` は**縮小専用**（小さい画像を拡大しない）。
- 透過は RGBA のまま WebP に入れる。
- AVIF はデコードしない（`image` の `avif` は rav1e でビルドが重く、`avif-native` は
  dav1d のネイティブビルドが要る）。AVIF はプレースホルダになる。README に明記。

## 6. プレースホルダ

生成に失敗したファイルにも 1 枚書く（ダーク背景 + 枠 + 山 + 太陽）。理由:

- UI 側で「失敗」を特別扱いしなくてよい（`thumb_path` が入っている）。
- 失敗を DB に記録して再試行ループに入るのを防ぐ（元ファイルが変われば再生成）。

`thumb_path` は書けたが保存に失敗した場合だけ `NULL` のまま残す（次回再試行）。

## 7. 設定

`meta` テーブルに保存（設定画面は #4 以降）。範囲外は丸める。

| キー | 既定 | 範囲 |
|---|---:|---:|
| `thumbs.max_edge` | 512 | 64–1024 |
| `thumbs.quality` | 75 | 1–100 |
| `thumbs.parallelism` | 8 | 1–16 |
| `thumbs.ffmpeg_path` | （なし） | 空で既定探索 |

## 8. キャッシュの破棄

`reset_thumbs(delete_files = true)` で `thumb_path/thumb_mtime/thumb_bytes` を
NULL に戻し、キャッシュ先の WebP も消す（キャッシュ先の外のパスは消さない）。
品質変更や「キャッシュ削除」に使う。DB を信じる設計なので、フォルダを手で
消しただけでは再生成されない（`thumb_queue_size` も 0 のまま）ことに注意。

## 9. 実測（2026-11-25 / release / 8 並列・当時の既定）

| 対象 | 枚数 | 生成 | 1,000 枚換算 | 2 回目 |
|---|---:|---:|---:|---:|
| `D:\ComfyUI\output`（動画 363 + 画像 34） | 397 | 11.1 s | 28.0 s | 0 生成 |
| `D:\Media\Delta`（画像のみ） | 1,041 | 13.1 s | 12.6 s | 0 生成 |
| 合成 1,024px JPEG | 1,000 | 4.6 s | 4.6 s | 0 生成 |

キャッシュは 397 枚で 4.7 MB（平均 12.1 KB）。初回（OS キャッシュが冷えた状態）は
`D:\ComfyUI\output` が 20.8 秒だった。

## 10. テスト

`src-tauri/src/thumbs/tests.rs`:

- 画像 → 512px WebP、2 回目は 0 生成
- mtime / size 変更で再生成、キャッシュ削除 + reset で再生成
- EXIF Orientation=6 の JPEG が縦長になる
- 壊れた画像・消えたファイルでプレースホルダ（panic しない）
- 動画（ffmpeg がある環境のみ）と `duration_ms` の記録
- カバーが動画優先、動画削除で画像へフォールバック
- キュー件数、キャッシュキーの安定性
- v1 の DB を開いたときのマイグレーション（サムネイル列の追加・カバーの動画優先）

`cargo run --release --example thumbs -- <path> [depth] [limit]` で実データ計測。
