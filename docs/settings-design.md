# 設定画面の設計（#8）

## 目的

- どのフォルダをどの深さで対象にするかを、GUI から変更できるようにする
- 除外パターン・ffmpeg・サムネイルキャッシュ・起動時の動作を 1 か所にまとめる
- 設定の保存先を `%APPDATA%\works-browser\config.json` に一本化する
- `App.tsx` を触っている #15（削除）/ #6（タグ）と衝突しないよう、独立コンポーネントにする

## 構成

| 場所 | 役割 |
|---|---|
| `src-tauri/src/config.rs` | `config.json` の型・既定値・丸め・`.bak` 退避 |
| `src-tauri/src/settings.rs` | `get_settings` / `update_settings` の集約。config + DB + キャッシュ + ffmpeg |
| `src-tauri/src/exclude.rs` | 除外 glob（`*` / `?`、大文字小文字無視） |
| `src-tauri/src/index/scan.rs` | 走査時に除外パターンを適用。深さ・`roots.enabled` もここ |
| `src-tauri/src/thumbs/mod.rs` | キャッシュ使用量・削除・上限超過分の整理 |
| `src/settings/SettingsDialog.tsx` | 設定画面本体（左下の「設定」ボタンもここ） |
| `src/settings/model.ts` | 丸め・パターン解析・再走査要否の純粋関数 |
| `src/settings/playback.ts` | 音量を保存する設定（既定は毎回ミュート） |

## 何が正か

| 設定 | 正 | 補足 |
|---|---|---|
| 表示モード・サムネ表示・シールド | `config.json` | #21 / #22 の既存設定をそのまま使う |
| 除外パターン | `config.json` | 走査のたびに読む（次回走査から反映） |
| ffmpeg パス | `config.json` | 空なら自動検出。旧 `meta.thumbs.ffmpeg_path` も読む |
| サムネイル品質・キャッシュ上限 | `config.json` | 品質は #3 の `meta` にも同期 |
| ルート（パス・深さ・有効 / 無効） | 索引 DB | 走査対象そのもの。設定ファイルには複製しない |

`update_settings(patch)` は指定した項目だけを更新し、保存後に全体を返します。
UI は返ってきた値で下書きを置き換えるため、丸め結果と表示がずれません。

## 即時反映と再走査

| 操作 | 反映 |
|---|---|
| ルート追加 + 走査 | 追加直後に `scan_root` を呼ぶ |
| 有効 / 無効 | 即時。`find_works` / `find_files` / `library_stats` が `roots.enabled = 1` で絞る |
| ルート削除 | 即時。`works` / `files` / `scan_runs` は `ON DELETE CASCADE` |
| 深さ | 次回の走査から（UI に明示） |
| 除外パターン | 次回の走査から（UI に明示） |
| 品質 | 次回の生成から（キャッシュは既存のまま） |

## 破損時の復旧

`config.json` が JSON として読めない場合は `config.json.bak` にリネームしてから
既定値で起動します。壊れた内容は消さず、ユーザーが手で直せるようにします。
値が範囲外なだけの場合は既定値へ丸めます（ファイルは残します）。

## キャッシュ

- 使用量はキャッシュ先のファイル数と合計バイト数（サブディレクトリは見ない）
- 削除は WebP と DB の `thumb_path` / `thumb_mtime` / `thumb_bytes` を消す
- 上限超過時は更新日時の古い順に削除し、該当する DB 参照も外す
- テストは `TempDir` を使い、実データ（作品フォルダ）には触れない

## 検証

```powershell
cd src-tauri
cargo test --all
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check

cd ..
npm run typecheck
npm run test:unit
npm run build
# headless（GUI は起動しない）
chrome --headless=new --dump-dom "http://localhost:4173/?settings=1"
```
