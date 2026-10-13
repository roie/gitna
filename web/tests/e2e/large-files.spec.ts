import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.js'

async function openFile(page: Page, name: string) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search files and commands' })
  await search.fill(name)
  const option = palette.getByRole('option', { name: new RegExp(`^${name} `) })
  await expect(option).toHaveAttribute('aria-disabled', 'false')
  await option.click()
}

test('large-file consent supports tab closing, exact saves, undo and durable recovery', async ({
  page,
  app,
}) => {
  test.setTimeout(90000)
  const content = 'x\r\n'.repeat(1000000) + 'END!'
  const path = join(app.repo, 'approved.txt')
  writeFileSync(path, content)
  await page.goto(app.url)
  await openFile(page, 'approved.txt')
  await expect(page.getByRole('heading', { name: 'Open large file?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close approved.txt', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'approved.txt' })).toHaveCount(0)
  await openFile(page, 'approved.txt')
  await expect(page.getByRole('heading', { name: 'Open large file?' })).toBeVisible()
  await page.getByRole('button', { name: 'Open anyway' }).click()
  const editor = page.locator('.code-view').locator('[contenteditable="true"], textarea').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press('Control+End')
  await expect(editor).toContainText('END!')
  await editor.pressSequentially('Z')
  await editor.press('Control+z')
  await expect(
    page.getByRole('tab', { name: 'approved.txt' }).getByLabel('Unsaved changes'),
  ).toHaveCount(0)
  expect(readFileSync(path, 'utf8')).toBe(content)
  await editor.press('Control+Shift+z')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content + 'Z')
  await expect(
    page.getByRole('tab', { name: 'approved.txt' }).getByLabel('Unsaved changes'),
  ).toHaveCount(0)

  await editor.click()
  await editor.press('Control+End')
  const backup = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/v1/drafts?maxBytes=') &&
      response.request().postDataJSON().contents === content + 'ZR',
  )
  await editor.pressSequentially('R')
  expect((await backup).status()).toBe(200)
  await page.reload()
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved documents' })
  await expect(recovery).toBeVisible()
  await recovery.getByRole('button', { name: 'Restore copy' }).click()
  await expect(page.getByRole('tab', { name: 'approved.txt (Recovered)' })).toBeVisible()
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press('Control+s')
  const saveAs = page.getByRole('dialog', { name: 'Save As' })
  await saveAs.getByRole('textbox', { name: 'Repository-relative path' }).fill('recovered.txt')
  await saveAs.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(() => readFileSync(join(app.repo, 'recovered.txt'), 'utf8'))
    .toBe(content + 'ZR')
  expect(readFileSync(path, 'utf8')).toBe(content + 'Z')
})

test('large-file consent does not bypass encoding validation', async ({ page, app }) => {
  const bytes = Buffer.concat([Buffer.from([255]), Buffer.alloc(550000, 'x')])
  const path = join(app.repo, 'encoding.txt')
  writeFileSync(path, bytes)
  await page.goto(app.url)
  await openFile(page, 'encoding.txt')
  await page.getByRole('button', { name: 'Open anyway' }).click()
  await expect(page.getByRole('alert')).toContainText('invalid UTF-8')
  await expect(page.getByRole('alert')).toContainText('Convert it to UTF-8')
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open anyway' })).toHaveCount(0)
  expect(readFileSync(path)).toEqual(bytes)
})
