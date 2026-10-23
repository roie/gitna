import { execFileSync } from 'node:child_process'
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

test('approving a large file shows loading without a retry error flash', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'loading.txt'), 'x'.repeat((2 << 20) + 1))
  await page.goto(app.url)
  await openFile(page, 'loading.txt')
  await expect(page.getByRole('heading', { name: 'Open large file?' })).toBeVisible()
  let releaseRead!: () => void
  const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
  await page.route('**/api/v1/worktree/file?*', async (route) => {
    if (new URL(route.request().url()).searchParams.has('maxBytes')) await readGate
    await route.continue()
  })
  await page.evaluate(() => {
    const retryFlashes: string[] = []
    Object.assign(window, { retryFlashes })
    new MutationObserver(() => {
      for (const alert of document.querySelectorAll('[role="alert"]')) {
        if (alert.textContent?.includes('Try again')) retryFlashes.push(alert.textContent)
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  try {
    await page.getByRole('button', { name: 'Open anyway' }).click()
    await expect(page.getByRole('heading', { name: 'Opening file', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0)
  } finally {
    releaseRead()
  }
  await expect(page.locator('.code-view [contenteditable="true"]').first()).toBeVisible()
  expect(
    await page.evaluate(() => (window as typeof window & { retryFlashes?: string[] }).retryFlashes),
  ).toEqual([])
})

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
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press('Control+End')
  await expect(editor).toContainText('END!')
  await editor.pressSequentially('Z')
  await expect(editor).toContainText('END!Z')
  await editor.press('Control+z')
  await expect(editor).toContainText('END!')
  await expect(editor).not.toContainText('END!Z')
  await expect(
    page.getByRole('tab', { name: 'approved.txt' }).getByLabel('Unsaved changes'),
  ).toHaveCount(0)
  expect(readFileSync(path, 'utf8')).toBe(content)
  await editor.press('Control+Shift+z')
  await expect(editor).toContainText('END!Z')
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
  await expect(editor).toContainText('END!ZR')
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

test('long lines retain whole-file selection, editing and exact saves', async ({ page, app }) => {
  const content = 'HEAD\r\n' + 'x'.repeat(300000) + '\r\nEND!'
  const path = join(app.repo, 'long-line.txt')
  writeFileSync(path, content)
  writeFileSync(join(app.repo, 'other.txt'), 'other file')
  await page.goto(app.url)
  await openFile(page, 'long-line.txt')
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next section', exact: true })).toHaveCount(0)
  await editor.click()
  await editor.press('Control+End')
  await expect(editor).toContainText('END!')
  await editor.pressSequentially('Z')
  await editor.press('Control+z')
  await expect(
    page.getByRole('tab', { name: 'long-line.txt' }).getByLabel('Unsaved changes'),
  ).toHaveCount(0)
  await editor.press('Control+Shift+z')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content + 'Z')
  await editor.press('Control+a')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await editor.press('Control+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(content + 'Z')
  await openFile(page, 'other.txt')
  await page.getByRole('tab', { name: 'long-line.txt', exact: true }).click()
  await expect(editor).toBeVisible()
  await editor.click()
  await editor.press('Control+z')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content)
})

for (const chunk of ['aB09', 'const x = 1; ']) {
  test(`six-megabyte wrapped ${JSON.stringify(chunk)} lines keep whole-file editing`, async ({
    page,
    app,
  }) => {
    test.setTimeout(60000)
    const content = chunk.repeat(Math.ceil((6 * 1024 * 1024) / chunk.length)) + 'END!'
    const path = join(app.repo, 'six-megabyte.txt')
    writeFileSync(path, content)
    await page.goto(app.url)
    await openFile(page, 'six-megabyte.txt')
    await page.getByRole('button', { name: 'Open anyway' }).click()
    const editor = page.locator('.code-view [contenteditable="true"]').first()
    await expect(editor).toBeVisible()
    await expect
      .poll(() => editor.evaluate((element) => element.textContent?.length))
      .toBe(content.length)
    await editor.focus()
    await editor.press('Control+End', { timeout: 8000 })
    await editor.press('Z', { timeout: 8000 })
    await editor.press('Control+s', { timeout: 8000 })
    await expect.poll(() => readFileSync(path, 'utf8')).toBe(content + 'Z')
    await editor.press('Control+a', { timeout: 8000 })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await editor.press('Control+c', { timeout: 8000 })
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(content + 'Z')
    await editor.press('ArrowLeft', { timeout: 8000 })
    await editor.press('Control+Home', { timeout: 8000 })
    await editor.press('A', { timeout: 8000 })
    await editor.press('Control+s', { timeout: 8000 })
    await expect.poll(() => readFileSync(path, 'utf8')).toBe('A' + content + 'Z')
    await editor.press('Control+z', { timeout: 8000 })
    await editor.press('Control+s', { timeout: 8000 })
    await expect.poll(() => readFileSync(path, 'utf8')).toBe(content + 'Z')
  })
}

test('heavy TypeScript diffs render and navigate both ends', async ({ page, app }) => {
  const path = join(app.repo, 'heavy.ts')
  const contents = (value: number) =>
    Array.from({ length: 7000 }, (_, index) => `export const value${index} = ${value};\n`).join('')
  writeFileSync(path, contents(1))
  execFileSync('git', ['add', '--', 'heavy.ts'], { cwd: app.repo })
  execFileSync('git', ['commit', '-qm', 'Heavy diff fixture'], { cwd: app.repo })
  writeFileSync(path, contents(2))
  await page.goto(app.url)
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'heavy.ts', exact: true })
    .click()
  const first = page.locator('[data-line]').filter({ hasText: 'export const value0 = 2;' }).first()
  await expect(first).toBeVisible()
  const scroller = page.locator('.cv-scrollbar')
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(
    page.locator('[data-line]').filter({ hasText: 'export const value6999 = 2;' }).first(),
  ).toBeVisible()
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'modified.txt', exact: true })
    .click()
  await expect(
    page.locator('[data-line]').filter({ hasText: 'unstaged change' }).first(),
  ).toBeVisible()
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'heavy.ts', exact: true })
    .click()
  await expect(first).toBeVisible()
  expect(readFileSync(path, 'utf8')).toBe(contents(2))
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
