import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { pdfFixture } from './pdf-fixture.js'

// The legacy headless shell has no native PDF viewer. Use full Chromium in
// headless mode in CI, or the same browser headed for local visual checks.
test.use({ channel: 'chromium' })

async function openPDF(page: Page, path = 'sample.pdf') {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
  await palette.getByRole('option').filter({ hasText: path }).first().click()
  const frame = page.getByTitle(`PDF preview: ${path}`, { exact: true })
  await expect(frame).toBeVisible()
  return frame
}

async function expectNativePage(page: Page) {
  await expect
    .poll(async () => {
      const viewer = page
        .frames()
        .find((frame) =>
          frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'),
        )
      if (viewer == null) return null
      return viewer
        .locator('viewer-page-selector input')
        .inputValue({ timeout: 1000 })
        .catch(() => null)
    })
    .toBe('1')
}

test('native PDF renders on a file-only origin without exposing app authority', async ({
  page,
  app,
}) => {
  writeFileSync(
    join(app.repo, 'sample.pdf'),
    pdfFixture(
      'app.alert("url=" + this.URL + ";window=" + typeof window + ";parent=" + typeof parent);',
    ),
  )
  const dialogs: string[] = []
  const pdfReferrers: Array<string | undefined> = []
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/p/'))
      pdfReferrers.push(request.headers().referer)
  })
  await page.goto(app.url)
  const frame = await openPDF(page)
  await expectNativePage(page)
  const src = (await frame.getAttribute('src'))!
  const pdfOrigin = new URL(src).origin
  expect(pdfOrigin).not.toBe(app.origin)
  expect(src).not.toContain(app.token)
  expect(src).not.toContain(app.repo)
  await expect.poll(() => dialogs.length).toBe(1)
  expect(dialogs[0]).toBe(`url=${src};window=undefined;parent=undefined`)
  expect(pdfReferrers.length).toBeGreaterThan(0)
  expect(pdfReferrers.every((value) => value == null)).toBe(true)
  expect(
    await frame.evaluate((element: HTMLIFrameElement) => {
      try {
        return element.contentWindow!.location.href
      } catch (error) {
        return (error as Error).name
      }
    }),
  ).toBe('SecurityError')
  const range = await page.request.get(src, { headers: { Range: 'bytes=0-7' } })
  expect(range.status()).toBe(206)
  expect((await range.body()).toString()).toBe('%PDF-1.4')
  expect(range.headers()['content-type']).toBe('application/pdf')
  expect(range.headers()['content-disposition']).toContain('inline;')
  expect((await page.request.get(`${pdfOrigin}/api/v1/snapshot`)).status()).toBe(404)
  expect((await page.request.post(src, { data: {} })).status()).toBe(405)
  expect((await page.request.get(src, { headers: { Host: 'attacker.example' } })).status()).toBe(
    403,
  )
  const attemptedMutation = await page.request.post(new URL('api/v1/worktree/file', app.url).href, {
    headers: { Origin: pdfOrigin },
    data: { path: 'forbidden.txt', content: 'no' },
  })
  expect(attemptedMutation.status()).toBe(403)
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  expect((await download).suggestedFilename()).toBe('sample.pdf')
})

test('PDF leases renew, reload, close, and revoke on folder navigation', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'sample.pdf'), pdfFixture())
  const other = join(dirname(app.repo), 'other')
  mkdirSync(other)
  writeFileSync(join(other, 'sample.pdf'), pdfFixture())
  await page.clock.install()
  await page.goto(app.url)
  const frame = await openPDF(page)
  await expectNativePage(page)
  const first = (await frame.getAttribute('src'))!
  const renewed = page.waitForResponse(
    (response) =>
      response.url().includes('/pdf-preview?token=') && response.request().method() === 'PUT',
  )
  await page.clock.fastForward(60_000)
  expect((await renewed).status()).toBe(200)
  writeFileSync(
    join(app.repo, 'sample.pdf'),
    Buffer.concat([pdfFixture(), Buffer.from('\n% changed\n')]),
  )
  expect((await page.request.get(first)).status()).toBe(410)
  await page.getByRole('button', { name: 'Reload PDF preview' }).click()
  await expect(frame).not.toHaveAttribute('src', first)
  await expect.poll(async () => (await page.request.get(first)).status()).toBe(404)
  const second = (await frame.getAttribute('src'))!
  await page.getByRole('button', { name: 'Close sample.pdf', exact: true }).click()
  await expect(frame).toHaveCount(0)
  await expect.poll(async () => (await page.request.get(second)).status()).toBe(404)
  const next = await openPDF(page)
  const beforeSwitch = (await next.getAttribute('src'))!
  const folder = page.getByRole('combobox', { name: 'Folder path' })
  await folder.fill(other)
  await folder.press('Enter')
  await expect(page).not.toHaveURL(app.url)
  await expect.poll(async () => (await page.request.get(beforeSwitch)).status()).toBe(404)
  await openPDF(page)
  await expectNativePage(page)
})

test('closing a PDF during authorization revokes the late capability', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'sample.pdf'), pdfFixture())
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let capture!: (lease: { url: string }) => void
  const created = new Promise<{ url: string }>((resolve) => {
    capture = resolve
  })
  await page.route('**/api/v1/pdf-preview?path=*', async (route) => {
    const response = await route.fetch()
    capture(await response.json())
    await held
    await route.fulfill({ response })
  })
  try {
    await page.goto(app.url)
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox').fill('sample.pdf')
    await palette.getByRole('option').filter({ hasText: 'sample.pdf' }).first().click()
    const lease = await created
    await page.getByRole('button', { name: 'Close sample.pdf', exact: true }).click()
    release()
    await expect(page.getByTitle('PDF preview: sample.pdf', { exact: true })).toHaveCount(0)
    await expect.poll(async () => (await page.request.get(lease.url)).status()).toBe(404)
  } finally {
    release()
  }
})

test('PDF without browser support offers a download and creates no capability', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'sample.pdf'), pdfFixture())
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'pdfViewerEnabled', { value: false })
  })
  const creations: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/pdf-preview?')) creations.push(request.url())
  })
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('sample.pdf')
  await palette.getByRole('option').filter({ hasText: 'sample.pdf' }).first().click()
  await expect(page.getByText('This browser cannot display PDFs.', { exact: false })).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(creations).toEqual([])
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download file' }).click()
  expect((await download).suggestedFilename()).toBe('sample.pdf')
})
