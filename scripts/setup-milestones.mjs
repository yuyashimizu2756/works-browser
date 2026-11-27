// マイルストーン修正版: stdin を使わず -f 引数で渡す（Windows の stdin 文字コード問題を回避）
import { execFileSync } from 'node:child_process'

const repo = 'yuyashimizu2756/works-browser'
const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', env: { ...process.env, GH_PAGER: 'cat' } })

// 1) 既存を全部消す（番号だけ取得 = ASCII 安全）
const numbers = gh(['api', `repos/${repo}/milestones?state=all&per_page=100`, '--jq', '.[].number'])
  .trim()
  .split('\n')
  .filter(Boolean)
for (const n of numbers) {
  gh(['api', '-X', 'DELETE', `repos/${repo}/milestones/${n}`])
  console.log('deleted #' + n)
}

// 2) 正しい名前で作成（引数渡し）
const defs = [
  ['M0 環境', 'Rust / MSVC と Tauri スキャフォールド'],
  ['M1 基盤', '走査・索引・設定'],
  ['M2 閲覧', 'サムネイル・ライブラリ・詳細'],
  ['M3 管理', 'タグ・評価・フォルダ監視'],
  ['M4 仕上げ', '配布・性能検証'],
]
for (const [title, description] of defs) {
  const out = gh(['api', '-X', 'POST', `repos/${repo}/milestones`, '-f', `title=${title}`, '-f', `description=${description}`, '-f', 'state=open', '--jq', '.number'])
  console.log('created #' + out.trim(), title)
}

// 3) 割り当て
const assign = [
  [1, 'M0 環境'], [2, 'M1 基盤'], [8, 'M1 基盤'],
  [3, 'M2 閲覧'], [4, 'M2 閲覧'], [5, 'M2 閲覧'],
  [6, 'M3 管理'], [7, 'M3 管理'],
  [9, 'M4 仕上げ'], [10, 'M4 仕上げ'],
]
for (const [issue, ms] of assign) {
  gh(['issue', 'edit', String(issue), '--milestone', ms])
}

// 4) 検証（非ASCIIは \uXXXX で出すのでコンソール化けの影響を受けない）
const check = gh(['api', `repos/${repo}/milestones?state=open`, '--jq', '.[] | "\\(.number):\\(.title):\\(.open_issues)"'])
console.log(JSON.stringify(check))
