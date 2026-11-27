import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// フロントの単体テスト（#32）。CI は `npm run test:unit` = `vitest run`。
// 実データ / Tauri IPC には触れず、純粋ロジックと jsdom 上の React だけを検証する。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      // 目標は「純粋関数 80%」。React フック（use*.ts）は効果測定が別物なので除く。
      include: ['src/lib/**/*.ts'],
      exclude: ['src/lib/use*.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
})
