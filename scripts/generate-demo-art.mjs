#!/usr/bin/env node
/**
 * デザイン検証用のデモ画像（#97）を生成する。
 *
 *   node scripts/generate-demo-art.mjs
 *
 * `public/demo/*.svg` に抽象アート風の SVG を書き出す。写真の代わりに
 * バッジ・コントラスト・余白を評価できるよう、暗い / 明るい / 高彩度 /
 * モノクロ / 縦長 / 横長を混ぜている。実行は決定的（乱数はシード固定）で、
 * 何度走らせても同じバイト列になる。
 *
 * 生成物は QA 専用で、`npm run build` の dist には含めない
 * （`vite.config.ts` の `demoAssetsOutsideDist` を参照）。
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'demo')

/** 決定的な擬似乱数（Mulberry32）。 */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round = (value) => Math.round(value * 10) / 10

/**
 * mode: dark（暗部主体）/ light（ハイキー）/ mono（無彩色）/ vivid（高彩度）
 * hard: bands / blocks / lines / orbit / horizon / none
 */
const RECIPES = [
  {
    file: '01-night-orbit.svg', w: 1600, h: 900, seed: 1,
    label: '夜の軌道', mode: 'dark', hard: 'orbit',
    bg: ['#04070f', '#0a1730', '#17395f'], colors: ['#ff8a3d', '#5ad1ff', '#ffe3b0'],
    count: 8, grain: 0.1, vignette: 0.6,
  },
  {
    file: '02-morning-paper.svg', w: 1500, h: 1000, seed: 2,
    label: '朝の紙', mode: 'light', hard: 'none',
    bg: ['#fbf7f0', '#f3ead9', '#e9dcc6'], colors: ['#e7b9a3', '#b9d6c8', '#f2d98c'],
    count: 7, grain: 0.07, vignette: 0.18,
  },
  {
    file: '03-graphite-slabs.svg', w: 1200, h: 1200, seed: 3,
    label: '黒鉛の板', mode: 'mono', hard: 'blocks',
    bg: ['#0d0d0f', '#202024', '#3a3a40'], colors: ['#f2f2f4', '#8a8a92', '#c9c9cf'],
    count: 5, grain: 0.12, vignette: 0.5,
  },
  {
    file: '04-magenta-tide.svg', w: 1000, h: 1250, seed: 4,
    label: 'マゼンタの潮流', mode: 'vivid', hard: 'none',
    bg: ['#2b0538', '#6a0f6b', '#0b6a86'], colors: ['#ff2e88', '#00e5ff', '#ffd166'],
    count: 9, grain: 0.09, vignette: 0.35,
  },
  {
    file: '05-forest-mist.svg', w: 1000, h: 1500, seed: 5,
    label: '森の霧', mode: 'dark', hard: 'horizon',
    bg: ['#07120f', '#133026', '#2c5340'], colors: ['#7fbf9a', '#c9e6cf', '#d8b26a'],
    count: 7, grain: 0.1, vignette: 0.55,
  },
  {
    file: '06-dune-sunset.svg', w: 1600, h: 900, seed: 6,
    label: '砂丘の夕暮れ', mode: 'vivid', hard: 'horizon',
    bg: ['#2a0b25', '#8c2f3f', '#f07845'], colors: ['#ffd08a', '#ff6a3d', '#7a1f4d'],
    count: 6, grain: 0.08, vignette: 0.4,
  },
  {
    file: '07-neon-wire.svg', w: 1920, h: 820, seed: 7,
    label: 'ネオンワイヤー', mode: 'dark', hard: 'lines',
    bg: ['#04060a', '#0a1018', '#101a26'], colors: ['#2ef2c0', '#ff3d9a', '#6a8cff'],
    count: 6, grain: 0.1, vignette: 0.65,
  },
  {
    file: '08-bauhaus-day.svg', w: 1500, h: 1000, seed: 8,
    label: 'バウハウスの昼', mode: 'light', hard: 'blocks',
    bg: ['#f7f4ec', '#efe9db', '#e4dcc9'], colors: ['#d33f2f', '#22508c', '#e8b21f'],
    count: 4, grain: 0.05, vignette: 0.15,
  },
  {
    file: '09-rust-cells.svg', w: 1200, h: 1200, seed: 9,
    label: '錆の細胞', mode: 'vivid', hard: 'orbit',
    bg: ['#101b1b', '#1e3f3c', '#6d3a20'], colors: ['#c96a2c', '#3fb6a8', '#e8d5a8'],
    count: 10, grain: 0.11, vignette: 0.45,
  },
  {
    file: '10-violet-veil.svg', w: 1000, h: 1250, seed: 10,
    label: '紫のヴェール', mode: 'dark', hard: 'none',
    bg: ['#0b0718', '#221244', '#3d2470'], colors: ['#a77bff', '#ff9ad5', '#6fd0ff'],
    count: 9, grain: 0.1, vignette: 0.55,
  },
  {
    file: '11-olive-horizon.svg', w: 1600, h: 900, seed: 11,
    label: 'オリーブの地平', mode: 'light', hard: 'horizon',
    bg: ['#f0ece0', '#d8d3bd', '#a8a687'], colors: ['#7d8060', '#c9b98a', '#f6f1e2'],
    count: 5, grain: 0.06, vignette: 0.2,
  },
  {
    file: '12-slate-lines.svg', w: 1500, h: 1000, seed: 12,
    label: 'スレートの線', mode: 'mono', hard: 'lines',
    bg: ['#1b2026', '#2d353d', '#48525c'], colors: ['#e6ebef', '#9aa6b0', '#65707a'],
    count: 6, grain: 0.09, vignette: 0.4,
  },
  {
    file: '13-ember-spiral.svg', w: 1000, h: 1500, seed: 13,
    label: '残り火の渦', mode: 'vivid', hard: 'orbit',
    bg: ['#0a0504', '#2c0b07', '#6b1a0a'], colors: ['#ff5a1f', '#ffc14d', '#ff2d2d'],
    count: 10, grain: 0.12, vignette: 0.6,
  },
  {
    file: '14-ink-wash.svg', w: 1400, h: 1050, seed: 14,
    label: '淡い墨', mode: 'light', hard: 'none',
    bg: ['#f7fafc', '#e8f0f4', '#cfe0e8'], colors: ['#5f7d8c', '#a9c4cf', '#2d3f4a'],
    count: 8, grain: 0.08, vignette: 0.2,
  },
  {
    file: '15-electric-cut.svg', w: 1600, h: 1000, seed: 15,
    label: 'エレクトリック・カット', mode: 'vivid', hard: 'bands',
    bg: ['#04121f', '#0a2f4d', '#12667a'], colors: ['#b6ff2e', '#2ee6ff', '#ff3d6e'],
    count: 6, grain: 0.07, vignette: 0.35,
  },
  {
    file: '16-sepia-arches.svg', w: 900, h: 1200, seed: 16,
    label: 'セピアのアーチ', mode: 'dark', hard: 'bands',
    bg: ['#140f0a', '#3a2a1c', '#6b5238'], colors: ['#d8b98c', '#f2e0c2', '#8c6a45'],
    count: 5, grain: 0.13, vignette: 0.55,
  },
]

function gradientStops(colors) {
  return colors
    .map((color, index) => {
      const offset = round((index / Math.max(1, colors.length - 1)) * 100)
      return `<stop offset="${offset}%" stop-color="${color}"/>`
    })
    .join('')
}

function softShapes(recipe, random) {
  const { w, h, colors, count, mode } = recipe
  const blend = mode === 'light' ? 'multiply' : 'screen'
  const shapes = []
  for (let index = 0; index < count; index += 1) {
    const color = colors[index % colors.length]
    const cx = round(random() * w)
    const cy = round(random() * h)
    const rx = round(w * (0.1 + random() * 0.34))
    const ry = round(h * (0.08 + random() * 0.3))
    const rotate = round(random() * 180)
    const opacity = round(0.28 + random() * 0.5)
    shapes.push(
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${color}" ` +
        `opacity="${opacity}" transform="rotate(${rotate} ${cx} ${cy})"/>`,
    )
  }
  return `<g filter="url(#soft)" style="mix-blend-mode:${blend}">${shapes.join('')}</g>`
}

function hardShapes(recipe, random) {
  const { w, h, hard, colors } = recipe
  const ink = colors[0]
  const ink2 = colors[colors.length - 1]
  if (hard === 'bands') {
    const bands = []
    for (let index = 0; index < 6; index += 1) {
      const y = round(h * (index / 6) + h * 0.03)
      const thickness = round(h * (0.015 + random() * 0.04))
      bands.push(
        `<rect x="${round(-w * 0.1)}" y="${y}" width="${round(w * 1.2)}" height="${thickness}" ` +
          `fill="${index % 2 === 0 ? ink : ink2}" opacity="${round(0.12 + random() * 0.35)}" ` +
          `transform="rotate(${round(-8 + random() * 16)} ${w / 2} ${h / 2})"/>`,
      )
    }
    return `<g>${bands.join('')}</g>`
  }
  if (hard === 'blocks') {
    const blocks = []
    for (let index = 0; index < 7; index += 1) {
      const bw = round(w * (0.08 + random() * 0.3))
      const bh = round(h * (0.06 + random() * 0.28))
      const bx = round(random() * (w - bw))
      const by = round(random() * (h - bh))
      const color = colors[(index + 1) % colors.length]
      blocks.push(
        `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${color}" ` +
          `opacity="${round(0.45 + random() * 0.5)}"/>`,
      )
    }
    return `<g>${blocks.join('')}</g>`
  }
  if (hard === 'lines') {
    const lines = []
    for (let index = 0; index < 14; index += 1) {
      const x1 = round(random() * w)
      const y1 = round(random() * h)
      const x2 = round(x1 + (random() - 0.5) * w * 0.9)
      const y2 = round(y1 + (random() - 0.5) * h * 0.9)
      const color = colors[index % colors.length]
      lines.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ` +
          `stroke-width="${round(0.8 + random() * 3)}" opacity="${round(0.18 + random() * 0.5)}"/>`,
      )
    }
    return `<g>${lines.join('')}</g>`
  }
  if (hard === 'orbit') {
    const rings = []
    for (let index = 0; index < 5; index += 1) {
      const cx = round(w * (0.2 + random() * 0.6))
      const cy = round(h * (0.2 + random() * 0.6))
      const r = round(Math.min(w, h) * (0.12 + random() * 0.34))
      rings.push(
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[index % colors.length]}" ` +
          `stroke-width="${round(1 + random() * 4)}" opacity="${round(0.25 + random() * 0.45)}"/>`,
      )
    }
    const dot = round(Math.min(w, h) * (0.03 + random() * 0.05))
    rings.push(
      `<circle cx="${round(w * 0.68)}" cy="${round(h * 0.34)}" r="${dot}" ` +
        `fill="${colors[0]}" opacity="0.85"/>`,
    )
    return `<g>${rings.join('')}</g>`
  }
  if (hard === 'horizon') {
    const y = round(h * (0.55 + random() * 0.16))
    return (
      `<rect x="0" y="${y}" width="${w}" height="${round(h - y)}" fill="${ink2}" opacity="0.16"/>` +
      `<rect x="0" y="${y}" width="${w}" height="${round(h * 0.012)}" fill="${ink}" opacity="0.4"/>`
    )
  }
  return ''
}

function buildSvg(recipe) {
  const { w, h, seed, label, bg, grain, vignette, hard } = recipe
  const random = rng(seed * 9973 + 17)
  const grainFrequency = round(0.6 + random() * 0.5)
  const soft = softShapes(recipe, random)
  const hardLayer = hard === 'none' ? '' : hardShapes(recipe, random)
  const rotation = hard === 'bands' || hard === 'lines' ? 0 : round((random() - 0.5) * 8)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `role="img" aria-label="${label}">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">${gradientStops(bg)}</linearGradient>` +
    `<radialGradient id="vig" cx="50%" cy="48%" r="72%">` +
    `<stop offset="55%" stop-color="#000000" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="#000000" stop-opacity="${vignette}"/>` +
    `</radialGradient>` +
    `<filter id="soft" x="-25%" y="-25%" width="150%" height="150%">` +
    `<feGaussianBlur stdDeviation="${round(Math.min(w, h) * 0.055)}"/>` +
    `</filter>` +
    `<filter id="grain">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${grainFrequency}" numOctaves="3" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/>` +
    `</filter>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>` +
    `<g transform="rotate(${rotation} ${w / 2} ${h / 2})">${soft}${hardLayer}</g>` +
    `<rect width="${w}" height="${h}" filter="url(#grain)" opacity="${grain}"/>` +
    `<rect width="${w}" height="${h}" fill="url(#vig)"/>` +
    `</svg>`
  )
}

mkdirSync(OUT_DIR, { recursive: true })
for (const name of readdirSync(OUT_DIR)) {
  if (name.endsWith('.svg')) rmSync(join(OUT_DIR, name))
}

let total = 0
for (const recipe of RECIPES) {
  const svg = buildSvg(recipe)
  const path = join(OUT_DIR, recipe.file)
  writeFileSync(path, `${svg}\n`)
  total += statSync(path).size
}

console.log(`[demo] ${RECIPES.length} 枚を ${OUT_DIR} に生成しました（合計 ${(total / 1024).toFixed(1)} KB）`)
