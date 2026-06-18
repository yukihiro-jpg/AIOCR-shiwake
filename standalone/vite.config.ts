import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'

// 実験用: 既存の src/ をそのまま再利用して単一HTMLを出力する。
// 元の Next.js アプリ（src/, package.json, next.config.js）には一切変更を加えない。
export default defineConfig({
  root: __dirname,
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      // 既存コンポーネントが使う "@/..." を元の src/ に解決する
      '@': path.resolve(__dirname, '../src'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // 単一HTML化のため動的 import もインライン化
    chunkSizeWarningLimit: 8000,
  },
})
