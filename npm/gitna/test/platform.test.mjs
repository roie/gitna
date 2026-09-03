import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cacheRootFor, ensureBinary } from '../lib/install.mjs'
import { targetFor } from '../lib/platform.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const apacheLicenseHash = '13d92be18d5ceac526f33cc96b6902a14d168f3e1d4b16be738f0fa70da7fe98'

test('keeps Gitna and the vendored Apache license identities distinct', async () => {
  const rootLicense = await readFile(join(repositoryRoot, 'LICENSE'), 'utf8')
  const vendoredLicense = await readFile(join(repositoryRoot, 'LICENSES', 'Apache-2.0.txt'))

  assert.match(rootLicense, /Copyright 2026 Roie Ambulo/)
  assert.doesNotMatch(rootLicense, /Copyright 2025 Pierre Computer Company/)
  const normalizedVendoredLicense = vendoredLicense.toString('utf8').replace(/\r\n?/g, '\n')
  assert.equal(
    createHash('sha256').update(normalizedVendoredLicense).digest('hex'),
    apacheLicenseHash,
  )
})

test('npm package includes canonical license and third-party notices', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gitna-package-test-'))
  const output = join(temporaryRoot, 'output')
  const extracted = join(temporaryRoot, 'extracted')
  try {
    execFileSync(
      process.execPath,
      [join(repositoryRoot, 'scripts', 'package-npm.mjs'), '0.0.0', output],
      { cwd: repositoryRoot, stdio: 'pipe' },
    )
    await mkdir(extracted)
    execFileSync('tar', ['-xzf', join(output, 'gitna-0.0.0.tgz'), '-C', extracted], {
      stdio: 'pipe',
    })

    for (const path of [
      'LICENSE',
      'THIRD_PARTY_LICENSES.txt',
      'THIRD_PARTY_NOTICES.md',
      join('LICENSES', 'Apache-2.0.txt'),
      join('LICENSES', 'MIT.txt'),
      join('LICENSES', 'OFL-1.1.txt'),
    ]) {
      assert.deepEqual(
        await readFile(join(extracted, 'package', path)),
        await readFile(join(repositoryRoot, path)),
      )
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('selects each native GitHub Release asset', () => {
  assert.deepEqual(targetFor('1.2.3', 'darwin', 'arm64'), {
    asset: 'gitna_1.2.3_darwin_arm64.tar.gz',
    executable: 'gitna',
  })
  assert.deepEqual(targetFor('1.2.3', 'darwin', 'x64'), {
    asset: 'gitna_1.2.3_darwin_x64.tar.gz',
    executable: 'gitna',
  })
  assert.deepEqual(targetFor('1.2.3', 'linux', 'x64'), {
    asset: 'gitna_1.2.3_linux_x64.tar.gz',
    executable: 'gitna',
  })
  assert.deepEqual(targetFor('1.2.3', 'linux', 'arm64'), {
    asset: 'gitna_1.2.3_linux_arm64.tar.gz',
    executable: 'gitna',
  })
  assert.deepEqual(targetFor('1.2.3', 'win32', 'x64'), {
    asset: 'gitna_1.2.3_windows_x64.zip',
    executable: 'gitna.exe',
  })
})

test('rejects unsupported targets clearly', () => {
  for (const [platform, arch] of [
    ['darwin', 'ia32'],
    ['freebsd', 'x64'],
    ['linux', 'ia32'],
    ['win32', 'arm64'],
  ]) {
    assert.throws(
      () => targetFor('1.2.3', /** @type {NodeJS.Platform} */ (platform), arch),
      new RegExp(`does not provide a native binary for ${platform}-${arch}`),
    )
  }
})

test('uses host-conventional cache roots', () => {
  assert.equal(cacheRootFor('darwin', {}, '/Users/roie'), '/Users/roie/Library/Caches/gitna')
  assert.equal(cacheRootFor('linux', {}, '/home/roie'), '/home/roie/.cache/gitna')
  assert.equal(
    cacheRootFor('linux', { XDG_CACHE_HOME: '/var/cache/roie' }, '/home/roie'),
    '/var/cache/roie/gitna',
  )
  assert.equal(
    cacheRootFor('win32', {}, 'C:\\Users\\roie'),
    'C:\\Users\\roie\\AppData\\Local\\Gitna\\Cache',
  )
  assert.equal(
    cacheRootFor('win32', { LOCALAPPDATA: 'D:\\Cache' }, 'C:\\Users\\roie'),
    'D:\\Cache\\Gitna\\Cache',
  )
  assert.equal(
    cacheRootFor('darwin', { GITNA_CACHE_DIR: '/tmp/gitna-cache' }, '/Users/roie'),
    '/tmp/gitna-cache',
  )
})

test('downloads, verifies, and caches the selected binary', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gitna-launcher-test-'))
  const archive = Buffer.from('archive')
  const binary = Buffer.from('#!/bin/sh\necho 1.2.3\n')
  const hash = createHash('sha256').update(archive).digest('hex')
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    if (request.url === '/checksums.txt') {
      response.end(`${hash}  gitna_1.2.3_linux_x64.tar.gz\n`)
      return
    }
    if (request.url === '/gitna_1.2.3_linux_x64.tar.gz') {
      response.end(archive)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to TCP')
  const releaseBase = `http://127.0.0.1:${address.port}`

  try {
    const options = {
      version: '1.2.3',
      platform: /** @type {NodeJS.Platform} */ ('linux'),
      arch: 'x64',
      cacheDir,
      releaseBase,
      extractImpl: async (
        /** @type {string} */ _archive,
        /** @type {string} */ directory,
        /** @type {{ executable: string }} */ target,
      ) => {
        await writeFile(join(directory, target.executable), binary)
        await writeFile(join(directory, 'LICENSE'), 'Gitna license\n')
        await writeFile(join(directory, 'THIRD_PARTY_NOTICES.md'), 'Notices\n')
        await writeFile(join(directory, 'THIRD_PARTY_LICENSES.txt'), 'Inventory\n')
        await mkdir(join(directory, 'LICENSES'))
        await writeFile(join(directory, 'LICENSES', 'Apache-2.0.txt'), 'Apache-2.0\n')
        await mkdir(join(directory, 'patches'))
        await writeFile(join(directory, 'patches', 'pierre.patch'), 'patch\n')
      },
    }
    const installed = await ensureBinary(options)
    assert.deepEqual(await readFile(installed), binary)
    const installedDirectory = dirname(installed)
    assert.equal(await readFile(join(installedDirectory, 'LICENSE'), 'utf8'), 'Gitna license\n')
    assert.equal(
      await readFile(join(installedDirectory, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      'Notices\n',
    )
    assert.equal(
      await readFile(join(installedDirectory, 'THIRD_PARTY_LICENSES.txt'), 'utf8'),
      'Inventory\n',
    )
    assert.equal(
      await readFile(join(installedDirectory, 'LICENSES', 'Apache-2.0.txt'), 'utf8'),
      'Apache-2.0\n',
    )
    assert.equal(
      await readFile(join(installedDirectory, 'patches', 'pierre.patch'), 'utf8'),
      'patch\n',
    )
    assert.equal(await ensureBinary(options), installed)
    assert.equal(requests, 2)
  } finally {
    server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('aborts and retries stalled downloads with a per-attempt deadline', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gitna-launcher-test-'))
  let attempts = 0
  const fetchImpl = (_url, options) => {
    attempts += 1
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  try {
    await assert.rejects(
      ensureBinary({
        version: '1.2.3',
        platform: 'linux',
        arch: 'x64',
        cacheDir,
        releaseBase: 'https://example.invalid',
        fetchImpl,
        downloadTimeout: 5,
      }),
      /timeout|aborted/i,
    )
    assert.equal(attempts, 3)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('rejects a binary whose checksum does not match', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'gitna-launcher-test-'))
  const server = createServer((request, response) => {
    if (request.url === '/checksums.txt') {
      response.end(`${'0'.repeat(64)}  gitna_1.2.3_linux_x64.tar.gz\n`)
      return
    }
    response.end('tampered')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to TCP')

  try {
    await assert.rejects(
      ensureBinary({
        version: '1.2.3',
        platform: 'linux',
        arch: 'x64',
        cacheDir,
        releaseBase: `http://127.0.0.1:${address.port}`,
      }),
      /Checksum verification failed/,
    )
  } finally {
    server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})
