import assert from 'node:assert/strict'
import test from 'node:test'
import { packageFor } from '../lib/platform.mjs'

test('selects each published native package', () => {
  assert.deepEqual(packageFor('linux', 'x64'), {
    packageName: 'gitna-linux-x64',
    executable: 'bin/gitna',
  })
  assert.deepEqual(packageFor('linux', 'arm64'), {
    packageName: 'gitna-linux-arm64',
    executable: 'bin/gitna',
  })
  assert.deepEqual(packageFor('win32', 'x64'), {
    packageName: 'gitna-win32-x64',
    executable: 'bin/gitna.exe',
  })
})

test('rejects unsupported targets clearly', () => {
  assert.throws(() => packageFor('darwin', 'arm64'), /does not provide an npm binary/)
})
