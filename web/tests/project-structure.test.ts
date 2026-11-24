import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'vite-plus'
import { expect, test } from 'vite-plus/test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sourceDir = 'web/src/'
const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const extensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json', '.d.ts']
const layers: Record<string, readonly string[]> = {
  app: ['features', 'components', 'repository', 'lib'],
  features: ['components', 'repository', 'lib'],
  repository: ['lib'],
  components: ['lib'],
  lib: [],
}
const crossFeatureImports = new Map<string, readonly string[]>()

function* imports(node: unknown): Generator<string> {
  if (Array.isArray(node)) {
    for (const child of node) yield* imports(child)
  } else if (node !== null && typeof node === 'object') {
    const { type, source, expression } = node as Record<string, unknown>
    const request = type === 'TSExternalModuleReference' ? expression : source
    if (
      (type === 'ImportDeclaration' ||
        type === 'ImportExpression' ||
        type === 'TSImportType' ||
        type === 'TSExternalModuleReference' ||
        type === 'ExportNamedDeclaration' ||
        type === 'ExportAllDeclaration') &&
      request != null &&
      typeof request === 'object' &&
      'value' in request &&
      typeof request.value === 'string'
    ) {
      yield request.value
    }
    for (const child of Object.values(node)) yield* imports(child)
  }
}

function allowedImport(from: string, to: string): boolean {
  if (to.startsWith('web/tests/fixtures/')) return /\.test\.tsx?$/.test(from)
  if (!to.startsWith(sourceDir)) return false
  const source = from.slice(sourceDir.length)
  const target = to.slice(sourceDir.length)
  if (source === 'main.tsx') return true
  const [sourceLayer, sourceFeature] = source.split('/')
  const [targetLayer, targetFeature] = target.split('/')
  if (sourceLayer === targetLayer) {
    return (
      sourceLayer !== 'features' ||
      sourceFeature === targetFeature ||
      (crossFeatureImports.get(source)?.includes(target) ?? false)
    )
  }
  return layers[sourceLayer]?.includes(targetLayer) ?? false
}

function checkImports(file: string, source: string, tracked: ReadonlySet<string>): string[] {
  const parsed = parseSync(file, source)
  const errors = parsed.errors.map((error) => `${file}: ${error.message}`)
  for (const specifier of new Set(imports(parsed.program))) {
    const request = specifier.split('?')[0]
    const path = request.startsWith('@/')
      ? posix.join(sourceDir, request.slice(2))
      : request.startsWith('./') || request.startsWith('../')
        ? posix.join(posix.dirname(file), request)
        : null
    if (path === null) continue
    const target = [
      path,
      ...extensions.map((ext) => `${path}${ext}`),
      ...extensions.map((ext) => `${path}/index${ext}`),
    ].find((candidate) => tracked.has(candidate))
    if (target === undefined) errors.push(`Unresolved import: ${file} → ${specifier}`)
    else if (!allowedImport(file, target)) errors.push(`Forbidden import: ${file} → ${target}`)
  }
  return errors
}

function checkStructure(files: readonly string[], read: (path: string) => string): string[] {
  const tracked = new Set(files)
  const pathsByCase = new Map<string, string>()
  const importNames = new Map<string, string>()
  const errors: string[] = []

  for (const file of files) {
    const otherPath = pathsByCase.get(file.toLowerCase())
    if (otherPath !== undefined) errors.push(`Case collision: ${otherPath} and ${file}`)
    pathsByCase.set(file.toLowerCase(), file)

    const parts = file.split('/')
    const name = parts.pop()!
    if (!file.startsWith(`${sourceDir}assets/`)) {
      if (
        !parts.every((part) => kebab.test(part)) ||
        (name !== 'LICENSE' &&
          name !== 'README.md' &&
          !name.split('.').every((part) => kebab.test(part)))
      ) {
        errors.push(`Expected kebab-case: ${file}`)
      }
    }
    if (name === 'index.ts') errors.push(`No index.ts: ${file}`)
    if (/\.tsx?$/.test(file)) {
      const importName = file.replace(/\.tsx?$/, '')
      const otherFile = importNames.get(importName)
      if (otherFile !== undefined) errors.push(`Shared import name: ${otherFile} and ${file}`)
      importNames.set(importName, file)
    }

    if (file.startsWith(sourceDir) && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) {
      errors.push(...checkImports(file, read(file), tracked))
    }
  }
  return errors
}

test('tracked web files follow the project layout', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'web/src', 'web/tests'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  expect(checkStructure(files, (file) => readFileSync(`${root}${file}`, 'utf8'))).toEqual([])
})

test('the layout check rejects a cross-feature import', () => {
  const from = 'web/src/features/explorer/explorer.tsx'
  const graph = 'web/src/features/graph/graph.tsx'
  const logo = 'web/src/features/conversations/agent-logos/claude.svg'
  const fixture: Record<string, string> = {
    [from]: "import '../graph/graph'; import '@/features/conversations/agent-logos/claude.svg?raw'",
    [graph]: '',
    [logo]: '',
  }
  expect(checkStructure(Object.keys(fixture), (file) => fixture[file])).toEqual([
    `Forbidden import: ${from} → ${graph}`,
    `Forbidden import: ${from} → ${logo}`,
  ])
})
