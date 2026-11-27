# works-browser

[![CI](https://github.com/yuyashimizu2756/works-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/yuyashimizu2756/works-browser/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yuyashimizu2756/works-browser)](https://github.com/yuyashimizu2756/works-browser/releases/latest)

ローカルの作品フォルダ（イラスト・AI 生成画像・動画）を高速に閲覧する Windows 用デスクトップアプリ。
**Tauri v2（Rust）+ React 19 + TypeScript**。索引は SQLite、サムネイルはローカル生成。

- フォルダを追加するだけで索引化（差分更新・フォルダ監視つき）
- 6 万ファイルでも軽い仮想スクロールのグリッド（作品 / ファイル / タイムライン）
- 画像・動画のサムネイル、ホバーで無音プレビュー
- 動画はミュート解除時に音声を再初期化（WebView2 でも解除直後から音が出る）
- 生成情報（プロンプト・モデル・LoRA・seed）の抽出と検索
- タグ・評価・お気に入り、スマートフォルダ（保存検索）
- ライトボックスを閉じずにお気に入り・評価・タグ・生成情報・スライドショー（評価は読み込み後にだけ操作し、保存失敗時は元に戻る）
- ファイルのフルパスをカードのホバー / ビューワーのファイル名横からコピー（パスは Rust 側で解決）
- 再生できない動画は理由と「外部プレイヤーで開く」、シークできない動画はシークバーを無効化して理由を表示
- 重複・類似の検出と整理、2〜4 枚の比較とプロンプト差分
- ComfyUI 連携（workflow を開く / API 形式で再実行）
- プライバシーシールド（ホットキーで画面を隠す）

## 動作環境

| 必要 | 備考 |
|---|---|
| Windows 10 / 11（64bit） | WebView2 は同梱またはインストール済み |
| ffmpeg（任意） | 動画サムネイルに使用。インストーラ版は同梱 |

## インストール

[Releases](https://github.com/yuyashimizu2756/works-browser/releases/latest) から取得します。

| 形式 | 用途 |
|---|---|
| `works-browser_x.y.z_x64-setup.exe`（NSIS）| 推奨。ffmpeg 同梱・スタートメニュー登録 |
| `works-browser_x.y.z_x64_en-US.msi` | MSI 配布が必要な場合 |
| `works-browser.exe` | インストール不要。ffmpeg は別途配置 |

### SmartScreen の警告について

署名なしの配布物のため、初回起動時に **「Windows によって PC が保護されました」**（不明な発行元）が
出ることがあります。これは Windows の仕様で、コード署名がない限り表示されます。

1. 「**詳細情報**」→「**実行**」で起動できます
2. ダウンロードしたファイルを事前に許可する場合:

   ```powershell
   Unblock-File .\works-browser_0.2.6_x64-setup.exe
   ```

3. 改ざん確認: 各リリースの **SHA-256** を Releases に記載しています。

   ```powershell
   Get-FileHash .\works-browser_0.2.6_x64-setup.exe -Algorithm SHA256
   ```


## 開発

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1   # 動画サムネ用 sidecar
npm run tauri dev
```

| コマンド | 内容 |
|---|---|
| `npm run tauri dev` | 開発起動 |
| `npm run tauri build` | 配布物をビルド（`src-tauri/target/release/bundle`）|
| `npm run typecheck` | 型チェック |
| `npm test` | フロントのテスト（Vitest）|
| `cargo test`（`src-tauri`）| Rust のテスト |
| `npm run visual:check` | headless Chrome で画面のスクショ回帰 |

### デモ / ベンチモード

`?bench=24&demo=1` を付けて起動すると、合成データとサンプル画像で画面を確認できます。
デモ / ベンチモードは**実 DB を読み書きしません**。お気に入り・評価・タグは固定表示のみで、
保存系の操作は無効になります（ツールチップで案内が出ます）。

詳しいビルド手順は [docs/build.md](./docs/build.md)、リリース手順は
[docs/release.md](./docs/release.md)、テストは [docs/testing.md](./docs/testing.md)。

## 使い方

1. `＋ルート` でフォルダを追加（深さ = 作品のまとまり）
2. 走査が終わるとグリッドに並ぶ。`サムネ`（`Ctrl+Shift+H`）で画像を表示（起動ごとに非表示・状態は保存しない）
3. カードを開くと詳細、チェックボックスで選択、`Delete` でゴミ箱へ

画面と操作の詳細は **[docs/guide.md](./docs/guide.md)**。

### 主なキー

| 操作 | キー |
|---|---|
| フォーカス移動 / 評価 / お気に入り | `J` `K` / `1`〜`5` `0` / `F` |
| 開く / 検索 | `Enter` / `/` |
| ライトボックス内 | `Space` `F` `0` / `Shift+F` お気に入り / `1`〜`5` `Shift+0` 評価 / `T` タグ / `I` 情報 / `S` スライドショー |
| 表示モード（作品・ファイル・タイムライン）| `Alt+1` `Alt+2` `Alt+3` |
| サムネ表示 / シールド | `Ctrl+Shift+H` / `Ctrl+Shift+P` |
| 戻る / 進む | `Alt+←` / `Alt+→` |

`?` で全ショートカットを表示します。

### ライトボックスの削除・スライドショー・メニュー

- **削除後の移動**: ライトボックスから削除（`⋯` → ゴミ箱へ）すると、表示は
  1 つ前のファイルへ移り、履歴の index も同じ位置に更新されます。末尾を超える
  index は clamp し、最後の 1 枚を消したときはライトボックスを閉じます。
- **スライドショー**（`S`）: 画像は 3 秒ごと、動画は再生完了で次へ送ります。
  読み込み済みの終端では停止し、まだページが残っていれば追加読み込みして続行します。
- **`⋯` メニュー**: `Esc` か外側クリックで閉じ、フォーカスは開いたボタンへ戻ります。
  タグ名の入力中は `t` / `1` がライトボックスの操作として発火しません。

## 設定とデータ

| 種類 | 場所 |
|---|---|
| 索引 DB（リリース / 開発）| `%APPDATA%\works-browser\index.db` / `<repo>\.cache\index.db` |
| サムネイル | `%LOCALAPPDATA%\works-browser\thumbs\` |
| 設定 | `%APPDATA%\works-browser\config.json` |

`config.json` の項目一覧は [docs/settings-design.md](./docs/settings-design.md)。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [docs/guide.md](./docs/guide.md) | 使い方（画面・操作・設定）|
| [docs/design.md](./docs/design.md) | デザイントークンと画面構成 |
| [docs/scan-design.md](./docs/scan-design.md) | 走査・索引・スキーマ |
| [docs/thumb-design.md](./docs/thumb-design.md) | サムネイル生成とキャッシュ |
| [docs/settings-design.md](./docs/settings-design.md) | 設定と保存形式 |
| [docs/perf.md](./docs/perf.md) | 性能の実測 |
| [docs/build.md](./docs/build.md) | ビルド |
| [docs/pipeline.md](./docs/pipeline.md) | Issue / PR / CI の流れ |
| [docs/release.md](./docs/release.md) | リリース |
| [PLAN.md](./PLAN.md) | 計画と判断の記録 |

## 構成

```
src/                  React（画面・状態・API）
src-tauri/src/        Rust（索引・走査・サムネ・メタ・移動・削除）
src-tauri/src/index/  SQLite スキーマと走査
docs/                 設計・手順
scripts/              開発用スクリプト
```

## 性能（参考値）

Windows 11 / 8 コア CPU / 32GB RAM / NVMe SSD での実測です（詳細は [docs/perf.md](./docs/perf.md)）。

| 項目 | 値 |
|---|---|
| 初回走査（6.5 万ファイル換算）| 約 15 秒 |
| サムネイル生成 | 約 62 枚/秒 |
| 起動 / 常駐メモリ | 約 0.3 秒 / 約 34MB |

## 開発方針

- 変更は Issue 単位で進め、PR は CI 緑を条件にマージします
- 画面の変更は `npm run visual:check` のスクショで確認します。ライトボックス系は
  撮影前に DOM（`data-lightbox` など）を確認するので、自動オープンが壊れていれば
  同じ絵が撮れて通るのではなく、その場でエラーになります

## ライセンス

未設定（ライセンスを付ける場合は Issue で相談してください）。
