import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { targetFor } from './platform.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 */
export function cacheRootFor(platform, env, home) {
  const hostPath = platform === 'win32' ? win32 : posix
  if (env.GITNA_CACHE_DIR) return hostPath.resolve(env.GITNA_CACHE_DIR)
  if (platform === 'win32') {
    return hostPath.join(
      env.LOCALAPPDATA ?? hostPath.join(home, 'AppData', 'Local'),
      'Gitna',
      'Cache',
    )
  }
  if (platform === 'darwin') return hostPath.join(home, 'Library', 'Caches', 'gitna')
  return hostPath.join(env.XDG_CACHE_HOME ?? hostPath.join(home, '.cache'), 'gitna')
}

function defaultCacheRoot() {
  return cacheRootFor(process.platform, process.env, homedir())
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
 * @param {number} timeout
 */
async function download(fetchImpl, url, timeout) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) })
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
      execFileSync('tar', ['-xzf', archive, '-C', directory], {
        stdio: 'pipe',
      })
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
 * @property {number} [downloadTimeout]
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
  const downloadTimeout = options.downloadTimeout ?? 30_000
  if (!Number.isFinite(downloadTimeout) || downloadTimeout <= 0) {
    throw new Error('Download timeout must be a positive number')
  }

  const checksums = (
    await download(fetchImpl, `${releaseBase}/checksums.txt`, downloadTimeout)
  ).toString('utf8')
  const expected = checksumFor(checksums, target.asset)
  const archive = await download(fetchImpl, `${releaseBase}/${target.asset}`, downloadTimeout)
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
    const extractedEntries = await readdir(extractedDirectory, {
      withFileTypes: true,
    })
    for (const entry of extractedEntries) {
      if (entry.name === target.executable) continue
      await cp(join(extractedDirectory, entry.name), join(destinationDirectory, entry.name), {
        force: true,
        recursive: entry.isDirectory(),
      })
    }
    try {
      await rename(extracted, destination)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'EEXIST' && code !== 'EACCES') throw error
      const [winner, candidate] = await Promise.all([readFile(destination), readFile(extracted)])
      if (
        createHash('sha256').update(winner).digest('hex') !==
        createHash('sha256').update(candidate).digest('hex')
      ) {
        throw new Error('Concurrent Gitna installation produced an unexpected binary', { cause: error })
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
  return destination
}
