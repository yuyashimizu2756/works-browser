# テスト方針と実行方法（#32）

このリポジトリのテストは 4 層に分かれています。**実データ（作品フォルダ）は読み取り専用**で、
自動テストから書き換えません。GUI（`npm run tauri dev` / 生成 exe）は自動化の対象外です。

| 層 | 対象 | 実行 | CI |
|---|---|---|---|
| Rust | 走査・索引・差分・重複検出・サムネ・設定・監視・削除ロジック | `cargo test --all` | する |
| フロント | 純粋ロジック（選択・並び替え・絞り込み・書式・表示モード・音量・Undo）と DOM モック | `npm test` | する |
| スモーク | 一時 DB の初期化 → 実フォルダ走査 → 集計（**ウィンドウを出さない**） | `cargo run --features dev-tools --bin smoke -- --json` | する |
| スクショ回帰 | `vite build` + `vite preview` を headless Chrome で撮影し前回と比較 | `npm run visual:check` | しない（ローカル手順） |

E2E（tauri-driver / WebdriverIO）は Windows での安定性が低いため、現時点では採用していません。
起動と IPC に相当する処理は `--smoke` で、見た目の崩れはスクリーンショットで代替します。

## 1. Rust

```powershell
cd src-tauri
cargo test --all
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

テストは各モジュール内（`src/index/*_tests.rs`、`src/thumbs/tests.rs` など）にあります。
実ファイルを使うテストは `tempfile` で一時ディレクトリを作り、終了時に破棄します。

### 計測系テスト（性能）の前提（#43）

`src/index/file_tests.rs` の 65,000 件（`sixty_five_thousand_files_first_page_is_under_300ms`）と
`src/index/gallery_tests.rs` の作品内 1,000 件は、**時間を測るテスト**です。次の前提で書きます。

- **ウォームアップを 1 回**流してから本計測する（初回は SQLite / OS のコールドキャッシュで遅い）
- **3 回計測した中央値**を採用する（1 回だけの計測は CI で 300ms を超えて flake した）
- しきい値は `index::perf::budget(...)` を通す。**ローカルは 300ms、CI（`CI` 環境変数あり）は 2 倍の 600ms**
- 新しい計測テストも `perf::median_of_three` / `perf::budget` を使う（自前で `Instant` を挟まない）
- 計測だけでなく、**クエリプランに `SCAN` が出ないこと**もテストする
  （`db::explain_find_files`。`roots.enabled` は `idx_roots_enabled`、`files` は `idx_files_work` を使う）

**flake の扱い**: 計測系テストが遅い CI ランナーでだけ失敗し、**再実行で通った場合は flake として記録**します
（Issue / PR に「失敗値・リランの結果」を残す）。しきい値を黙って緩めたり、テストを消したりしません。
再実行しても落ちる場合は退行として扱い、`EXPLAIN QUERY PLAN`（`cargo test -- --nocapture` で確認）と
索引を見直します。

> 記録例（#43）: `sixty_five_thousand_files_first_page_is_under_300ms` が CI で 312ms / 385ms と
> 2 回失敗し、再実行で成功した。初回（コールドキャッシュ）だけを測っていたのが原因だったため、
> ウォームアップ 1 回 + 3 回の中央値に変更し、CI の予算を 600ms にした。

```powershell
cd src-tauri
# 計測テストだけを 10 回連続で回して安定性を確認
1..10 | ForEach-Object { cargo test sixty_five_thousand_files_first_page }
```

## 2. フロント（Vitest）

```powershell
npm test            # 1 回だけ実行（CI と同じ）
npm run test:watch  # 変更を監視
```

構成:

- `vitest` + `jsdom` + `@testing-library/react`
- 設定: `vitest.config.ts`
- セットアップ: `tests/setup.ts`（jest-dom のマッチャと RTL の後始末）
- テスト: `tests/*.test.ts(x)`

純粋関数は `src/lib/` に置き、画面コンポーネントとテストの両方から使います。

| ファイル | 内容 | 主なテスト |
|---|---|---|
| `src/lib/selection.ts` | 単体 / Ctrl / Shift 範囲 / 全選択 / 矩形選択 | `tests/selection.test.ts` |
| `src/lib/sort.ts` | 作品・ファイルの並び替え | `tests/sort.test.ts` |
| `src/lib/filter.ts` | 検索・種類・ルート・作品での絞り込み | `tests/filter.test.ts` |
| `src/lib/format.ts` | `formatBytes` / 日付 / 長さ / 件数 | `tests/format.test.ts` |
| `src/lib/viewMode.ts` | 表示モードの遷移・URL / ショートカット | `tests/viewMode.test.ts` |
| `src/lib/volume.ts` | 起動時の音量 0 / ミュート、解除・スライダー | `tests/volume.test.ts` |
| `src/lib/undo.ts` | Undo の残り時間・期限切れ・進捗（純粋モデル） | `tests/undo.test.ts` |
| `src/lib/navStack.ts` | 画面履歴の push / 戻る / 進む / 上限（#33） | `tests/nav-stack.test.ts` |
| `src/library/useWorkFeed.ts` | 検索デバウンス | `tests/useDebouncedValue.test.tsx` |
| `src/library/ChipButton.tsx` | フィルタチップの `aria-pressed` とクリック | `tests/ChipButton.test.tsx` |
| `src/library/shield/*` | シールドのホットキー・長押し・設定・動画ミュート | `tests/privacy-shield.test.ts` |

**新規テストが落ちたら CI の `Frontend unit tests` が赤くなります。**
わざと壊して確認する場合:

```powershell
# 例: formatBytes の期待値を書き換える
# tests/format.test.ts の '1.0 KB' を '1 KB' にした状態で
npm test
# → 失敗することを確認したら元に戻す
```

## 3. スモーク（GUI なし）

```powershell
cd src-tauri
cargo run --features dev-tools --bin smoke
cargo run --features dev-tools --bin smoke -- --json
```

やること:

1. OS の一時ディレクトリに DB とサンプル作品フォルダを作る
2. `db::open` でスキーマを初期化
3. `db::add_root` → `scan::scan_root` で走査
4. 作品 2 件 / ファイル 3 件（索引対象外の `.txt` は除外）になったことを検証
5. 集計を表示して終了コード 0。失敗時は 1（原因は stderr）

`tauri::Builder` も WebView も起動しないため、ウィンドウは一切出ません。`--json` は次の形です。

```json
{
  "ok": true,
  "db": "C:\\Users\\...\\index.db",
  "root": "C:\\Users\\...\\library",
  "summary": {
    "status": "done",
    "files": 3,
    "works": 2,
    "added": 3,
    "total_bytes": 27
  },
  "stats": { "roots": 1, "works": 2, "files": 3, "total_bytes": 27 }
}
```

CI では `cargo test --all` の直後に実行します。

## 4. スクショ回帰（ローカル）

前提: Chrome または Edge がインストールされていること（`CHROME_PATH` で明示も可）。

```powershell
npm run visual:check
# 差分が 2% を超えたら失敗にしたい場合
npm run visual:check -- --strict
```

流れ:

1. `npm run build`（型チェック + Vite ビルド）
2. `vite preview --port 4173 --host 127.0.0.1` を起動
3. headless Chrome（`--headless=new`）で画面を撮影（既定はライブラリ 2 サイズ + 詳細・ヘルプ・
   空状態・ライトボックス）
   - ライブラリ: `/?bench=24`
   - 作品詳細: `/?bench=24&detail=3`
   - ライブラリ（デモ画像つき）: `/?bench=24&demo=1`
   - 作品詳細（デモ画像つき）: `/?bench=24&demo=1&detail=3`
   - ライトボックス（#8）: `/?bench=24&demo=1&detail=3&thumbs=shown&lightbox=1`
     （`&lightboxMenu=1` / `&lightboxMeta=1` でメニュー・生成情報パネルを開いた状態）
   - ライトボックスの可読性（#15）は **1440×900 / 1280×800 / 800×600** の 3 サイズで
     撮影（`lightbox-1440x900.png` / `lightbox-1280x800.png` / `lightbox-800x600.png`）。
     動画のキー案内は `&lightboxVideo=1` の `lightbox-video.png` で確認する
   - シールド: `/?bench=24&shield=1`
4. `D:\Projects\visual\<name>.png` に保存
5. 前回の `<name>.png` とピクセル単位で比較し、差が **2% 超**なら警告

出力先は `VISUAL_OUT_DIR` で変更できます。比較用に次のファイルも残します。

- `<name>.prev.png` … 前回の画像
- `<name>.diff.png` … 差分を赤で塗った画像（サイズが同じ場合のみ）

初回は baseline を作るだけです。レイアウトを意図的に変えたときは、`.png` を削除するか
`D:\Projects\visual` を退避してから撮り直してください。**CI には載せません**（Chrome と
フォントの差で不安定になるため）。

## 5. カバレッジ

```powershell
npm run test:coverage
```

`@vitest/coverage-v8`（V8 のカバレッジ = c8 と同じ仕組み）で `src/lib/**/*.ts` を計測します。
React フック（`src/lib/use*.ts`）は純粋関数ではないため対象外です。
レポートは標準出力と `coverage/index.html`。目標は**純粋関数 80%** で、`vitest.config.ts` の
`coverage.thresholds` で下回ると失敗します。

> Vitest はワーカー分離のため素の `c8` コマンドでは子プロセスの V8 カバレッジを拾えません。
> そのため同じ V8 カバレッジを Vitest の公式プロバイダで取得しています。

計測は CI に載せず、ローカルで確認します（実行時間を増やさないため）。

## 6. CI で走るもの

`.github/workflows/ci.yml`（Windows, pull_request / main push）:

1. `npm ci`
2. `npm run typecheck`
3. `npm run test:unit`（Vitest）
4. `npm run build`
5. `cargo fmt --all -- --check`
6. `cargo clippy --all-targets -- -D warnings`
7. `cargo test --all`
8. `cargo run --features dev-tools --bin smoke -- --json`

スクショ回帰とカバレッジは含めません。テスト追加による CI の増加は 1 分未満を目安にしています
（Vitest は約 1 秒、スモークはビルド済みなら数秒）。
