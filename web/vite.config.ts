import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { configDefaults, defineConfig } from 'vitest/config'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte(), react()],
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
    rollupOptions: {
      input: {
        gitna: path.resolve(rootDir, 'index.html'),
        diffshub: path.resolve(rootDir, 'react.html'),
      },
    },
  },
})
