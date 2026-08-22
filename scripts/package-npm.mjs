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

const [, , versionArg, target, binaryArg, outputArg, includeMainArg] = process.argv
const version = versionArg?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('usage: package-npm.mjs <version> <target> <binary> <output> [--main]')
}

const targets = new Map([
  ['linux-arm64', { packageName: 'gitna-linux-arm64', executable: 'gitna' }],
  ['linux-x64', { packageName: 'gitna-linux-x64', executable: 'gitna' }],
  ['win32-x64', { packageName: 'gitna-win32-x64', executable: 'gitna.exe' }],
])
const selected = target ? targets.get(target) : undefined
if (!selected || !binaryArg || !outputArg)
  throw new Error(`unsupported npm package target: ${target}`)
const selectedTarget = selected

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(outputArg)
const temporaryRoot = mkdtempSync(join(tmpdir(), 'gitna-npm-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** @param {string} directory */
function readManifest(directory) {
  const path = join(directory, 'package.json')
  try {
    return { path, manifest: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    throw new Error(`Invalid package manifest: ${path}`, { cause: error })
  }
}

/**
 * @param {string} directory
 * @param {string} packageVersion
 */
function setVersion(directory, packageVersion) {
  const { path, manifest } = readManifest(directory)
  manifest.version = packageVersion
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * @param {string} directory
 * @param {string} packageVersion
 */
function setMainVersion(directory, packageVersion) {
  const { path, manifest } = readManifest(directory)
  manifest.version = packageVersion
  for (const name of Object.keys(manifest.optionalDependencies)) {
    manifest.optionalDependencies[name] = packageVersion
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** @param {string} directory */
function pack(directory) {
  copyFileSync(join(root, 'LICENSE'), join(directory, 'LICENSE'))
  copyFileSync(join(root, 'README.md'), join(directory, 'README.md'))
  execFileSync(npm, ['pack', directory, '--pack-destination', output], {
    cwd: root,
    stdio: 'inherit',
  })
}

function buildPackages() {
  mkdirSync(output, { recursive: true })
  const platformDirectory = join(temporaryRoot, selectedTarget.packageName)
  cpSync(join(root, 'npm', selectedTarget.packageName), platformDirectory, {
    recursive: true,
  })
  setVersion(platformDirectory, version)
  const binaryDirectory = join(platformDirectory, 'bin')
  mkdirSync(binaryDirectory, { recursive: true })
  const packagedBinary = join(binaryDirectory, selectedTarget.executable)
  copyFileSync(resolve(binaryArg), packagedBinary)
  chmodSync(packagedBinary, 0o755)
  pack(platformDirectory)

  if (includeMainArg === '--main') {
    const mainDirectory = join(temporaryRoot, 'gitna')
    cpSync(join(root, 'npm', 'gitna'), mainDirectory, { recursive: true })
    setMainVersion(mainDirectory, version)
    chmodSync(join(mainDirectory, 'bin', 'gitna.js'), 0o755)
    pack(mainDirectory)
  }
}

try {
  buildPackages()
} catch (error) {
  rmSync(temporaryRoot, { recursive: true, force: true })
  throw error
}
rmSync(temporaryRoot, { recursive: true, force: true })
