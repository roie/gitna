#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { ensureBinary } from '../lib/install.mjs'

try {
  const binary = await ensureBinary()
  const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.signal) process.kill(process.pid, result.signal)
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(`gitna: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
