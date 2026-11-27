import { createReadStream, existsSync, rmSync, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

const DEMO_DIR = fileURLToPath(new URL('./public/demo', import.meta.url))
const DIST_DEMO_DIR = fileURLToPath(new URL('./dist/demo', import.meta.url))

/**
 * #97: デザイン検証用のデモ画像（`public/demo/*.svg`）は製品ビルドに含めない。
 *
 * public 配下は Vite が dist へコピーするため、ビルド完了時に `dist/demo` を消す。
 * ただし `npm run visual:check` は dist を `vite preview` で配信するので、
 * preview の間だけ public/demo から直接返す（dev は publicDir がそのまま配信する）。
 * アプリ側は `?bench=N&demo=1` のときだけ `/demo/*.svg` を取得する。
 */
function demoAssetsOutsideDist(): Plugin {
  return {
    name: 'works-browser-demo-assets',
    closeBundle() {
      rmSync(DIST_DEMO_DIR, { recursive: true, force: true })
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '').split('?')[0]
        if (!pathname.startsWith('/demo/')) {
          next()
          return
        }
        const file = resolve(DEMO_DIR, decodeURIComponent(pathname.slice('/demo/'.length)))
        if (
          !file.startsWith(DEMO_DIR + sep) ||
          extname(file) !== '.svg' ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          response.statusCode = 404
          response.end('Not found')
          return
        }
        response.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
        response.setHeader('Cache-Control', 'no-store')
        createReadStream(file).pipe(response)
      })
    },
  }
}

// Tauri は devUrl で固定ポートを参照するため、1420 を厳格に使う
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss(), demoAssetsOutsideDist()],
  resolve: {
    alias: {
      // shadcn/ui の生成物が使う `@/` を src へ向ける
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
