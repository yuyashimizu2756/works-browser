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
- ライトボックスを閉じずにお気に入り・評価・タグ・生成情報・スライドショー
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
2. 走査が終わるとグリッドに並ぶ。`サムネ`（`Ctrl+Shift+H`）で画像を表示
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
- 画面の変更は `npm run visual:check` のスクショで確認します

## ライセンス

未設定（ライセンスを付ける場合は Issue で相談してください）。
