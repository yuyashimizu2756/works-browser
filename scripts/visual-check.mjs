#!/usr/bin/env node
/**
 * スクショ回帰（#32）。CI には載せないローカル専用スクリプト。
 *
 *   npm run visual:check
 *   npm run visual:check -- --size 1280x800
 *   npm run visual:check -- --size 1920x1080
 *
 * 1. `npm run build`（tsc + vite build）
 * 2. `vite preview` を起動
 * 3. headless Chrome でライブラリ / 作品詳細 / シールドを撮影
 * 4. `D:\Projects\visual\<name>.png` に保存し、前回の画像とピクセル差率を表示
 *    （2% を超えたら警告。`--strict` を付けると終了コード 1）
 *
 * #98: グリッドのカードは 4:3 で幅に追従するため、ライブラリのショットは
 * **1280×800 と 1920×1080 の 2 サイズ**を撮る（`--size` で片方だけにもできる）。
 *
 * 環境変数:
 * - `CHROME_PATH`      … Chrome / Edge の実行ファイル
 * - `VISUAL_OUT_DIR`   … 出力先（既定 `D:\Projects\visual`）
 * - `VISUAL_SIZE`      … `1280x800` / `1920x1080` / `all`（既定 all）
 * - `VISUAL_SKIP_BUILD=1` … ビルドを省略（dist をそのまま使う）
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = process.env.VISUAL_OUT_DIR ?? 'D:\\Projects\\visual'
const PORT = Number(process.env.VISUAL_PORT ?? 4173)
const BASE = `http://127.0.0.1:${PORT}`
const THRESHOLD = 0.02
const WIN = process.platform === 'win32'

/** 既定の撮影サイズ（#96 までのショットを引き継ぐ）。 */
const DEFAULT_SIZE = { name: '1440x900', width: 1440, height: 900 }
/** #98: グリッド検証用の 2 サイズ。1280 で 4 列 / 1920 で 6 列になる。 */
const GRID_SIZES = [
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1920x1080', width: 1920, height: 1080 },
]
/** #100: 空状態は 1280×800 の 1 サイズで揃える。 */
const EMPTY_SIZE = GRID_SIZES[0]

const SHOTS = [
  // サムネ非表示（既定）のプレースホルダと、実画像デモの両方を 2 サイズで撮る
  { name: 'library', path: '/?bench=24', sizes: GRID_SIZES },
  { name: 'library-demo', path: '/?bench=24&demo=1', sizes: GRID_SIZES },
  { name: 'detail', path: '/?bench=24&detail=3&thumbs=shown', sizes: [DEFAULT_SIZE] },
  { name: 'detail-demo', path: '/?bench=24&demo=1&detail=3', sizes: [DEFAULT_SIZE] },
  // #8: ライトボックスの上部バー / `⋯` メニュー / 生成情報パネル（ベンチの URL 指定）
  // #15: 可読性は 1440×900 / 1280×800 / 800×600 の 3 サイズで確認する
  {
    name: 'lightbox',
    path: '/?bench=24&demo=1&detail=3&thumbs=shown&lightbox=1',
    sizes: [
      DEFAULT_SIZE,
      { name: '1280x800', width: 1280, height: 800 },
      { name: '800x600', width: 800, height: 600 },
    ],
  },
  {
    name: 'lightbox-menu',
    path: '/?bench=24&demo=1&detail=3&thumbs=shown&lightbox=1&lightboxMenu=1',
    sizes: [DEFAULT_SIZE],
  },
  {
    name: 'lightbox-meta',
    path: '/?bench=24&demo=1&detail=3&thumbs=shown&lightbox=1&lightboxMeta=1',
    sizes: [DEFAULT_SIZE],
  },
  // #15: 動画プレイヤーのキー案内（Space / ←→ / Shift+←→ / Esc）
  {
    name: 'lightbox-video',
    path: '/?bench=24&demo=1&detail=3&thumbs=shown&lightbox=1&lightboxVideo=1',
    sizes: [DEFAULT_SIZE],
  },
  { name: 'shield', path: '/?bench=24&shield=1', sizes: [DEFAULT_SIZE] },
  // #116: ヘルプ（`?`）は 1280×800 でも最終行が切れず、下端のフェードで続きが分かる
  { name: 'help', path: '/?bench=24&thumbs=hidden&help=1', sizes: GRID_SIZES },
  // #100: 空状態 4 種（`?empty=` はベンチ時だけデータを差し替える）
  {
    name: 'empty-roots',
    path: '/?bench=24&empty=roots&thumbs=hidden',
    sizes: [EMPTY_SIZE],
  },
  {
    name: 'empty-smart',
    path: '/?bench=24&empty=smart&thumbs=hidden',
    sizes: [EMPTY_SIZE],
  },
  {
    name: 'empty-search',
    path: '/?bench=24&empty=search&thumbs=hidden',
    sizes: [EMPTY_SIZE],
  },
  {
    name: 'empty-thumbs',
    path: '/?bench=24&empty=thumbs&thumbs=shown',
    sizes: [EMPTY_SIZE],
  },
]

function log(message) {
  console.log(`[visual] ${message}`)
}

/**
 * `--size 1280x800` / `VISUAL_SIZE=1920x1080` を読む。
 * `all` / `both` / 未指定なら全サイズ（ライブラリは 2 サイズ）。
 */
function requestedSize(argv = process.argv.slice(2)) {
  const index = argv.findIndex((arg) => arg === '--size')
  const raw =
    index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith('--size='))?.slice(7)
  const value = (raw ?? process.env.VISUAL_SIZE ?? 'all').toLowerCase()
  if (value === 'all' || value === 'both' || value === '') return null
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value)
  if (!match) {
    throw new Error(
      `--size は 1280x800 / 1920x1080 / all のいずれかにしてください（受け取った値: ${value}）`,
    )
  }
  return { name: `${match[1]}x${match[2]}`, width: Number(match[1]), height: Number(match[2]) }
}

/** 複数サイズを持つショットだけ名前にサイズを付ける（既存の baseline を保つ）。 */
function shotFileName(shot, size) {
  return shot.sizes.length > 1 ? `${shot.name}-${size.name}` : shot.name
}


/** Windows では npm が .cmd なので cmd.exe 経由で起動する（shell:true の警告を避ける）。 */
function npmCommand(args) {
  if (WIN) {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `npm ${args.join(' ')}`],
    }
  }
  return { command: 'npm', args }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(
      'Chrome / Edge が見つかりません。CHROME_PATH に実行ファイルを指定してください。',
    )
  }
  return found
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${command} exited with ${code}\n${stderr || stdout}`))
    })
  })
}

async function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // まだ起動していない
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`${url} が ${timeoutMs}ms 以内に応答しませんでした`)
}

async function capture(chrome, url, target, profileDir, size) {
  await run(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${size.width},${size.height}`,
    '--virtual-time-budget=6000',
    `--user-data-dir=${profileDir}`,
    `--screenshot=${target}`,
    url,
  ])
  if (!existsSync(target)) throw new Error(`スクリーンショットが作られませんでした: ${target}`)
}

/** 異なるピクセルの割合（0〜1）。サイズが違えば 1。 */
function pixelDifference(previous, next) {
  if (previous.width !== next.width || previous.height !== next.height) return 1
  const dataA = previous.data
  const dataB = next.data
  let changed = 0
  for (let index = 0; index < dataA.length; index += 4) {
    if (
      Math.abs(dataA[index] - dataB[index]) > 8 ||
      Math.abs(dataA[index + 1] - dataB[index + 1]) > 8 ||
      Math.abs(dataA[index + 2] - dataB[index + 2]) > 8 ||
      Math.abs(dataA[index + 3] - dataB[index + 3]) > 8
    ) {
      changed += 1
    }
  }
  return changed / (previous.width * previous.height)
}

/** 差分を赤で塗った PNG を作る（目視確認用）。 */
function writeDiffImage(previous, next, path) {
  if (previous.width !== next.width || previous.height !== next.height) return
  const diff = new PNG({ width: next.width, height: next.height })
  for (let index = 0; index < next.data.length; index += 4) {
    const changed =
      Math.abs(previous.data[index] - next.data[index]) > 8 ||
      Math.abs(previous.data[index + 1] - next.data[index + 1]) > 8 ||
      Math.abs(previous.data[index + 2] - next.data[index + 2]) > 8
    diff.data[index] = changed ? 255 : next.data[index]
    diff.data[index + 1] = changed ? 0 : next.data[index + 1]
    diff.data[index + 2] = changed ? 0 : next.data[index + 2]
    diff.data[index + 3] = 255
  }
  return writeFile(path, PNG.sync.write(diff))
}

async function main() {
  const strict = process.argv.includes('--strict')
  const sizeFilter = requestedSize()
  const chrome = findChrome()
  log(`Chrome: ${chrome}`)
  log(`出力先: ${OUT_DIR}`)
  log(`撮影サイズ: ${sizeFilter ? sizeFilter.name : 'all（ライブラリは 1280×800 / 1920×1080）'}`)
  await mkdir(OUT_DIR, { recursive: true })

  if (process.env.VISUAL_SKIP_BUILD !== '1') {
    log('フロントをビルド中…')
    const build = npmCommand(['run', 'build'])
    await run(build.command, build.args, { cwd: ROOT })
  }

  const tempDir = join(tmpdir(), `works-browser-visual-${process.pid}`, 'shots')
  await mkdir(tempDir, { recursive: true })

  log('vite preview を起動中…')
  const preview = npmCommand([
    'run',
    'preview',
    '--',
    '--port',
    String(PORT),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ])
  const server = spawn(preview.command, preview.args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  server.stdout?.on('data', (chunk) => {
    serverLog += chunk
  })
  server.stderr?.on('data', (chunk) => {
    serverLog += chunk
  })

  const results = []
  try {
    await waitForServer(`${BASE}/`)
    for (const shot of SHOTS) {
      const sizes = sizeFilter
        ? shot.sizes.filter((size) => size.name === sizeFilter.name)
        : shot.sizes
      for (const size of sizes) {
        const name = shotFileName(shot, size)
        const target = join(OUT_DIR, `${name}.png`)
        const fresh = join(tempDir, `${name}.png`)
        log(`撮影: ${name} (${shot.path} @ ${size.width}×${size.height})`)
        // #100: ショットごとにプロファイルを分ける。同じプロファイルだと
        // localStorage（サムネ表示の保存値）が次のショットへ漏れ、撮影順で
        // 結果が変わってしまう。
        const profileDir = join(tempDir, `profile-${name}`)
        await capture(chrome, `${BASE}${shot.path}`, fresh, profileDir, size)

        if (!existsSync(target)) {
          await copyFile(fresh, target)
          results.push({ name, ratio: null })
          log(`  baseline を作成: ${target}`)
          continue
        }

        const previous = PNG.sync.read(await readFile(target))
        const next = PNG.sync.read(await readFile(fresh))
        const ratio = pixelDifference(previous, next)
        await writeDiffImage(previous, next, join(OUT_DIR, `${name}.diff.png`))
        await copyFile(target, join(OUT_DIR, `${name}.prev.png`))
        await copyFile(fresh, target)
        results.push({ name, ratio })
        const percent = (ratio * 100).toFixed(2)
        const mark = ratio > THRESHOLD ? 'WARN' : 'OK'
        log(`  ${mark} 差分 ${percent}%`)
      }
    }
  } finally {
    if (WIN) {
      await run('taskkill', ['/pid', String(server.pid), '/T', '/F']).catch(() => {})
    } else {
      server.kill('SIGTERM')
    }
    await rm(join(tmpdir(), `works-browser-visual-${process.pid}`), {
      recursive: true,
      force: true,
    }).catch(() => {})
  }

  if (results.length === 0) {
    throw new Error(`撮影対象がありません（--size ${sizeFilter?.name ?? ''} を確認してください）`)
  }

  const warned = results.filter((result) => result.ratio !== null && result.ratio > THRESHOLD)
  if (warned.length > 0) {
    console.warn(
      `[visual] ${warned.length} 枚が ${THRESHOLD * 100}% を超えました: ` +
        warned.map((result) => `${result.name} ${(result.ratio * 100).toFixed(2)}%`).join(', '),
    )
    if (strict) process.exitCode = 1
  } else {
    log('すべて閾値内です')
  }
  if (serverLog.includes('error')) log(`preview: ${serverLog.trim().split('\n').slice(-3).join(' / ')}`)
}

main().catch((error) => {
  console.error(`[visual] 失敗: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
