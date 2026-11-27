# パイプライン運用（GitHub 無料枠ベース）

有料機能は使わない前提で、GitHub の標準機能だけで回す設計。

## 無料枠の前提

| 項目 | 枠 | 消費 |
|---|---|---|
| Actions（private） | 2,000 分/月 | **Windows ランナーは 2 倍**（1 分 = 2 分消費） |
| ストレージ（artifact） | 500 MB | 保持 14 日で自動削除 |
| Dependabot | 無料 | PR 数だけ制限 |
| Issues / Projects / Milestones | 無料 | — |
| CodeQL / Secret scanning（private） | **有料** | 使わない |

## 動くもの

| ワークフロー | トリガー | 目安時間 | 月の想定 |
|---|---|---|---|
| `ci.yml` | PR / main push（**コード変更時のみ**） | 6〜10 分 | PR 20 本で 約 400 分消費 |
| `release.yml` | タグ `v*` push のみ | 15〜25 分 | 月 2 回で 約 100 分消費 |

対策:
- `paths` フィルタでドキュメントのみの変更は**CI を起動させない**
- `concurrency: cancel-in-progress` で古い実行を止める
- `Swatinem/rust-cache` と `setup-node cache: npm` で 2 回目以降を短縮
- matrix を使わない（1 ジョブで完結）
- ランナーは `windows-latest` のみ

## 無料枠で使えないもの（実測 2026-11-25）

| 機能 | 結果 | 代替 |
|---|---|---|
| Branch protection / Rulesets（private） | **403: Pro 以上が必要** | `delete_branch_on_merge` + squash 固定 + 運用で担保 |
| Auto-merge | ブランチ保護が前提のため不可 | コーディネータ（エージェント）が CI 緑を確認して `gh pr merge --squash` |
| CodeQL / Secret scanning（private） | 有料 | 依存は Dependabot アラートで監視 |
| Projects ボード（API 操作） | 無料だが `project` スコープが必要 | `gh auth refresh -s project,read:project` で追加 |

## 運用ルール

1. 作業は Issue 単位。ブランチ名は `feat/<issue>-<slug>`。
2. PR は `Closes #n` を本文に入れる。CI が緑になってからマージ。
3. マージは **squash** のみ（履歴を 1 コミットに）。マージ後にブランチは自動削除。
4. リリースは `git tag v0.1.0 && git push --tags` → draft リリースが作られるので内容を確認して publish（詳細は下の「リリース手順」）。
5. 依存更新は Dependabot（月 1 回・グループ化・PR 最大 2 件）。

## リリース手順（タグ `v0.1.0`）

`release.yml` は**タグ push のときだけ**動きます（PR では動きません）。手動で回す場合は
Actions の `Release` → `Run workflow` にタグ名を入れて実行します。

### 1. バージョンを揃える

3 か所を同じ値に更新します（例: `0.1.0`）。

| ファイル | 項目 |
|---|---|
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version`（`Cargo.lock` は `cargo check` で更新） |

### 2. ローカルで 1 回ビルドして確認

```powershell
npm.cmd ci
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
npm.cmd run tauri build
```

NSIS / MSI / portable exe ができること、起動して `pong from Rust` が出ることを確認します
（詳細は [build.md](./build.md)）。**確認した成果物はコミットしません。**

### 3. タグを打って push

```powershell
git checkout main
git pull
git tag v0.1.0
git push origin v0.1.0
```

`release.yml` が走り、`tauri build` → **draft リリース**の作成まで自動で行います（15〜25 分）。

### 4. 下書きリリースを確認して publish

```powershell
gh release view v0.1.0            # 添付物の一覧を確認
gh release download v0.1.0 -D D:\Temp\Blender\works-browser-v0.1.0   # 中身の確認（任意）
gh release edit v0.1.0 --draft=false --title "works-browser v0.1.0"
```

- 添付される想定: `works-browser_0.1.0_x64-setup.exe`（NSIS）、`works-browser_0.1.0_x64_en-US.msi`
- リリースノートは `gh release edit v0.1.0 --notes-file <file>` で差し替え可能
- 同じタグで作り直す場合は、下書きを削除 → タグを打ち直す
  （`gh release delete v0.1.0 --yes && git push origin :refs/tags/v0.1.0` → 再度 tag push）
- portable で配りたい場合は、Actions の artifact `installers-v0.1.0`（保持 14 日）に入る
  `works-browser.exe` を取得し、`ffmpeg.exe` と一緒に zip にして添付します

### 5. 失敗したとき

| 症状 | 対処 |
|---|---|
| ffmpeg の取得で失敗 | `release.yml` の「Prepare ffmpeg sidecar」を再実行。gyan.dev が落ちている場合は手動でアップロードした artifact を使う |
| ffmpeg の SHA-256 / サイズ不一致 | 配布元の差し替えか、`FFMPEG_URL` ~ `FFMPEG_SIZE` の更新漏れ。公開 checksum を確認し、[release.md](./release.md) の「ffmpeg sidecar の更新手順」で 3 点を揃える（**検証は失敗させるので、警告で続行しない**） |
| `tauri build` で失敗 | ローカルで同じ手順を再現（[build.md](./build.md)）。Rust のキャッシュ起因なら Actions のキャッシュを削除 |
| draft が既にある | tauri-action が既存 draft を更新するので、そのまま publish してよい |

## 分数が足りなくなったら

1. `paths` フィルタをさらに絞る（例: `src-tauri/**` は PR では回さず main のみ）
2. `cargo clippy` を main push 時のみに限定
3. 一時的に `workflow_dispatch` だけにして手動実行に切り替え

## 将来の拡張（無料の範囲で）

- Issue を Projects（ボード）で M1〜M4 ごとに可視化
- `gh release create --generate-notes` で自動リリースノート
- タグ運用で `v0.x.y` のセマンティックバージョン
