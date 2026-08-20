import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

async function reviewPatch(page: Page, scope: 'staged' | 'unstaged') {
  return page.evaluate(async (reviewScope) => {
    const response = await fetch(`api/v1/review?scope=${reviewScope}`)
    if (!response.ok) throw new Error(`review request failed: ${response.status}`)
    return ((await response.json()) as { patch: string }).patch
  }, scope)
}

test('staging loop preserves VS Code section order and visibility', async ({ page, app }) => {
  await page.goto(app.url)
  const staged = page.locator('[data-section="staged"]')
  const changes = page.locator('[data-section="changes"]')
  const graph = page.locator('[data-section="graph"]')

  await expect(staged).toBeVisible()
  await expect(changes).toBeVisible()
  const order = await page.locator('.section-title').allTextContents()
  expect(order.indexOf('Staged Changes')).toBeLessThan(order.indexOf('Changes'))
  expect(order.indexOf('Changes')).toBeLessThan(order.indexOf('Graph'))
  await expect(page.locator('.review-header .identity')).toContainText('repo / main')
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-m4-desktop.png', fullPage: true })
  }
  await page.getByRole('button', { name: 'Search Changes' }).click()
  const treeSearch = page.locator('[data-file-tree-search-container][data-open="true"] input')
  await expect(treeSearch).toBeVisible()
  await treeSearch.fill('modified')
  await expect(page.getByRole('treeitem', { name: 'modified.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Search Changes' }).click()

  await page.getByRole('treeitem', { name: 'modified.txt', exact: true }).click()
  await page.getByRole('button', { name: 'Discard file modified.txt' }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText(app.repo)
  await expect(confirmation).toContainText('main')
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await page.getByRole('button', { name: 'Stage file modified.txt' }).click()
  await expect.poll(async () => (await staged.textContent()) ?? '').toContain('4')
  await expect(page.getByRole('treeitem', { name: 'modified.txt', exact: true })).toBeVisible()

  for (const path of ['modified.txt', 'delete.txt', 'rename-new.txt', 'staged.txt']) {
    await page.getByRole('treeitem', { name: path, exact: true }).click()
    await page.getByRole('button', { name: `Unstage file ${path}` }).click()
  }

  await expect(staged).toHaveCount(0)
  await expect(changes).toBeVisible()
  await expect(changes).toHaveAttribute('aria-expanded', 'true')
  await expect(graph).toBeVisible()

  await page.keyboard.press('F6')
  await expect(changes).toBeFocused()
  await page.keyboard.press('Shift+F6')
  await expect(graph).toBeFocused()
  await page.keyboard.press('F1')
  await expect(page.getByText('Refresh Graph', { exact: true })).toBeVisible()
  await page.keyboard.press('F1')
  await expect(page.getByText('Refresh Graph', { exact: true })).not.toBeVisible()
})

test('tree navigation and Pierre header hunk actions preserve the other hunk', async ({
  page,
  app,
}) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto(app.url)
  await page.getByRole('treeitem', { name: 'two-hunk.txt', exact: true }).click()

  const renderedFile = page.locator('diffs-container').filter({ hasText: 'two-hunk.txt' })
  await expect(renderedFile).toBeVisible()
  await expect
    .poll(async () => Math.round((await renderedFile.boundingBox())?.y ?? 999))
    .toBeLessThan(100)

  await page.getByRole('button', { name: 'Show hunk actions for two-hunk.txt' }).click()
  await page.getByRole('button', { name: 'Stage hunk 1 in two-hunk.txt' }).click()

  await expect.poll(() => reviewPatch(page, 'staged')).toContain('+TWO')
  const stagedPatch = await reviewPatch(page, 'staged')
  const unstagedPatch = await reviewPatch(page, 'unstaged')
  expect(stagedPatch).not.toContain('+FIFTY')
  expect(unstagedPatch).toContain('+FIFTY')

  await page.keyboard.press('Control+Shift+L')
  await expect(page.getByRole('button', { name: 'Switch to split view' })).toBeVisible()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(
    page.getByRole('treeitem', { name: 'large-untracked.txt', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  expect(browserErrors).toEqual([])
})

test('commit text survives hook failure and clears after authoritative success', async ({
  page,
  app,
}) => {
  const hook = join(app.repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho policy rejects this commit >&2\nexit 1\n')
  chmodSync(hook, 0o755)

  await page.goto(app.url)
  const composer = page.getByPlaceholder('Commit message')
  await composer.fill('milestone commit')
  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'policy rejects this commit' }),
  ).toBeVisible()
  await expect(composer).toHaveValue('milestone commit')

  rmSync(hook)
  await page.keyboard.press('Control+Shift+C')
  await expect(composer).toBeFocused()
  await page.keyboard.press('Control+Enter')
  await expect(composer).toHaveValue('')
  await expect(page.getByText('milestone commit', { exact: true })).toBeVisible()
})

test('narrow Source Control uses a dismissible overlay without squeezing review', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(app.url)
  const review = page.getByRole('region', { name: 'Review' })
  await expect(review).toBeVisible()
  const sourceControl = page.locator('aside[aria-label="Source Control"]')
  await expect(sourceControl).not.toBeVisible()

  await page.getByRole('button', { name: 'Open Source Control' }).click()
  await expect(sourceControl).toBeVisible()
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  await expect(review).toHaveCSS('width', '390px')
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-m4-mobile-overlay.png', fullPage: true })
  }

  await page
    .locator('.source-control')
    .getByRole('button', { name: 'Close Source Control' })
    .click()
  await expect(sourceControl).not.toBeVisible()
  await expect(review).toHaveCSS('width', '390px')
})
