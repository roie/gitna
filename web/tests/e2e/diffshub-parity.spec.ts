import { spawnSync } from 'node:child_process'
import { expect, test } from './fixtures.js'

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

test('DiffsHub controls, Pierre repository search, and theme persist', async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.locator('diffs-container').first()).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Theme settings' }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('diffs-container').first()).toBeVisible({ timeout: 30_000 })
  await page.locator('[data-section="repository"]').click()

  await page.getByRole('button', { name: 'Display settings' }).click()
  await expect(page.getByRole('switch', { name: 'Word wrap' })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Backgrounds' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Line numbers' })).toBeVisible()
  await expect(page.getByText('GitHub token', { exact: false })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const repositorySection = page
    .locator('section.section')
    .filter({ has: page.locator('[data-section="repository"]') })
  await repositorySection.getByRole('button', { name: /^Search / }).click()
  const search = repositoryTree.getByRole('textbox', { name: 'Search…' })
  await search.fill('two-hunk')
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'two-hunk.txt', exact: true }),
  ).toBeVisible()
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'modified.txt', exact: true }),
  ).toHaveCount(0)
  await expect
    .poll(() =>
      repositoryTree.evaluate((tree) => {
        const rows = tree.querySelectorAll<HTMLElement>('[role="treeitem"]')
        const last = rows.item(rows.length - 1)
        const scroll = tree.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]')
        const searchContainer = tree.querySelector<HTMLElement>(
          '[data-file-tree-search-container="true"]',
        )
        return {
          hasVisibleRow: last != null,
          scrollOverflow:
            scroll == null ? Number.POSITIVE_INFINITY : scroll.scrollHeight - scroll.clientHeight,
          searchOpen: searchContainer?.dataset.open,
        }
      }),
    )
    .toEqual({ hasVisibleRow: true, scrollOverflow: 0, searchOpen: 'true' })
  if (process.env.GITNA_CAPTURE_GRAPH) {
    await page.screenshot({ path: '/tmp/gitna-tree-search.png', fullPage: true })
  }
  await search.fill('')
  await repositorySection.getByRole('button', { name: /^Hide .* search$/ }).click()

  await expect(
    repositoryTree.getByRole('treeitem', { name: 'untracked.txt', exact: true }),
  ).toHaveAttribute('data-item-git-status', 'untracked')
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Comments', exact: true })).toHaveCount(0)
})

test('review failure keeps Source Control usable and retry recovers', async ({ page, app }) => {
  let failReview = true
  await page.route('**/api/v1/review?*', async (route) => {
    if (failReview) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fixture review unavailable' }),
      })
      return
    }
    await route.continue()
  })

  await page.goto(app.url)
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('Couldn’t load diff')
  const statusPanel = alert.locator('..')
  const review = page.getByRole('region', { name: 'Review' })
  const [statusBox, alertBox, reviewBox] = await Promise.all([
    statusPanel.boundingBox(),
    alert.boundingBox(),
    review.boundingBox(),
  ])
  expect(statusBox).not.toBeNull()
  expect(alertBox).not.toBeNull()
  expect(reviewBox).not.toBeNull()
  expect(statusBox!.x).toBeGreaterThanOrEqual(319)
  expect(
    Math.abs(statusBox!.x + statusBox!.width - (reviewBox!.x + reviewBox!.width)),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(statusBox!.y + statusBox!.height - (reviewBox!.y + reviewBox!.height)),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(alertBox!.x + alertBox!.width / 2 - (statusBox!.x + statusBox!.width / 2)),
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(alertBox!.y + alertBox!.height / 2 - (statusBox!.y + statusBox!.height / 2)),
  ).toBeLessThanOrEqual(1)
  if (process.env.GITNA_CAPTURE_GRAPH) {
    await page.screenshot({ path: '/tmp/gitna-loading-centered.png', fullPage: true })
  }
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  failReview = false
  await page.evaluate(() => {
    const retry = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Try again',
    )
    retry?.click()
  })
  await expect(page.locator('diffs-container').first()).toBeVisible({ timeout: 30_000 })
})

test('clean repository renders a truthful empty review state', async ({ page, app }) => {
  git(app.repo, 'reset', '--hard', 'HEAD')
  git(app.repo, 'clean', '-fd')

  await page.goto(app.url)
  await expect(page.getByRole('status')).toContainText('Working tree clean', {
    timeout: 30_000,
  })
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  await expect(page.locator('[data-section="workflow"] .section-count')).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: 'Source Control workflow' }).getByText('Working tree clean'),
  ).toHaveCount(0)
  await expect(page.locator('[data-section="changes"]')).toHaveCount(0)
  await expect(page.locator('diffs-container')).toHaveCount(0)
})
