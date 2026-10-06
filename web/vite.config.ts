import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig, lazyPlugins } from 'vite-plus'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    printWidth: 100,
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    ignorePatterns: [
      'src/diffshub/components/**',
      'src/diffshub/lib/**',
      'src/diffshub/globals.css',
    ],
  },
  plugins: lazyPlugins(() => [react()]),
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
