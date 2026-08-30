import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , versionArg, outputArg] = process.argv
const version = versionArg?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(version) || !outputArg) {
  throw new Error('usage: package-npm.mjs <version> <output>')
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(outputArg)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'gitna-npm-'))

/**
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} options
 */
function runNpm(args, options) {
  if (process.platform === 'win32') {
    return execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'npm.cmd', ...args],
      options,
    )
  }
  return execFileSync('npm', args, options)
}

function buildPackage() {
  mkdirSync(output, { recursive: true })
  const directory = join(temporaryRoot, 'gitna')
  cpSync(join(root, 'npm', 'gitna'), directory, { recursive: true })
  const manifestPath = join(directory, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid package manifest: ${manifestPath}`, {
      cause: error,
    })
  }
  manifest.version = version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  copyFileSync(join(root, 'LICENSE'), join(directory, 'LICENSE'))
  copyFileSync(join(root, 'README.md'), join(directory, 'README.md'))
  copyFileSync(join(root, 'THIRD_PARTY_LICENSES.txt'), join(directory, 'THIRD_PARTY_LICENSES.txt'))
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(directory, 'THIRD_PARTY_NOTICES.md'))
  cpSync(join(root, 'LICENSES'), join(directory, 'LICENSES'), {
    recursive: true,
  })
  chmodSync(join(directory, 'bin', 'gitna.js'), 0o755)
  runNpm(['pack', directory, '--ignore-scripts', '--pack-destination', output], {
    cwd: root,
    stdio: 'inherit',
  })
}

try {
  buildPackage()
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
