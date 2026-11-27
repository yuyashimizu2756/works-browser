# works-browser 計画

D ドライブに整理した作品フォルダ群（Blender / ComfyUI の生成物を含む）を、ローカルで高速に閲覧するデスクトップアプリ。
**Tauri v2（Rust）** で作る。数万ファイルの走査・サムネイル生成・スクロールをネイティブ速度で行うのが狙い。

## 0. 前提

- **対応OS: Windows 10/11 のみ**（Tauri + WebView2 + MSVC。macOS/Linux は対象外）
- UI は **Windows の作法**に合わせる: ショートカットは `Ctrl`（`⌘` は使わない）、タイトルバーは Windows 11 風（右に最小化/最大化/閉じる）、フォントは Segoe UI Variable / Yu Gothic UI、角丸は 6〜8px、削除は `Delete`（ゴミ箱）/ `Shift+Delete`（完全削除）
- ダイアログは Windows 標準（`tauri-plugin-dialog`）を使う

## 1. 対象データ（実測 2026-11-25）

| ルート候補 | ファイル | 動画 | 画像 | サイズ | 既定 |
|---|---:|---:|---:|---:|---|
| `D:\Media\Gamma` | 41,855 | 1,770 | 28,601 | 10.3 GB | ✅ |
| `D:\Media\Alpha` | 2,104 | 70 | 2,019 | 4.4 GB | ✅ |
| `D:\Media\Delta` | 1,041 | 0 | 1,041 | 0.3 GB | ✅ |
| `D:\Media\Beta` | 889 | 0 | 869 | 0.9 GB | ✅ |
| `D:\Media\Epsilon` | 201 | 0 | 201 | 0.2 GB | ✅ |
| `D:\Media\Gamma` | 57 | 42 | 0 | 40.1 GB | ✅ |
| `D:\Projects\Blender\03_generated` | 107 | 50 | 23 | 0.2 GB | ✅ |
| `D:\ComfyUI\output` | 391 | 357 | 34 | 0.6 GB | ✅ |
| `D:\ComfyUI\input` | 1,371 | 96 | 1,268 | 9.9 GB | 任意 |
| `D:\Backup\ComfyUI` | 220 | 139 | 50 | 0.7 GB | 任意 |
| `D:\ComfyUI\models` 等 | 111,531 | — | — | 389.7 GB | ❌ 除外 |

注意:
- `D:\Projects\Blender\04_comfy_output` は `D:\ComfyUI\output` と同一内容（重複）。**同一実体のパスを検出して片方だけ索引**する。
- 合計 **約 6.5 万ファイル / 66 GB**（モデル類を除く）。うち実際に表示するのは画像・動画のみ。

**作品の単位**: ルートごとに「第 1 階層 / 第 2 階層 / フラット」を選べる（例: `ComfyUI\output\series1495\...` は第 1 階層、`Media\\Gamma\<作品名>\...` も第 1 階層）。

## 2. 技術選定

| 領域 | 採用 | 理由 |
|---|---|---|
| シェル | **Tauri v2 (Rust)** | バイナリ ~10MB、常駐メモリ ~100MB、走査・サムネイル・DB をすべてネイティブ速度で処理 |
| UI | React 19 + TypeScript + Vite | 仮想スクロール・動画プレイヤーの実績 |
| 索引 | **rusqlite**（bundled SQLite, WAL） | 6.5 万件の挿入・検索を同期実行でも高速。ファイル 1 個で完結 |
| 走査/並列 | rayon + walkdir + tokio | CPU 全コアでハッシュ・寸法取得 |
| サムネイル（画像） | `image` + `webp` crate | ffmpeg 不要で高速 |
| サムネイル（動画） | **ffmpeg sidecar** | 既存の `D:\Projects\08_media_tools\media-tools\bin\ffmpeg.exe` を同梱可 |
| 監視 | `notify` + `notify-debouncer-full` | 追加・削除をネイティブイベントで受ける |
| 配信 | Tauri asset protocol（Range 対応）/ 独自 URI スキーム | 10GB の mkv でもシーク可、メモリに載せない |
| 状態 | zustand + TanStack Query | IPC 結果のキャッシュ管理 |
| 配布 | `tauri build` → NSIS（portable）+ MSI | インストーラ不要の exe も作れる |

不採用: Electron（メモリ・起動・走査速度で劣る）。ローカルサーバ型（動画配信は楽だが常駐プロセスが増える）。

### ビルド環境の前提（この PC の現状）

| 必要 | 状態 |
|---|---|
| WebView2 Runtime | ✅ 158.0.4370.33 導入済み |
| Rust (rustup) | ✅ 1.100.0（stable-msvc） |
| MSVC Build Tools（VC++ x64） | ✅ Visual Studio Build Tools 2022（C++ ワークロード） |
| Node 24 / npm | ✅ v24.21.0（Volta 管理） |

→ 導入済み。Tauri v2 + React + TS + Vite のスキャフォールドは Issue #1 で作成済み。

## 3. アーキテクチャ

```
┌────────────── Rust (Tauri core) ──────────────┐
│ scanner   walkdir + rayon   … 差分検出         │
│ indexer   rusqlite (WAL)    … バッチ upsert     │
│ thumbs    image / ffmpeg    … 並列 + キャッシュ  │
│ watcher   notify            … 増減の反映        │
│ protocol  asset / custom    … Range 配信        │
└──────────────┬────────────────────────────────┘
               │ tauri commands / events
┌──────────────┴────────────────────────────────┐
│ React: ライブラリ / 作品詳細 / 検索 / 設定      │
└───────────────────────────────────────────────┘
```

- 走査・サムネイルは Rust 側のスレッドプールで実行し、進捗を `event` で UI に流す
- サムネイルは `%LOCALAPPDATA%\works-browser\thumbs\<hash>.webp`、元ファイルの mtime/size で無効化
- ファイルは `(device, inode)` 相当（Windows は `volume serial + file index`）で**重複パスを判定**

## 4. データモデル（SQLite）

```sql
roots(id, path, real_path, label, depth, enabled, created_at)
works(id, root_id, rel_path, title, kind, cover_file_id, file_count,
      total_bytes, mtime, created_at, updated_at)
files(id, work_id, rel_path, kind, bytes, width, height, duration_ms,
      mtime, volume_serial, file_index, thumb_path, phash)
tags(id, name, color)
work_tags(work_id, tag_id)
marks(work_id, favorite, rating, note, last_opened_at, open_count)
scan_runs(id, root_id, started_at, finished_at, added, removed)
```

`marks.open_count` は「何回開いたか」を自前で記録する（OS は回数を残さないため）。

## 5. 画面

1. **ライブラリ**: 作品カードのグリッド。並び順（更新 / 名前 / サイズ / 評価）、種類フィルタ、検索、無限スクロール、**複数選択**（ホバーでチェック / Ctrl・Shift・矩形ドラッグ）
   - **表示モード3種**（#21）: `作品`（`Ctrl+1`）/ `ファイル`（`Ctrl+2`）/ **サムネ非表示**（`Ctrl+Shift+H`）
     - ファイルモード: `files` を直接グリッド表示（65,000件を仮想スクロール、所属作品名を併記）
     - サムネ非表示: 画像リクエスト0件のコンパクトなリスト。ホバープレビューも停止、`generate_thumbs` をキックしない
   - ホバープレビュー（作品モード）: 600ms ホバーで先頭4枚を 800ms 間隔で切替、`prefers-reduced-motion` を尊重
2. **作品詳細**: **全ファイルのサムネイルグリッド**（代表1枚で止めない）。サイズ 小/中/大、並び・絞り込み、ライトボックス（画像は ←→・ズーム）とプレイヤー（シーク・速度・続きから）、ファイル単位の選択
3. **検索**: タグ / 名前 / 期間の横断検索
4. **設定**: 監視ルート追加（深さ指定）、除外パターン、ffmpeg パス、サムネ品質、キャッシュ削除

### 削除の安全設計（#15）

| 項目 | 方針 |
|---|---|
| 既定の動作 | **ゴミ箱へ移動**（`IFileOperation` / `trash` crate）＝復元可能 |
| 完全削除 | `Shift+Delete` か設定で明示した場合のみ。確認ダイアログ必須 |
| API | UI は `files.id` のみ渡す。任意パスを渡せない設計（Rust 側でルート内かを検証） |
| 対象外 | 登録ルート外、シンボリックリンク/ジャンクションの先 |
| 失敗時 | 読み取り専用・使用中・権限なしはスキップし、成功件数と理由をまとめて表示 |
| 取り消し | 削除後 5 秒間 Undo（ゴミ箱から復元）。不可なら案内を出す |
| 後始末 | DB の `files`/`works` とサムネイルキャッシュも削除 |

## 6. マイルストーン

| M | 内容 | Issue |
|---|---|---|
| M0 環境 | rustup + MSVC Build Tools + `tauri init` が通る | #1 |
| M1 基盤 | スキャフォールド、走査、SQLite、ルート設定 | #1 #2 #8 |
| M2 閲覧 | サムネイル、ライブラリ、詳細ビュー | #3 #4 #5 |
| M3 管理 | タグ・評価、フォルダ監視 | #6 #7 |
| M4 仕上げ | portable 配布、性能検証 | #9 #10 |

## 7. 非機能目標（Rust 前提）

- 初回スキャン 6.5 万ファイル: **90 秒以内**
- 再スキャン（差分のみ）: **3 秒以内**
- サムネイル生成: 画像 **100 枚/秒**、動画 **10 本/秒**（並列 8）
- ライブラリ初回表示 200ms、スクロール 60fps（1 万件）
- 常駐メモリ **150MB 以下**、起動 **1 秒以内**、バイナリ 15MB 以下
