import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { targetFor } from './platform.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function defaultCacheRoot() {
  if (process.env.GITNA_CACHE_DIR) return resolve(process.env.GITNA_CACHE_DIR)
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Gitna', 'Cache')
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'gitna')
}

async function packageVersion() {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error('Gitna npm package manifest is invalid', { cause: error })
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Gitna npm package has no version')
  }
  return manifest.version
}

/**
 * @param {string} checksums
 * @param {string} asset
 */
function checksumFor(checksums, asset) {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
    if (match?.[2] === asset) return match[1].toLowerCase()
  }
  throw new Error(`Release checksums do not include ${asset}`)
}

/**
 * @param {typeof globalThis.fetch} fetchImpl
 * @param {string} url
 */
async function download(fetchImpl, url) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  throw lastError
}

/**
 * @param {string} archive
 * @param {string} directory
 * @param {{ asset: string, executable: string }} target
 * @param {NodeJS.Platform} platform
 */
async function extractArchive(archive, directory, target, platform) {
  try {
    if (platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
          archive,
          directory,
        ],
        { stdio: 'pipe' },
      )
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'pipe' })
    }
  } catch (error) {
    throw new Error(`Could not extract ${target.asset}`, { cause: error })
  }
}

/**
 * @typedef {object} InstallOptions
 * @property {string} [version]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [arch]
 * @property {string} [cacheDir]
 * @property {string} [releaseBase]
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {typeof extractArchive} [extractImpl]
 */

/** @param {InstallOptions} [options] */
export async function ensureBinary(options = {}) {
  const version = options.version ?? (await packageVersion())
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = targetFor(version, platform, arch)
  const cacheRoot = resolve(options.cacheDir ?? defaultCacheRoot())
  const destination = join(cacheRoot, version, `${platform}-${arch}`, target.executable)

  try {
    await access(destination)
    return destination
  } catch {}

  const releaseBase =
    options.releaseBase ??
    process.env.GITNA_RELEASE_BASE ??
    `https://github.com/roie/gitna/releases/download/v${version}`
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('Gitna requires Node.js with fetch support')

  const checksums = (await download(fetchImpl, `${releaseBase}/checksums.txt`)).toString('utf8')
  const expected = checksumFor(checksums, target.asset)
  const archive = await download(fetchImpl, `${releaseBase}/${target.asset}`)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) throw new Error(`Checksum verification failed for ${target.asset}`)

  const destinationDirectory = dirname(destination)
  await mkdir(destinationDirectory, { recursive: true })
  const temporaryRoot = await mkdtemp(join(destinationDirectory, '.install-'))
  const archivePath = join(temporaryRoot, target.asset)
  const extractedDirectory = join(temporaryRoot, 'extracted')
  try {
    await writeFile(archivePath, archive)
    await mkdir(extractedDirectory)
    await (options.extractImpl ?? extractArchive)(archivePath, extractedDirectory, target, platform)
    const extracted = join(extractedDirectory, target.executable)
    await access(extracted)
    if (platform !== 'win32') await chmod(extracted, 0o755)
    try {
      await rename(extracted, destination)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'EEXIST' && code !== 'EACCES') throw error
      await access(destination)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return destination
}
