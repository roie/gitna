const targets = new Map([
  ['darwin-arm64', { asset: 'gitna_{version}_darwin_arm64.tar.gz', executable: 'gitna' }],
  ['darwin-x64', { asset: 'gitna_{version}_darwin_x64.tar.gz', executable: 'gitna' }],
  ['linux-arm64', { asset: 'gitna_{version}_linux_arm64.tar.gz', executable: 'gitna' }],
  ['linux-x64', { asset: 'gitna_{version}_linux_x64.tar.gz', executable: 'gitna' }],
  ['win32-x64', { asset: 'gitna_{version}_windows_x64.zip', executable: 'gitna.exe' }],
])

/**
 * @param {string} version
 * @param {NodeJS.Platform} [platform]
 * @param {string} [arch]
 */
export function targetFor(version, platform = process.platform, arch = process.arch) {
  const target = targets.get(`${platform}-${arch}`)
  if (!target) throw new Error(`Gitna does not provide a native binary for ${platform}-${arch}`)
  return { ...target, asset: target.asset.replace('{version}', version) }
}
