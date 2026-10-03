import path from 'node:path'
import { createRequire } from 'node:module'
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
  worker: {
    plugins: () => [
      {
        name: 'markdown-worker-entities',
        enforce: 'pre',
        resolveId(id, importer) {
          // The browser decoder needs document; workers must use the package's table decoder.
          if (id === 'decode-named-character-reference' && importer != null) {
            return createRequire(importer).resolve(id)
          }
        },
      },
    ],
  },
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
  },
})
