// Tauri v2 構成に合わせて Issue を更新する（一度だけ実行）
import { execFileSync } from 'node:child_process'

const run = (args, input) =>
  execFileSync('gh', args, { encoding: 'utf8', input, env: { ...process.env, GH_PAGER: 'cat' } })

const issues = [
  {
    n: 1,
    title: 'M0/M1: rustup + MSVC Build Tools 導入と Tauri v2 スキャフォールド',
    body: `## 目的
Rust 製デスクトップアプリの土台を作る。以後の Issue はすべてこの構成の上に載る。

## 環境（この PC の現状）
- WebView2: 導入済み ✅
- Rust: **未導入** ❌
- MSVC Build Tools (VC++ x64): **未導入** ❌（\`link.exe\` 無し）
- Node 24 / npm: 導入済み ✅

## 成果物
- [ ] \`winget install Rustlang.Rustup\` → \`rustup default stable-msvc\`
- [ ] Visual Studio Build Tools + ワークロード「C++ によるデスクトップ開発」
- [ ] \`rustc -V\` / \`cargo -V\` / \`link.exe\` が通る
- [ ] Tauri v2 + React + TypeScript + Vite のスキャフォールド
- [ ] \`src-tauri\`（tauri.conf.json、capabilities 最小権限、コマンド 1 本）
- [ ] \`npm run tauri dev\` でウィンドウが開く
- [ ] \`npm run typecheck\` / \`cargo clippy\` が通る

## 完了条件
\`npm run tauri dev\` で空の画面が出て、React から Rust コマンド \`ping\` が呼べる。\`cargo build --release\` の初回ビルドが成功する。
`,
  },
  {
    n: 2,
    title: '索引: walkdir + rayon の走査と rusqlite スキーマ',
    body: `## 目的
作品フォルダを走査して SQLite に索引を作る。6.5 万ファイル規模を想定。

## 成果物
- [ ] \`rusqlite\`（bundled）導入、PLAN.md のスキーマでマイグレーション（WAL）
- [ ] \`walkdir\` + \`rayon\` で並列走査（UI を止めない = 別スレッド + event 通知）
- [ ] 5,000 件単位のバッチ UPSERT
- [ ] mtime / size による差分検出（再走査は差分のみ、目標 3 秒）
- [ ] ルートごとの「作品の単位」深さ（第 1 階層 / 第 2 階層 / フラット）
- [ ] 重複パス検出（\`volume serial + file index\`）で \`04_comfy_output\` のような同一実体を除外
- [ ] 進捗イベントを UI にストリーム（走査済み件数 / 総数）

## 完了条件
1 ルートの走査が完了し、作品数・ファイル数・合計サイズが Explorer の値と一致。再走査が 3 秒以内。
`,
  },
  {
    n: 3,
    title: 'サムネイル: image / ffmpeg で生成しキャッシュ',
    body: `## 目的
グリッド表示に必要なサムネイルを Rust 側で高速生成し、キャッシュする。

## 成果物
- [ ] 画像: \`image\` + \`webp\` crate で 512px WebP
- [ ] 動画: ffmpeg sidecar で 10% 地点のフレームを抽出（パスは設定可／既存の \`D:\\Projects\\08_media_tools\\media-tools\\bin\\ffmpeg.exe\` を既定候補に）
- [ ] キャッシュ先 \`%LOCALAPPDATA%\\works-browser\\thumbs\\<hash>.webp\`
- [ ] 元ファイルの mtime / size が変わったら再生成
- [ ] rayon で並列 8・キュー・中断可能
- [ ] 作品カバーは最初の動画 or 最初の画像から自動選択
- [ ] サムネ生成に失敗してもアプリは落ちない（プレースホルダ）

## 完了条件
1,000 ファイルの生成が 30 秒以内。再起動時はキャッシュヒットで 0 生成。
`,
  },
  {
    n: 4,
    title: 'ライブラリ画面: 作品グリッド（仮想スクロール・検索・ソート）',
    body: `## 目的
作品を一覧するメイン画面。

## 成果物
- [ ] カードグリッド（カバー・タイトル・ファイル数・サイズ・更新日）
- [ ] 仮想スクロール（1 万件でも 60fps）
- [ ] ソート: 更新日 / 名前 / サイズ / 評価
- [ ] 種類フィルタ: 動画あり / 画像のみ
- [ ] インクリメンタル検索（タイトル・パス、200ms 以内）
- [ ] 空状態・読み込み中・走査中の表示（進捗バー）

## 完了条件
6.5 万ファイル索引後にスクロールが滑らかで、検索結果が 200ms 以内に出る。
`,
  },
  {
    n: 5,
    title: '作品詳細: 画像ギャラリーと動画プレイヤー',
    body: `## 目的
作品を実際に「閲覧」する画面。

## 成果物
- [ ] ファイル一覧（サムネイル + 名前 + サイズ）
- [ ] 画像ギャラリー: ←→ 移動、ズーム、原寸表示、先読み
- [ ] 動画プレイヤー: シーク・速度・音量・次の動画へ
- [ ] Tauri asset protocol（Range 対応）で 10GB の mkv もシーク可
- [ ] 最後に見たファイルと再生位置を保存し、次回続きから
- [ ] キーボード操作（Space / ← / → / F / Esc）

## 完了条件
10GB の動画を開いてもメモリが増え続けず、シークが 1 秒以内に効く。
`,
  },
  {
    n: 6,
    title: 'タグ・評価・開封回数の記録',
    body: `## 目的
作品を分類し、よく見るものを上に出す。

## 成果物
- [ ] タグ CRUD、作品への付与、タグで絞り込み
- [ ] お気に入り・5 段階評価
- [ ] \`open_count\` / \`last_opened_at\` をアプリ側で記録（OS は回数を残さないため）
- [ ] 「最近見た」「よく見る」ビュー

## 完了条件
タグ付けした作品がライブラリから 1 クリックで絞り込める。
`,
  },
  {
    n: 7,
    title: 'フォルダ監視と差分更新（notify）',
    body: `## 目的
ファイルの追加・削除を再起動なしで反映する。

## 成果物
- [ ] \`notify\` + \`notify-debouncer-full\` で有効ルートを監視
- [ ] 追加 → 索引 + サムネ生成をキューに投入
- [ ] 削除 → 論理削除し、ライブラリから除外
- [ ] 大量変更時に通知をまとめる（1 秒デバウンス）
- [ ] ネットワークドライブ（L: など）は監視対象外にできる

## 完了条件
エクスプローラでファイルを追加すると 3 秒以内にライブラリへ出る。
`,
  },
  {
    n: 8,
    title: '設定: 監視ルート・深さ・除外パターン・キャッシュ管理',
    body: `## 目的
どのフォルダをどういう単位で対象にするかをユーザーが決められるようにする。

## 成果物
- [ ] ルートの追加・削除・有効/無効
- [ ] ルートごとの深さ（第 1 階層 / 第 2 階層 / フラット）
- [ ] 除外パターン（\`models\`, \`*.tmp\` など glob）
- [ ] 同じ実体を指すパス（ジャンクション / 重複コピー）の検出と警告
- [ ] サムネイル品質・キャッシュ上限・削除ボタン
- [ ] ffmpeg パスの自動検出と手動指定
- [ ] 設定は \`%APPDATA%\\works-browser\\config.json\` に保存

## 完了条件
ルートを追加すると走査が始まり、無効化するとライブラリから消える。
`,
  },
  {
    n: 9,
    title: '配布: tauri build で portable exe / MSI',
    body: `## 目的
この PC でダブルクリックで起動できる形にする。

## 成果物
- [ ] \`tauri build\` で NSIS と MSI の 2 ターゲット
- [ ] ffmpeg を sidecar として同梱（ライセンス表記も）
- [ ] アイコン・バージョン情報
- [ ] \`D:\\Projects\\works-browser\\works-browser.exe\` に配置する手順を README に記載
- [ ] バイナリ 15MB 以下（ffmpeg 除く）

## 完了条件
別のフォルダにコピーしても起動して索引が読める。
`,
  },
  {
    n: 10,
    title: '性能検証: 6.5 万ファイルでのスキャン・サムネ・表示',
    body: `## 目的
PLAN.md の非機能目標を実測で確認する。

## 計測項目
- [ ] 初回スキャン（約 65,000 ファイル / 66GB）: 目標 90 秒以内
- [ ] 再スキャン（差分）: 目標 3 秒以内
- [ ] サムネイル 1,000 枚: 目標 30 秒以内
- [ ] ライブラリ初回表示 200ms、スクロール 60fps
- [ ] 常駐メモリ 150MB 以下、起動 1 秒以内

結果はコメントに表で残す。
`,
  },
]

for (const it of issues) {
  run(['issue', 'edit', String(it.n), '--title', it.title, '--body', it.body])
  console.log('updated #' + it.n, it.title)
}
