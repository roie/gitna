import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src/diffshub'),
      'next/link': path.resolve(rootDir, 'src/diffshub/vite/next.tsx'),
      'next/navigation': path.resolve(rootDir, 'src/diffshub/vite/next.tsx'),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    // Pierre's Shiki runtime and its dedicated worker are intentionally
    // shipped as self-contained chunks; splitting them would add runtime
    // requests without reducing the initial review payload.
    chunkSizeWarningLimit: 2000,
  },
})
