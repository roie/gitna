import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

async function openSVG(
  page: import('@playwright/test').Page,
  url: string,
  marker: string,
  path = 'picture.svg',
) {
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  await search.getByRole('textbox', { name: 'Search files', exact: true }).fill(marker)
  await search.getByRole('button', { name: `Open ${path}:1` }).click()
  await search.getByRole('button', { name: 'Show Source Control' }).click()
}

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><title>SVGFixture</title><rect width="240" height="120" fill="red"/></svg>'

test('SVG preview follows unsaved edits, keeps undo, and supports both layouts', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'picture.svg'), svg)
  await openSVG(page, app.url, 'SVGFixture')
  const split = page.getByRole('button', { name: 'Open SVG preview to the side' })
  const full = page.getByRole('button', { name: 'Open SVG preview', exact: true })
  await split.click()
  const preview = page.getByRole('region', { name: 'SVG preview' })
  const image = preview.getByRole('img', { name: 'SVG preview' })
  await expect(image).toHaveJSProperty('naturalWidth', 240)
  const editor = page.getByRole('textbox', { name: 'picture.svg', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Shift+End')
  await page.keyboard.insertText(svg.replace('fill="red"', 'fill="blue"'))
  await expect(image).toHaveAttribute('src', /fill%3D%22blue%22/)
  expect(readFileSync(join(app.repo, 'picture.svg'), 'utf8')).toBe(svg)
  await full.click()
  await expect(image).toBeVisible()
  await expect(editor).toHaveCount(0)
  await full.click()
  await expect(preview).toHaveCount(0)
  await editor.focus()
  await page.keyboard.press('Control+z')
  await split.click()
  await expect(image).toHaveAttribute('src', /fill%3D%22red%22/)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(image).toBeVisible()
  const bounds = (await image.boundingBox())!
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390)
})

test('SVG image context does not execute scripts or request external resources', async ({
  page,
  app,
}) => {
  writeFileSync(
    join(app.repo, 'picture.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" onload="alert(1)"><title>SVGUnsafeFixture</title><script>alert(2)</script><image href="https://example.com/svg-tracker.png" width="100" height="100"/><image href="api/v1/content?path=modified.txt" width="100" height="100"/><rect width="240" height="120" fill="green"/></svg>',
  )
  const requests: string[] = []
  const dialogs: string[] = []
  page.on('request', (request) => {
    if (
      request.url().includes('svg-tracker') ||
      request.url().includes('content?path=modified.txt')
    )
      requests.push(request.url())
  })
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message())
    await dialog.dismiss()
  })
  await openSVG(page, app.url, 'SVGUnsafeFixture')
  await page.getByRole('button', { name: 'Open SVG preview', exact: true }).click()
  const preview = page.getByRole('region', { name: 'SVG preview' })
  await expect(preview.getByRole('img')).toHaveJSProperty('naturalWidth', 240)
  await expect(preview.locator('script, iframe, object, embed, svg')).toHaveCount(0)
  expect(dialogs).toEqual([])
  expect(requests).toEqual([])
})

test('invalid and oversized SVG show errors without removing the editor', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'picture.svg'), 'SVGInvalidFixture <svg broken')
  await openSVG(page, app.url, 'SVGInvalidFixture')
  await page.getByRole('button', { name: 'Open SVG preview to the side' }).click()
  const preview = page.getByRole('region', { name: 'SVG preview' })
  await expect(preview.getByRole('alert')).toContainText('could not display')
  const editor = page.getByRole('textbox', { name: 'picture.svg', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Shift+End')
  await page.keyboard.insertText(svg)
  await expect(preview.getByRole('img')).toHaveJSProperty('naturalWidth', 240)
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Control+Shift+End')
  await page.keyboard.insertText(
    `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(512 * 1024)}--></svg>`,
  )
  await expect(preview.getByRole('alert')).toContainText('limited to 512 KiB')
  await expect(editor).toBeVisible()
})
