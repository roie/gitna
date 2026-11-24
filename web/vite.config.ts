import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig, lazyPlugins, type Plugin } from 'vite-plus'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const compressedExtensions = new Set(['.js', '.css', '.html', '.svg', '.json', '.map', '.txt'])

function gzipOutput(): Plugin {
  let outDir = ''
  return {
    name: 'gzip-output',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !compressedExtensions.has(path.extname(entry.name))) continue
        const file = path.join(entry.parentPath, entry.name)
        writeFileSync(`${file}.gz`, gzipSync(readFileSync(file), { level: 9 }))
        rmSync(file)
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    },
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    printWidth: 100,
    singleQuote: true,
    semi: false,
    trailingComma: 'all',
    ignorePatterns: [
      'src/app/scrollbar-gutter.tsx',
      'src/app/sidebar.tsx',
      'src/app/workbench-header.tsx',
      'src/app/worker-pool.tsx',
      'src/components/tree.tsx',
      'src/components/ui/button-styles.ts',
      'src/components/ui/button.tsx',
      'src/components/ui/dialog.tsx',
      'src/components/ui/dropdown-menu.tsx',
      'src/components/ui/input.tsx',
      'src/components/ui/loading.tsx',
      'src/components/ui/switch.tsx',
      'src/components/ui/tooltip.tsx',
      'src/features/conversations/annotation.ts',
      'src/features/conversations/conversation-card.tsx',
      'src/features/conversations/conversation-list.tsx',
      'src/features/conversations/draft-comment.tsx',
      'src/features/viewer/review-data.ts',
      'src/features/viewer/review-status.tsx',
      'src/features/viewer/viewer.tsx',
      'src/lib/cn.ts',
      'src/lib/code-view.ts',
      'src/lib/git-status.ts',
      'src/lib/gutter-detector.ts',
      'src/lib/review-types.ts',
      'src/lib/theme/chrome-tokens.ts',
      'src/lib/theme/theme-names.ts',
      'src/lib/theme/theme-root.tsx',
      'src/lib/tree-source.ts',
      'src/styles/globals.css',
    ],
  },
  plugins: lazyPlugins(() => [react(), gzipOutput()]),
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
  },
})
