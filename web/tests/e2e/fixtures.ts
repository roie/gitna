/// <reference types="node" />

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test as base, expect } from '@playwright/test'

export interface GitnaFixture {
  url: string
  origin: string
  token: string
  repo: string
  baseOid: string
  headOid: string
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function numbered(changes: Record<number, string> = {}): string {
  return (
    Array.from({ length: 60 }, (_, index) => changes[index + 1] ?? `line ${index + 1}`).join('\n') +
    '\n'
  )
}

function createRepository(root: string): { repo: string; baseOid: string; headOid: string } {
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'e2e@example.com')
  git(repo, 'config', 'user.name', 'Gitna E2E')

  writeFileSync(join(repo, 'modified.txt'), 'base\n')
  writeFileSync(join(repo, 'staged.txt'), 'base\n')
  writeFileSync(join(repo, 'rename-old.txt'), 'rename me\n')
  writeFileSync(join(repo, 'delete.txt'), 'delete me\n')
  writeFileSync(join(repo, 'two-hunk.txt'), numbered())
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  writeFileSync(join(repo, 'main.txt'), 'main base\n')
  writeFileSync(join(repo, 'feature.txt'), 'feature base\n')
  git(repo, 'add', '--', '.')
  git(repo, 'commit', '-qm', 'base fixture')
  const baseOid = git(repo, 'rev-parse', 'HEAD')

  git(repo, 'switch', '-qc', 'feature')
  writeFileSync(join(repo, 'feature.txt'), 'feature branch\n')
  git(repo, 'add', '--', 'feature.txt')
  git(repo, 'commit', '-qm', 'feature change')

  git(repo, 'switch', '-q', 'main')
  writeFileSync(join(repo, 'main.txt'), 'main branch\n')
  git(repo, 'add', '--', 'main.txt')
  git(repo, 'commit', '-qm', 'main change')
  git(repo, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature')
  git(repo, 'tag', 'v1')
  const headOid = git(repo, 'rev-parse', 'HEAD')

  git(root, 'init', '-q', '--bare', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(repo, 'push', '-q', 'origin', 'feature', '--tags')

  writeFileSync(join(repo, 'modified.txt'), 'unstaged change\n')
  writeFileSync(join(repo, 'staged.txt'), 'staged change\n')
  git(repo, 'add', '--', 'staged.txt')
  git(repo, 'mv', 'rename-old.txt', 'rename-new.txt')
  git(repo, 'rm', '-q', '--', 'delete.txt')
  writeFileSync(join(repo, 'two-hunk.txt'), numbered({ 2: 'TWO', 50: 'FIFTY' }))
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([0, 9, 2, 3]))
  writeFileSync(join(repo, 'untracked.txt'), 'untracked content\n')
  writeFileSync(join(repo, 'large-untracked.txt'), Buffer.alloc((2 << 20) + 1, 'x'))

  return { repo, baseOid, headOid }
}

async function startGitna(
  binary: string,
  repo: string,
): Promise<{ child: ChildProcess; url: string; root: string }> {
  const child = spawn(binary, [repo], {
    detached: process.platform !== 'win32',
    env: { ...process.env, GITNA_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => (stderr += chunk))

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`gitna did not emit a capability URL: ${stderr}`)),
      15_000,
    )
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      const match = line.match(/^gitna: serving (http:\/\/[^\s]+)$/)
      if (!match) return
      clearTimeout(timer)
      lines.close()
      resolve(match[1])
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`gitna exited before startup (${code}): ${stderr}`))
    })
  })

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status === 200) {
        const snapshotResponse = await fetch(new URL('api/v1/snapshot', url))
        if (snapshotResponse.ok) {
          const snapshot = (await snapshotResponse.json()) as { root: string }
          return { child, url, root: snapshot.root }
        }
      }
    } catch {
      // The serving URL is printed immediately before Serve starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  child.kill('SIGTERM')
  throw new Error(`gitna never became reachable at ${url}`)
}

async function stopGitna(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  if (
    await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ])
  )
    return
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  await exited
}

export const test = base.extend<{ app: GitnaFixture }>({
  app: async ({ browserName }, use) => {
    const binary = process.env.GITNA_E2E_BINARY
    if (!binary) throw new Error('GITNA_E2E_BINARY was not set by global setup')
    const temp = mkdtempSync(join(tmpdir(), `gitna-e2e-${browserName}-`))
    const fixture = createRepository(temp)
    let child: ChildProcess | undefined
    try {
      const running = await startGitna(binary, fixture.repo)
      child = running.child
      const parsed = new URL(running.url)
      await use({
        ...fixture,
        repo: running.root,
        url: running.url,
        origin: parsed.origin,
        token: parsed.pathname.split('/')[2] ?? '',
      })
    } finally {
      if (child) await stopGitna(child)
      rmSync(temp, { recursive: true, force: true })
    }
  },
})

export { expect }
