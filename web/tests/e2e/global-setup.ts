/// <reference types="node" />

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export default function globalSetup(): () => void {
  const configuredBinary = process.env.GITNA_E2E_BINARY
  if (configuredBinary) {
    process.env.GITNA_E2E_BINARY = resolve(configuredBinary)
    return () => undefined
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const temp = mkdtempSync(join(tmpdir(), 'gitna-e2e-build-'))
  const binary = join(temp, process.platform === 'win32' ? 'gitna.exe' : 'gitna')

  if (process.platform === 'win32') {
    execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm.cmd', '--dir', 'web', 'build'],
      {
        cwd: root,
        stdio: 'inherit',
      },
    )
  } else {
    execFileSync('pnpm', ['--dir', 'web', 'build'], { cwd: root, stdio: 'inherit' })
  }
  execFileSync('go', ['build', '-o', binary, './cmd/gitna'], { cwd: root, stdio: 'inherit' })

  process.env.GITNA_E2E_BINARY = binary
  return () => rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}
