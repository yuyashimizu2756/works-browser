
## リリースノートの必須項目

- **更新方法**: 「アンインストール不要。新しい setup.exe を上書き実行」と明記する（ピン留めを消さないため）
- **SmartScreen**: 「詳細情報 → 実行」と SHA-256 の案内を入れる

## バージョン番号の運用

- リリースごとに **3か所** のバージョンを揃えて上げる（忘れるとアプリ内の表示とインストーラ名が同じままになる）
  - `package.json`
  - `src-tauri/tauri.conf.json`
  - `src-tauri/Cargo.toml`
- 派生ファイルは手で書かず、コマンドで追従させる
  - `src-tauri/Cargo.lock` は `cargo check`
  - `package-lock.json` は `npm install --package-lock-only --ignore-scripts`
- タグは `v<version>`（例: `v0.1.1`）。**タグとバージョンを一致させる**
- 最新リリースだけ残す運用（旧タグ・旧リリースは削除）なので、本文末尾の自動生成リンク `compare/<旧タグ>...<新タグ>` は旧タグを消した時点で 404 になる。公開後に `commits/<新タグ>` へ差し替える
  - `gh release view v0.1.6 --json body --jq .body > body.md` → リンクを書き換え → `gh release edit v0.1.6 --notes-file body.md`（PowerShell のリダイレクトは文字化けするので UTF-8 で読み書きする）
- alpha の間は `0.1.x` を1つずつ上げ、正式版で `1.0.0` に置き換える

## ffmpeg sidecar の更新手順（URL・SHA-256・サイズの3点を同時に更新）

リリースビルドは gyan.dev の **バージョン固定 ZIP** を取得し、公開 SHA-256 と照合してから
sidecar に同梱する。`ffmpeg-release-essentials.zip` のような「常に最新」を指す可変 URL は、
配布元での差し替えを検知できないため使わない。

現在の値（`ffmpeg 9.1-essentials_build`）:

| 項目 | 値 | 出所 |
|---|---|---|
| URL | `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.1-essentials_build.zip` | gyan.dev の packages 一覧 |
| SHA-256 | `b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd` | 同 URL + `.sha256`（公開 checksum） |
| サイズ | `119467219` B（約 113.9 MiB） | 同 URL の `Content-Length` |

更新するとき:

1. 新しいバージョンの固定 URL を決める。例:
   `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-<version>-essentials_build.zip`
2. 公開 checksum を取得し、**64 桁の hex** を確認する。

   ```powershell
   curl.exe -sS https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-<version>-essentials_build.zip.sha256
   ```

3. 実ファイルのサイズを確認する（ダウンロード後の `Get-Item`、または `Content-Length`）。

   ```powershell
   curl.exe -sS -I https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-<version>-essentials_build.zip
   ```

4. `.github/workflows/release.yml` の `FFMPEG_URL` / `FFMPEG_SHA256` / `FFMPEG_SIZE` の
   **3 点を同時に**更新する。
5. `scripts/fetch-ffmpeg.ps1` の `-Url` / `-Sha256` / `-Size` の既定値も同じ値に更新する。
6. 実際に取得して検証を通す。

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
   ```

7. 失敗経路も確認する。ダミーのハッシュを渡すと `throw` して終了コードが非 0 になること。

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 `
       -Sha256 0000000000000000000000000000000000000000000000000000000000000000
   ```

   期待するログ（要約）:
   `ffmpeg zip の SHA-256 が一致しません: expected=0000... actual=b9bb...`

`release.yml` の「Prepare ffmpeg sidecar」は、ハッシュ不一致・サイズ不一致のどちらでも
`throw` してワークフローを失敗させる（警告で続行しない）。CI (`ci.yml`) は ffmpeg を
ダウンロードせず空の stub を置くだけなので、検証対象はリリース側のみ。
