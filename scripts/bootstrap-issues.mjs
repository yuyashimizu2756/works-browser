// 一度だけ実行する Issue ブートストラップ（UTF-8 で gh を叩くため Node 経由）
import { execFileSync } from 'node:child_process'

const run = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_PAGER: 'cat' } })

const labels = [
  ['type:feat', '0e8a16', '機能追加'],
  ['type:task', '1d76db', '作業'],
  ['type:decision', 'd93f0b', '判断待ち'],
  ['area:core', '5319e7', 'Electron 基盤'],
  ['area:index', 'bfd4f2', '走査・索引'],
  ['area:media', 'fbca04', 'サムネイル・再生'],
  ['area:ui', 'c5def5', '画面'],
  ['m1', 'ededed', 'M1 基盤'],
  ['m2', 'ededed', 'M2 閲覧'],
  ['m3', 'ededed', 'M3 管理'],
  ['m4', 'ededed', 'M4 仕上げ'],
]

for (const [name, color, desc] of labels) {
  try {
    run(['label', 'create', name, '--color', color, '--description', desc, '--force'])
  } catch (e) {
    console.error('label failed:', name, e.message)
  }
}

const issues = [
  {
    title: '基盤: Electron + React + TypeScript のスキャフォールド',
    labels: ['type:task', 'area:core', 'm1'],
    body: `## 目的
アプリの土台を作る。以後の Issue はすべてこの構成の上に載る。

## 成果物
- [ ] \`package.json\`（electron / electron-builder / vite / react / typescript / tailwind）
- [ ] \`src/main\`（BrowserWindow、セキュリティ設定: contextIsolation 有効・nodeIntegration 無効）
- [ ] \`src/preload\`（型付き IPC を contextBridge で公開）
- [ ] \`src/renderer\`（React + Vite、空のライブラリ画面）
- [ ] \`npm run dev\` でウィンドウが開く
- [ ] \`npm run typecheck\` / \`npm run lint\` が通る

## 完了条件
\`npm run dev\` で空の画面が出て、renderer から \`window.api.ping()\` が呼べる。
`,
  },
  {
    title: '索引: フォルダ走査と SQLite スキーマ',
    labels: ['type:feat', 'area:index', 'm1'],
    body: `## 目的
作品フォルダを走査して SQLite に索引を作る。4 万ファイル規模を想定。

## 成果物
- [ ] \`better-sqlite3\` 導入、PLAN.md のスキーマでマイグレーション
- [ ] 走査は worker_threads で実行（UI を止めない）
- [ ] 5,000 件単位のバッチ insert（WAL モード）
- [ ] mtime / size による差分検出（再走査は差分のみ）
- [ ] ルート配下の第 1 階層ディレクトリを「作品」として扱う（設定で深さ変更可）
- [ ] 進捗イベントを renderer にストリーム

## 完了条件
1 ルートの走査が完了し、作品数・ファイル数・合計サイズが DB と一致する。再走査が 10 秒以内。
`,
  },
  {
    title: 'サムネイル: 画像/動画のサムネイル生成とキャッシュ',
    labels: ['type:feat', 'area:media', 'm2'],
    body: `## 目的
グリッド表示に必要なサムネイルを生成し、キャッシュする。

## 成果物
- [ ] 画像: sharp で 512px WebP 生成
- [ ] 動画: 既存 ffmpeg バイナリで 10% 地点のフレームを抽出（設定でパス変更可）
- [ ] キャッシュ先 \`%LOCALAPPDATA%\\works-browser\\thumbs\\<hash>.webp\`
- [ ] 元ファイルの mtime / size が変わったら再生成
- [ ] 並列 4・キュー・中断可能（画面を閉じても安全）
- [ ] 作品カバーは最初の動画 or 最初の画像から自動選択

## 完了条件
1,000 ファイルのサムネイル生成が 60 秒以内。再起動時にキャッシュヒットで 0 生成。
`,
  },
  {
    title: 'ライブラリ画面: 作品グリッド（仮想スクロール・検索・ソート）',
    labels: ['type:feat', 'area:ui', 'm2'],
    body: `## 目的
作品を一覧するメイン画面。

## 成果物
- [ ] カードグリッド（カバー・タイトル・ファイル数・サイズ・更新日）
- [ ] 仮想スクロール（1 万件でも 60fps）
- [ ] ソート: 更新日 / 名前 / サイズ / 評価
- [ ] 種類フィルタ: 動画あり / 画像のみ
- [ ] インクリメンタル検索（タイトル・パス）
- [ ] 空状態・読み込み中・走査中の表示

## 完了条件
4 万ファイル索引後にスクロールが滑らかで、検索結果が 200ms 以内に出る。
`,
  },
  {
    title: '作品詳細: 画像ギャラリーと動画プレイヤー',
    labels: ['type:feat', 'area:ui', 'm2'],
    body: `## 目的
作品を実際に「閲覧」する画面。

## 成果物
- [ ] ファイル一覧（サムネイル + 名前 + サイズ）
- [ ] 画像ギャラリー: ←→ 移動、ズーム、原寸表示、連続読込
- [ ] 動画プレイヤー: シーク・速度・音量・次の動画へ
- [ ] \`media://\` カスタムプロトコルで Range 配信（大きな mkv でもシーク可）
- [ ] 最後に見たファイルと再生位置を保存し、次回続きから
- [ ] キーボード操作（Space / ← / → / F / Esc）

## 完了条件
10GB の動画を開いてもメモリが増え続けず、シークが 1 秒以内に効く。
`,
  },
  {
    title: 'タグ・評価・開封回数の記録',
    labels: ['type:feat', 'area:index', 'm3'],
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
    title: 'フォルダ監視と差分更新',
    labels: ['type:feat', 'area:index', 'm3'],
    body: `## 目的
ファイルの追加・削除を再起動なしで反映する。

## 成果物
- [ ] chokidar で有効ルートを監視（depth 制限・デバウンス）
- [ ] 追加 → 索引 + サムネ生成をキューに投入
- [ ] 削除 → 論理削除し、ライブラリから除外
- [ ] 大量変更時に通知をまとめる（1 秒デバウンス）

## 完了条件
エクスプローラでファイルを追加すると 3 秒以内にライブラリへ出る。
`,
  },
  {
    title: '設定: 監視ルート・除外パターン・キャッシュ管理',
    labels: ['type:feat', 'area:core', 'm1'],
    body: `## 目的
どのフォルダを対象にするかをユーザーが決められるようにする。

## 成果物
- [ ] ルートの追加・削除・有効/無効
- [ ] 除外パターン（\`node_modules\`, \`*.tmp\` など glob）
- [ ] サムネイル品質・キャッシュ上限・削除ボタン
- [ ] ffmpeg パスの自動検出と手動指定
- [ ] 設定は \`%APPDATA%\\works-browser\\config.json\` に保存

## 完了条件
ルートを追加すると走査が始まり、無効化するとライブラリから消える。
`,
  },
  {
    title: '配布: portable exe のビルド',
    labels: ['type:task', 'area:core', 'm4'],
    body: `## 目的
この PC でダブルクリックで起動できる形にする。

## 成果物
- [ ] electron-builder で portable ターゲット
- [ ] ffmpeg バイナリを同梱（またはパス指定）
- [ ] アイコン・バージョン情報
- [ ] \`D:\\Projects\\works-browser\\works-browser.exe\` に配置する手順を README に記載

## 完了条件
別のフォルダにコピーしても起動して索引が読める。
`,
  },
  {
    title: '性能検証: 4 万ファイルでのスキャン・サムネ・表示',
    labels: ['type:task', 'area:index', 'm4'],
    body: `## 目的
PLAN.md の非機能目標を実測で確認する。

## 計測項目
- [ ] 初回スキャン（41,855 ファイル）: 目標 3 分以内
- [ ] 再スキャン: 目標 10 秒以内
- [ ] サムネイル 1,000 枚: 目標 60 秒以内
- [ ] ライブラリ初回表示 300ms、スクロール 60fps
- [ ] 常駐メモリ 400MB 以下

結果はコメントに表で残す。
`,
  },
]

const created = []
for (const it of issues) {
  const args = ['issue', 'create', '--title', it.title, '--body', it.body]
  for (const l of it.labels) args.push('--label', l)
  const out = run(args).trim()
  created.push({ title: it.title, url: out })
  console.log('#' + out.split('/').pop(), it.title)
}

console.log('\n' + created.map((c) => c.url).join('\n'))
