const targets = new Map([
  ['linux-arm64', { packageName: 'gitna-linux-arm64', executable: 'bin/gitna' }],
  ['linux-x64', { packageName: 'gitna-linux-x64', executable: 'bin/gitna' }],
  ['win32-x64', { packageName: 'gitna-win32-x64', executable: 'bin/gitna.exe' }],
])

export function packageFor(platform = process.platform, arch = process.arch) {
  const target = targets.get(`${platform}-${arch}`)
  if (!target) {
    throw new Error(`Gitna does not provide an npm binary for ${platform}-${arch}`)
  }
  return target
}
