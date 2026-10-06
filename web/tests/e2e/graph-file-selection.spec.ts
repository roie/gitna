import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

test('fast commit expansion does not flash a loading message', async ({ page, app }) => {
  await page.goto(app.url)
  await page.locator('[data-section="graph"]').click()
  const row = page.locator('.graph-row').filter({
    has: page.getByRole('button', { name: /^merge feature/ }),
  })
  await page.evaluate(() => {
    const state = { flashed: false }
    Object.assign(window, { commitLoadingState: state })
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.textContent === 'Loading…') state.flashed = true
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  })
  await row.locator('[data-graph-disclosure]').click()
  await expect(row.getByRole('treeitem', { name: 'feature.txt', exact: true })).toBeVisible()
  const flashed = await page.evaluate(
    () =>
      (window as unknown as { commitLoadingState: { flashed: boolean } }).commitLoadingState
        .flashed,
  )
  expect(flashed).toBe(false)
})

test('slow commit expansion still shows loading and then changed files', async ({ page, app }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/commit/*/files', async (route) => {
    await pending
    await route.continue()
  })
  try {
    await page.goto(app.url)
    await page.locator('[data-section="graph"]').click()
    const row = page.locator('.graph-row').filter({
      has: page.getByRole('button', { name: /^merge feature/ }),
    })
    await row.locator('[data-graph-disclosure]').click()
    await expect(row.getByText('Loading…', { exact: true })).toBeVisible()
    release()
    await expect(row.getByRole('treeitem', { name: 'feature.txt', exact: true })).toBeVisible()
    await expect(row.getByText('Loading…', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})

test('selecting the same file in different commits loads each commit diff', async ({
  page,
  app,
}) => {
  for (const version of ['base', 'A', 'B']) {
    writeFileSync(join(app.repo, 'test.md'), `commit ${version} content\n`)
    execFileSync('git', ['add', '--', 'test.md'], { cwd: app.repo })
    execFileSync('git', ['commit', '-qm', `graph selection ${version}`, '--', 'test.md'], {
      cwd: app.repo,
    })
  }

  await page.goto(app.url)
  await page.locator('[data-section="graph"]').click()
  const selectFile = async (version: string) => {
    const row = page.locator('.graph-row').filter({
      has: page.getByRole('button', { name: new RegExp(`^graph selection ${version}`) }),
    })
    const disclosure = row.locator('[data-graph-disclosure]')
    if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click()
    await row.getByRole('treeitem', { name: 'test.md', exact: true }).click()
  }
  const content = (version: string) =>
    page
      .locator('diffs-container')
      .locator('code')
      .filter({ hasText: `commit ${version} content` })
  await selectFile('A')
  await expect(content('A')).toBeVisible()
  await selectFile('B')
  await expect(content('B')).toBeVisible()
  await selectFile('A')
  await expect(content('B')).toHaveCount(0)
  await expect(content('A')).toBeVisible()
})
