import { test, expect } from './fixtures.js'

test('command palette keeps its opening size while file results load', async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
  let releaseSearch!: () => void
  const searchHeld = new Promise<void>((resolve) => (releaseSearch = resolve))
  await page.route('**/api/v1/files/search**', async (route) => {
    await searchHeld
    await route.continue()
  })
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog).toBeVisible()
  const openingHeight = (await dialog.boundingBox())!.height
  await expect(dialog.getByRole('status')).toContainText('Searching files')
  releaseSearch()
  await expect(dialog.getByRole('option').first()).toBeVisible()
  const loadedHeight = (await dialog.boundingBox())!.height
  expect(Math.abs(loadedHeight - openingHeight)).toBeLessThanOrEqual(1)
  await expect(dialog.getByRole('status')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 600 })
  const mobileBounds = (await dialog.boundingBox())!
  expect(mobileBounds.x).toBeGreaterThanOrEqual(0)
  expect(mobileBounds.y + mobileBounds.height).toBeLessThanOrEqual(600)
})

test('quick command palette searches do not flash a loading indicator', async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  await expect(dialog.getByRole('option').first()).toBeVisible()
  await expect(dialog.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const frames: boolean[] = []
    Object.assign(window, { paletteLoadingFrames: frames })
    const sample = () => {
      frames.push(
        document.querySelector('dialog[aria-label="Command palette"] span[role="status"]') != null,
      )
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const refreshed = page.waitForResponse((response) =>
    response.url().includes('/api/v1/files/search?'),
  )
  await page.keyboard.press('Control+k')
  await refreshed
  await expect(dialog.getByRole('option').first()).toBeVisible()
  await expect(dialog.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
  expect(
    await page.evaluate(() => Reflect.get(window, 'paletteLoadingFrames') as boolean[]),
  ).not.toContain(true)
})
