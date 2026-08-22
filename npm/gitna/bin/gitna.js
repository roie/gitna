#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { packageFor } from '../lib/platform.mjs'

try {
  const target = packageFor()
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve(`${target.packageName}/package.json`))
  const result = spawnSync(join(packageRoot, target.executable), process.argv.slice(2), {
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.signal) process.kill(process.pid, result.signal)
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(`gitna: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
