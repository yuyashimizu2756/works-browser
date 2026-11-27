# ビルドと配布物の作り方

`tauri build` で NSIS インストーラ・MSI・portable exe を作るまでの手順。開発環境の前提は
[README](../README.md#動作環境) を参照。

## 1. 依存関係

```powershell
npm.cmd install
```

> PowerShell で `npm.ps1` が実行ポリシーにブロックされる場合は `npm.cmd` を使ってください。

## 2. ffmpeg sidecar を用意する

`src-tauri/tauri.conf.json` の `bundle.externalBin` に `binaries/ffmpeg` を登録しています。
Tauri はターゲットトリプル付きのファイル名を要求するため、**`ffmpeg-x86_64-pc-windows-msvc.exe`**
という名前で `src-tauri/binaries/` に置く必要があります。

バイナリはリポジトリにコミットしません（`.gitignore` の `src-tauri/binaries/*.exe`）。
配布元から取得するか、既存の ffmpeg をコピーして配置します。

```powershell
# 既定: gyan.dev のバージョン固定 zip を取得し、公開 SHA-256 とサイズを検証して配置する
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1

# 手元の ffmpeg を使う場合（-SourceSha256 を渡すとその exe も照合する）
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 `
    -Source C:\path\to\ffmpeg.exe -SourceSha256 <64桁のhex>
```

手動でコピーする場合:

```powershell
New-Item -ItemType Directory -Force src-tauri\binaries | Out-Null
Copy-Item 'D:\Projects\08_media_tools\media-tools\bin\ffmpeg.exe' `
          'src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe' -Force
```

ffmpeg が無い場合は `scripts/fetch-ffmpeg.ps1` の既定動作を使ってください。gyan.dev の
バージョン固定 ZIP（例: `ffmpeg-9.1-essentials_build.zip`）を取得し、公開 SHA-256 と
サイズを検証してから `bin\ffmpeg.exe` を配置します。URL・ハッシュ・サイズの更新手順は
[release.md](./release.md) の「ffmpeg sidecar の更新手順」を参照。

確認:

```powershell
& src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe -version | Select-Object -First 1
```

> **注意**: `externalBin` は `cargo build` / `cargo clippy` の時点で存在チェックされます。
> バイナリを置いていない状態では Rust 側のビルドが
> `resource path ... doesn't exist` で失敗します。フロントエンドだけを触る場合も、
> Rust をビルドする前にこの手順を済ませてください。

### ffmpeg のライセンス

ここで使う gyan.dev の essentials ビルドは **GPLv3**（`--enable-gpl --enable-version3`）です。
インストーラに同梱して配布する場合は GPLv3 の条件（対応するソースの提供など）を満たす必要が
あります。同梱したくない場合は、`bundle.externalBin` から ffmpeg を外してビルドし、
ユーザーが自分で `ffmpeg.exe` を exe の隣に置く運用にしてください。

## 3. アイコンの再生成

原画は `assets/icon.png`（1024x1024）。`src-tauri/icons/` 一式はここから生成します。

```powershell
# 原画そのものを作り直す場合（任意）
powershell -ExecutionPolicy Bypass -File scripts/generate-icon.ps1

# src-tauri/icons/ 一式を生成
npm.cmd run tauri icon assets/icon.png
```

Windows 向けに必要なのは `icon.ico` / `32x32.png` / `128x128.png` / `128x128@2x.png` /
`icon.icns` です。`tauri icon` は `icons/android` `icons/ios` も生成しますが、このアプリは
デスクトップ専用なので本リポジトリでは削除しています（再生成すれば戻ります）。

## 4. ビルド

```powershell
npm.cmd run tauri build
```

`bundle.targets` は `["nsis", "msi"]`、`bundle.windows.nsis.installMode` は `currentUser`
（管理者権限不要・ユーザー単位インストール）です。

成果物（v0.2.11 の Release 公開アセット＝GitHub Actions の windows-latest でビルドした
2026-11-28 の実測。ffmpeg 同梱、サイズは 1 MB = 1,048,576 B 換算）:

| 種類 | パス | サイズ |
|---|---|---|
| portable exe | `src-tauri\target\release\works-browser.exe` | 15.17 MB（15,905,792 B） |
| NSIS インストーラ | `src-tauri\target\release\bundle\nsis\works-browser_x.y.z_x64-setup.exe` | 32.48 MB（34,059,414 B） |
| MSI | `src-tauri\target\release\bundle\msi\works-browser_x.y.z_x64_en-US.msi` | 44.36 MB（46,518,272 B） |

バンドルには ffmpeg（展開後 105 MB、zip 圧縮で約 29 MB）が同梱されます。同梱しなければ
インストーラは portable exe と同程度の数 MB になります。portable exe はこの PC での
ローカルビルド（release）が 14.91 MB（15,633,408 B）で目標の 15 MB 以下、CI の公開アセットは
バンドル情報のパッチ分だけ大きく 15.17 MB です（スキャフォールド時点では 8.6 MB）。

### サイズ削減（#86）

`src-tauri/Cargo.toml` に `[profile.release]` を置き、`strip = true` / `lto = "thin"` /
`codegen-units = 2` を指定しています。`opt-level` は既定（3）のまま、`panic` も既定
（`unwind`）のままです。

変更前は v0.1.5、変更後は v0.1.6 の当時の Release 公開アセットの実測です（この 2 版は現在
非公開で、公開中のリリースは v0.2.11 のみ。数値は #86 時点の記録として残しています）。

| 成果物 | 変更前（v0.1.5） | 変更後（v0.1.6） |
|---|---:|---:|
| portable exe | 15.30 MB（16,043,520 B） | **14.93 MB**（15,655,424 B） |
| NSIS | 32.37 MB（33,941,838 B） | 32.39 MB（33,958,669 B） |
| MSI | 44.27 MB（46,415,872 B） | 44.24 MB（46,387,200 B） |

- 減るのは Rust 側のコード（portable exe）だけです。NSIS / MSI は ffmpeg sidecar
  （圧縮後 約 29 MB）が支配的で、ほぼ変わりません。
- `cargo build --release --bin works-browser` の所要時間は **68.8 秒 → 127.2 秒**（1.85 倍、
  この PC のクリーンビルド）。`lto = true`（fat LTO）+ `codegen-units = 1` は 13.96 MB まで
  縮みますが 2.7 倍（188.8 秒）かかるため採用していません。

## 5. portable として使う

インストーラを使わず、ビルド済み exe を任意のフォルダに置くだけで動きます。

```
D:\Projects\works-browser\
  works-browser.exe   ← src-tauri\target\release\works-browser.exe をコピー
  ffmpeg.exe          ← 任意。src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe をリネームして置く
```

- WebView2 Runtime が必要です（Windows 11 は標準搭載。Windows 10 は
  [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/) を導入）。
- 設定・索引は `%APPDATA%\works-browser\` に作られるため、exe を別フォルダに移してもデータは
  引き継がれます。
- アンインストールはフォルダごと削除するだけです。
- ffmpeg は exe と同じフォルダに `ffmpeg.exe` という名前で置いてください
  （sidecar は実行ファイルと同じディレクトリから解決されます）。

## 6. トラブルシュート

| 症状 | 対処 |
|---|---|
| `resource path ... doesn't exist` | `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe` が無い。手順 2 を実行 |
| MSI 作成で WiX のエラー | `src-tauri/target/release/bundle/msi` を削除して再実行。パスに日本語や記号が入る場合は短いパスでビルド |
| NSIS が「既にインストール済み」で失敗 | 設定アプリから旧バージョンを削除するか、`currentUser` インストールのため `%LOCALAPPDATA%\works-browser` を削除 |
| 起動しても画面が白い | WebView2 Runtime の有無を確認 |
| `npm.ps1` が実行できない | `npm.cmd` を使う |
