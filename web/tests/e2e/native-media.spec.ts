import { copyFileSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

function wav(seconds = 3): Buffer {
  const samples = 8000 * seconds
  const data = Buffer.alloc(44 + samples * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24)
  data.writeUInt32LE(16000, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(samples * 2, 40)
  return data
}

async function openFile(page: Page, path: string) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
  await palette.getByRole('option').filter({ hasText: path }).first().click()
  await expect(page.getByRole('region', { name: 'Media preview' })).toBeVisible()
}

for (const sample of ['sample.wav', 'mp3.mp3', 'aac.m4a', 'opus.ogg', 'h264.mp4', 'vp8.webm']) {
  test(`native ${sample} loads, seeks, plays, and releases on tab close`, async ({ page, app }) => {
    if (sample.endsWith('.wav')) writeFileSync(join(app.repo, sample), wav())
    else
      copyFileSync(
        fileURLToPath(new URL(`./media-fixtures/${sample}`, import.meta.url)),
        join(app.repo, sample),
      )
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await page.goto(app.url)
    await openFile(page, sample)
    const media = page.locator(/\.(mp4|webm)$/.test(sample) ? 'video' : 'audio')
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState))
      .toBeGreaterThanOrEqual(1)
    expect(await media.evaluate((el: HTMLMediaElement) => el.duration)).toBeCloseTo(3, 0)
    await media.evaluate(async (el: HTMLMediaElement) => {
      el.muted = true
      await el.play()
      el.currentTime = 1.5
    })
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.seeking)).toBe(false)
    await expect
      .poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime))
      .toBeGreaterThan(1.6)
    await media.focus()
    await expect(media).toBeFocused()
    await page.keyboard.press('Space')
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true)
    if (sample === 'h264.mp4') {
      await page.setViewportSize({ width: 320, height: 720 })
      const closeSidebar = page.getByRole('button', { name: 'Close Source Control', exact: true })
      if (await closeSidebar.isVisible()) await closeSidebar.click()
      await expect(media).toBeInViewport()
      const box = await media.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    }
    const handle = await media.elementHandle()
    await page.getByRole('button', { name: `Close ${sample}`, exact: true }).click()
    await expect(media).toHaveCount(0)
    expect(
      await handle!.evaluate((el: HTMLMediaElement) => ({
        paused: el.paused,
        source: el.getAttribute('src'),
      })),
    ).toEqual({ paused: true, source: null })
    expect(requests.some((url) => url.includes('/media?'))).toBe(true)
    expect(requests.some((url) => url.includes('/worktree/file?') && url.includes(sample))).toBe(
      false,
    )
  })
}

test('mislabeled PDF and unsupported codecs fall back without active content', async ({
  page,
  app,
}) => {
  const hostile =
    '<html><script>parent.document.title="owned";fetch("https://example.invalid/leak")</script></html>'
  writeFileSync(join(app.repo, 'fake.mp4'), hostile)
  // Recognized container, invalid payload: exercises the native decoder error,
  // not just server-side type detection.
  writeFileSync(join(app.repo, 'broken.wav'), Buffer.from('RIFF\0\0\0\0WAVEbroken'))
  writeFileSync(join(app.repo, 'actions.pdf'), hostile)
  // Exercise server validation even in the legacy headless shell, which has
  // no native PDF viewer. A rejected file must never create an iframe.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: true })
  })
  const external: string[] = []
  const dialogs: string[] = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  page.on('request', (request) => {
    if (!request.url().startsWith(app.origin)) external.push(request.url())
  })
  await page.goto(app.url)
  for (const file of ['fake.mp4', 'broken.wav']) {
    await openFile(page, file)
    await expect(
      page.getByText('This browser cannot play this file', { exact: false }),
    ).toBeVisible()
    await expect(page.locator('audio, video, iframe, object, embed')).toHaveCount(0)
    const download = page.waitForEvent('download')
    await page.getByRole('link', { name: 'Download file' }).click()
    expect((await download).suggestedFilename()).toBe(file)
  }
  await openFile(page, 'actions.pdf')
  await expect(page.getByText('PDF preview is unavailable', { exact: false })).toBeVisible()
  await expect(page.locator('iframe, object, embed')).toHaveCount(0)
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  expect((await download).suggestedFilename()).toBe('actions.pdf')
  await expect(page).not.toHaveTitle('owned')
  expect(external).toEqual([])
  expect(dialogs).toEqual([])
})

test('missing media can be retried and switching folders releases the player', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'sample.wav'), wav())
  const folder = join(dirname(app.repo), 'other-folder')
  mkdirSync(folder)
  writeFileSync(join(folder, 'sample.wav'), wav(4))
  await page.goto(app.url)
  await openFile(page, 'sample.wav')
  const audio = page.locator('audio')
  await expect
    .poll(() => audio.evaluate((el: HTMLMediaElement) => el.readyState))
    .toBeGreaterThanOrEqual(1)
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.fill(folder)
  await folderPath.press('Enter')
  await expect(folderPath).toHaveValue(folder)
  await expect(page.getByRole('region', { name: 'Media preview' })).toHaveCount(0)
  await expect(page).not.toHaveURL(app.url)
  await openFile(page, 'sample.wav')
  await expect.poll(() => audio.evaluate((el: HTMLMediaElement) => el.duration)).toBe(4)
  await page.getByRole('button', { name: 'Close sample.wav', exact: true }).click()
  // Delete after selection but before the real server handles the metadata read.
  await page.route(
    '**/api/v1/media?*',
    async (route) => {
      unlinkSync(join(folder, 'sample.wav'))
      await route.continue()
    },
    { times: 1 },
  )
  await openFile(page, 'sample.wav')
  await expect(
    page.getByRole('alert').filter({ hasText: 'This file no longer exists.' }),
  ).toBeVisible()
  writeFileSync(join(folder, 'sample.wav'), wav())
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect
    .poll(() => audio.evaluate((el: HTMLMediaElement) => el.readyState))
    .toBeGreaterThanOrEqual(1)
})
