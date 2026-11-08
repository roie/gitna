import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

test('file gutters track the index, unsaved edits, undo, and staging', async ({ page, app }) => {
  const requests = { baseline: 0, blame: 0, line: 0 }
  page.on('request', (request) => {
    if (request.url().includes('/worktree/baseline')) requests.baseline++
    if (request.url().includes('/worktree/blame')) requests.blame++
    if (request.url().includes('/worktree/line-history')) requests.line++
  })
  await page.goto(app.url)
  const openFile = async (path: string) => {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
    await palette
      .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
      .click()
  }
  const marks = page.locator('[data-file] [data-gitna-change]')
  const row = (index: number) => page.locator(`[data-file] [data-line][data-line-index="${index}"]`)

  await openFile('two-hunk.txt')
  await expect(page.locator('[data-column-number="2"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  await expect.poll(() => requests.blame).toBe(1)
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/snapshot'))
  writeFileSync(join(app.repo, 'unrelated.txt'), 'unrelated\n')
  await refreshed
  await page.waitForTimeout(300)
  expect(requests).toEqual({ baseline: 1, blame: 1, line: 0 })

  await row(10).click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('Home')
  await page.keyboard.type('inserted')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-column-number="11"][data-gitna-change="added"]')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(marks).toHaveCount(1)
  await expect(page.locator('[data-column-number="2"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  await row(2).click({ position: { x: 20, y: 8 } })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.querySelector('diffs-container')?.shadowRoot as
          | (ShadowRoot & { getSelection?: () => Selection | null })
          | undefined
        const anchor = (root?.getSelection?.() ?? document.getSelection())?.anchorNode
        const element = anchor instanceof Element ? anchor : anchor?.parentElement
        return element?.closest('[data-line]')?.getAttribute('data-line')
      }),
    )
    .toBe('3')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-column-number="2"][data-gitna-deletion="after"]')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-gitna-deletion]')).toHaveCount(0)

  await row(2).hover()
  await page.mouse.wheel(0, 800)
  await expect(page.locator('[data-column-number="50"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  execFileSync('git', ['add', '--', 'two-hunk.txt'], { cwd: app.repo })
  await expect(marks).toHaveCount(0)
  execFileSync('git', ['reset', '-q', 'HEAD', '--', 'two-hunk.txt'], { cwd: app.repo })
  await expect(page.locator('[data-column-number="50"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )
  expect(requests.blame).toBe(1)
  expect(requests.line).toBe(0)
  await openFile('staged.txt')
  await expect(marks).toHaveCount(0)
  await openFile('untracked.txt')
  await expect(marks).toHaveCount(0)
})

async function openEditor(page: Page, path: string) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
  await palette
    .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
    .click()
  await expect(page.getByRole('textbox', { name: path, exact: true })).toBeVisible()
}

test('editor gutters distinguish nine Git states without hiding review additions', async ({
  page,
  app,
}) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: app.repo })
  writeFileSync(join(app.repo, 'empty.txt'), '')
  git('add', '--', 'empty.txt')
  git('commit', '--only', '-qm', 'empty fixture', '--', 'empty.txt')
  writeFileSync(join(app.repo, 'empty.txt'), 'new\n')
  writeFileSync(join(app.repo, 'staged-new.txt'), 'staged\n')
  git('add', '--', 'staged-new.txt')
  writeFileSync(join(app.repo, 'staged-new.txt'), 'edited\n')
  writeFileSync(join(app.repo, 'intent.txt'), 'intent\n')
  git('add', '-N', '--', 'intent.txt')
  writeFileSync(join(app.repo, 'ignored.txt'), 'ignored\n')
  writeFileSync(join(app.repo, '.git', 'info', 'exclude'), 'ignored.txt\nfeature.txt\n')
  writeFileSync(join(app.repo, 'feature.txt'), 'tracked despite ignore\n')
  writeFileSync(join(app.repo, 'delete.txt'), 'delete me\n')
  await page.goto(app.url)
  for (const [path, kind] of [
    ['main.txt', null],
    ['modified.txt', 'modified'],
    ['empty.txt', 'added'],
    ['staged-new.txt', 'modified'],
    ['intent.txt', 'added'],
    ['untracked.txt', null],
    ['ignored.txt', null],
    ['feature.txt', 'modified'],
    ['delete.txt', null],
  ] as const) {
    await openEditor(page, path)
    const marks = page.locator('[data-file] [data-gitna-change]')
    if (kind == null) {
      await expect(marks).toHaveCount(0)
    } else {
      await expect(
        page.locator(`[data-column-number="1"][data-gitna-change="${kind}"]`),
      ).toHaveCount(1)
    }
  }
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'untracked.txt', exact: true })
    .click()
  await expect(
    page.locator('[data-line-type="change-addition"]').filter({ hasText: 'untracked content' }),
  ).toHaveCount(1)
})

test('wrapped replacement bars and deletion boundaries match rendered row geometry', async ({
  page,
  app,
}) => {
  const path = join(app.repo, 'wrapped.txt')
  writeFileSync(path, `${'old '.repeat(150)}\nkeep\nremoved\ntail\n`)
  execFileSync('git', ['add', 'wrapped.txt'], { cwd: app.repo })
  writeFileSync(path, `${'new '.repeat(150)}\n${'extra '.repeat(150)}\nkeep\ntail\n`)
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.goto(app.url)
  await openEditor(page, 'wrapped.txt')
  const modified = page.locator('[data-column-number="1"][data-gitna-change="modified"]')
  const added = page.locator('[data-column-number="2"][data-gitna-change="added"]')
  await expect(modified).toHaveCount(1)
  await expect(added).toHaveCount(1)
  await expect(page.locator('[data-column-number="3"][data-gitna-deletion="after"]')).toHaveCount(1)
  for (const marker of [modified, added]) {
    const geometry = await marker.evaluate((element) => {
      const root = element.getRootNode() as ShadowRoot
      const line = root.querySelector(
        `[data-line][data-line-index="${element.getAttribute('data-line-index')}"]`,
      )!
      return {
        gutter: element.getBoundingClientRect().height,
        code: line.getBoundingClientRect().height,
        width: getComputedStyle(element, '::before').width,
      }
    })
    expect(geometry.code).toBeGreaterThan(40)
    expect(Math.abs(geometry.gutter - geometry.code)).toBeLessThan(1)
    expect(geometry.width).toBe('3px')
  }
})

test('sustained typing reuses a busy gutter worker and rejects obsolete results', async ({
  page,
  app,
}) => {
  let workers = 0
  page.on('worker', (worker) => {
    if (worker.url().includes('changeGutterWorker-')) workers++
  })
  await page.route('**/changeGutterWorker-*.js', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      body: `const post = self.postMessage.bind(self); self.postMessage = (...args) => setTimeout(() => post(...args), 150);\n${await response.text()}`,
    })
  })
  await page.goto(app.url)
  await openEditor(page, 'main.txt')
  await page.locator('[data-line][data-line-index="0"]').click({ position: { x: 12, y: 8 } })
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('workerreuse', { delay: 100 })
  await expect(page.locator('[data-column-number="1"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )
  expect(workers).toBe(1)
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-gitna-change]')).toHaveCount(0)
  await page.waitForTimeout(300)
  await expect(page.locator('[data-gitna-change]')).toHaveCount(0)
})
