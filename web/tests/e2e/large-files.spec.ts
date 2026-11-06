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

test('switching back to an approved large file never flashes a warning or retry error', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'switch-large.txt'), 'x'.repeat((2 << 20) + 1))
  writeFileSync(join(app.repo, 'pending-large.txt'), 'y'.repeat((2 << 20) + 1))
  await page.goto(app.url)
  await openFile(page, 'switch-large.txt')
  await page.getByRole('button', { name: 'Open anyway' }).click()
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await openFile(page, 'pending-large.txt')
  await expect(page.getByRole('heading', { name: 'Open large file?' })).toBeVisible()
  await page.evaluate(() => {
    const warningFlashes: string[] = []
    Object.assign(window, { warningFlashes })
    new MutationObserver(() => {
      for (const alert of document.querySelectorAll('[role="alert"]')) {
        warningFlashes.push(alert.textContent ?? '')
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.getByRole('tab', { name: 'switch-large.txt', exact: true }).click()
  await expect(editor).toContainText('xxxxxxxx')
  expect(
    await page.evaluate(
      () => (window as typeof window & { warningFlashes?: string[] }).warningFlashes,
    ),
  ).toEqual([])
  await page.getByRole('tab', { name: 'pending-large.txt', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Open large file?' })).toBeVisible()
  await page.getByRole('button', { name: 'Open anyway' }).click()
  await expect(editor).toContainText('yyyyyyyy')
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

test('reopening files revalidates cached contents and notices external changes', async ({
  page,
  app,
}) => {
  const path = join(app.repo, 'cached.txt')
  const content = 'cached line\n'.repeat(100000)
  writeFileSync(path, content)
  writeFileSync(join(app.repo, 'other.txt'), 'other file')
  await page.goto(app.url)
  await openFile(page, 'cached.txt')
  await page.getByRole('button', { name: 'Open anyway', exact: true }).click()
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await openFile(page, 'other.txt')
  await expect(editor).toHaveText('other file')
  const unchanged = page.waitForResponse((response) =>
    response.url().includes('/api/v1/worktree/file?path=cached.txt'),
  )
  await page.getByRole('tab', { name: 'cached.txt', exact: true }).click()
  expect((await unchanged).status()).toBe(304)
  await expect(editor).toContainText('cached line')
  await openFile(page, 'other.txt')
  await expect(editor).toHaveText('other file')
  writeFileSync(path, 'external change')
  const changed = page.waitForResponse((response) =>
    response.url().includes('/api/v1/worktree/file?path=cached.txt'),
  )
  await page.getByRole('tab', { name: 'cached.txt', exact: true }).click()
  expect((await changed).status()).toBe(200)
  await expect(editor).toHaveText('external change')
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

test('six-megabyte line supports editing and selection near its start without hanging', async ({
  page,
  app,
}) => {
  const content = 'x'.repeat(6 * 1024 * 1024 - 4) + 'END!'
  const path = join(app.repo, 'extreme-line.txt')
  writeFileSync(path, content)
  await page.goto(app.url)
  await page.evaluate(() => document.fonts.load('13px "Berkeley Mono"').then(() => undefined))
  await openFile(page, 'extreme-line.txt')
  await page.getByRole('button', { name: 'Open anyway' }).click()
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.focus()
  await editor.press('Control+Home', { timeout: 8000 })
  await editor.press('ArrowRight', { timeout: 8000 })
  await editor.press('X', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  const edited = 'xX' + content.slice(1)
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(edited)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await editor.press('Shift+ArrowLeft', { timeout: 8000 })
  await editor.press('Control+c', { timeout: 8000 })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('X')
  await editor.press('Control+z', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content)
  await editor.press('Control+Shift+z', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(edited)
  await editor.press('Control+a', { timeout: 8000 })
  await editor.press('Control+c', { timeout: 8000 })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(edited)
})

for (const chunk of ['aB09', 'const x = 1; ']) {
  test(`six-megabyte wrapped ${JSON.stringify(chunk)} lines keep whole-file editing`, async ({
    page,
    app,
  }) => {
    test.setTimeout(90000)
    const content = chunk.repeat(Math.ceil((6 * 1024 * 1024) / chunk.length)) + 'END!'
    const path = join(app.repo, 'six-megabyte.txt')
    writeFileSync(path, content)
    await page.goto(app.url)
    await openFile(page, 'six-megabyte.txt')
    await page.getByRole('button', { name: 'Open anyway' }).click()
    const editor = page.locator('.code-view [contenteditable="true"]').first()
    await expect(editor).toBeVisible({ timeout: 20000 })
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
    if (chunk === 'const x = 1; ') {
      const scroller = page.locator('.cv-scrollbar')
      const highlights = page.locator('.code-view [data-selection-range]')
      for (const fraction of [0.5, 0, 1]) {
        await scroller.evaluate((element, value) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) * value
        }, fraction)
        const middle = await scroller.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return (rect.top + rect.bottom) / 2
        })
        await expect
          .poll(() =>
            highlights.evaluateAll(
              (elements, y) =>
                elements.some((element) => {
                  const rect = element.getBoundingClientRect()
                  return rect.top <= y && rect.bottom >= y && rect.width > 0
                }),
              middle,
            ),
          )
          .toBe(true)
        expect(await highlights.count()).toBeLessThan(1000)
      }
      await editor.press('Control+c', { timeout: 8000 })
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(content + 'Z')
    }
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

for (const chunk of ['alpha beta ', '世界 👩🏽‍💻 שלום العربية é\t']) {
  test(`wrapped ${JSON.stringify(chunk)} selections paint only the viewport after scroll and resize`, async ({
    page,
    app,
  }) => {
    const content = chunk.repeat(1500)
    writeFileSync(join(app.repo, 'wrapped-selection.txt'), content)
    await page.goto(app.url)
    await openFile(page, 'wrapped-selection.txt')
    const editor = page.locator('.code-view [contenteditable="true"]').first()
    await expect(editor).toBeVisible()
    await editor.focus()
    await editor.press('Control+a')
    const scroller = page.locator('.cv-scrollbar')
    for (const mode of ['selection', 'search']) {
      if (mode === 'search') {
        await editor.press('Control+f')
        await page.locator('[data-search-panel] input[data-search]').fill(chunk.split(' ')[0]!)
        await expect(page.locator('[data-search-panel] [data-matches]')).toContainText('1500')
      }
      const highlights = page.locator(
        `.code-view [data-${mode === 'selection' ? 'selection' : 'match'}-range]`,
      )
      for (const width of [1000, 760]) {
        await page.setViewportSize({ width, height: 720 })
        for (const fraction of [0, 0.5, 1]) {
          await scroller.evaluate((element, value) => {
            element.scrollTop = (element.scrollHeight - element.clientHeight) * value
          }, fraction)
          await expect
            .poll(async () => {
              const bounds = await scroller.boundingBox()
              if (!bounds) return false
              return highlights.evaluateAll((elements, viewport) => {
                const rects = elements.map((element) => element.getBoundingClientRect())
                const middle = viewport.y + viewport.height / 2
                return (
                  rects.some(
                    (rect) => rect.top <= middle && rect.bottom >= middle && rect.width > 0,
                  ) &&
                  rects.every(
                    (rect) =>
                      rect.bottom >= viewport.y - 80 &&
                      rect.top <= viewport.y + viewport.height + 80,
                  )
                )
              }, bounds)
            })
            .toBe(true)
        }
      }
      if (mode === 'selection') {
        expect(
          await editor.evaluate((element) => {
            const clipboardData = new DataTransfer()
            element.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData }))
            return clipboardData.getData('text/plain')
          }),
        ).toBe(content)
      }
    }
  })
}

test('long plain-text replacements, deletions and line splits save and undo exactly', async ({
  page,
  app,
}) => {
  const content = 'BEGIN ' + 'alpha😀 e\u0301 beta '.repeat(1000)
  const path = join(app.repo, 'plain-edits.txt')
  writeFileSync(path, content)
  await page.goto(app.url)
  await openFile(page, 'plain-edits.txt')
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.focus()
  await editor.press('Control+Home')
  for (let index = 0; index < 3; index++) await editor.press('Shift+ArrowRight')
  await editor.press('X')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('X' + content.slice(3))
  await editor.press('Delete')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('X' + content.slice(4))
  await editor.press('Enter')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('X\n' + content.slice(4))
  for (let index = 0; index < 3; index++) await editor.press('Control+z')
  await editor.press('Control+s')
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content)
})

test('long Unicode lines keep responsive cursor movement and exact grapheme edits', async ({
  page,
  app,
}) => {
  const content = 'A😀e\u0301\t漢字 '.repeat(24000) + 'אבג '
  const path = join(app.repo, 'unicode-line.txt')
  writeFileSync(path, content)
  await page.goto(app.url)
  await openFile(page, 'unicode-line.txt')
  const editor = page.locator('.code-view [contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  await editor.focus()
  await editor.press('Control+Home', { timeout: 8000 })
  await editor.press('ArrowRight', { timeout: 8000 })
  await editor.press('Shift+ArrowRight', { timeout: 8000 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await editor.press('Control+c', { timeout: 8000 })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('😀')
  await editor.press('X', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect.poll(() => readFileSync(path, 'utf8')).toBe('AX' + content.slice(3))
  await editor.press('Control+z', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content)
  await editor.press('Control+Home', { timeout: 8000 })
  await editor.press('ArrowRight', { timeout: 8000 })
  await editor.press('ArrowRight', { timeout: 8000 })
  await editor.press('Shift+ArrowRight', { timeout: 8000 })
  await editor.press('Control+c', { timeout: 8000 })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('e\u0301')
  await editor.press('Y', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect
    .poll(() => readFileSync(path, 'utf8'))
    .toBe(content.slice(0, 3) + 'Y' + content.slice(5))
  await editor.press('Control+z', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content)
  await editor.press('Control+End', { timeout: 8000 })
  await editor.press('Z', { timeout: 8000 })
  await editor.press('Control+s', { timeout: 8000 })
  await expect.poll(() => readFileSync(path, 'utf8')).toBe(content + 'Z')
  await editor.press('Control+a', { timeout: 8000 })
  await editor.press('Control+c', { timeout: 8000 })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(content + 'Z')
})

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
