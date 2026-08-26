import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.js'

function collectErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('continuous Pierre CodeView renders the complete working-tree review', async ({
  page,
  app,
}) => {
  const errors = collectErrors(page)
  await page.goto(app.url)
  const review = page.getByRole('region', { name: 'Review' })
  await expect(review).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Repository path' })).toHaveValue(app.repo)
  await expect(page.getByRole('button', { name: 'Collapse all files' })).toBeVisible()
  await expect(page.locator('diffs-container')).toHaveCount(5, { timeout: 30_000 })
  await expect(page.getByText('modified.txt', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('two-hunk.txt', { exact: true }).last()).toBeVisible()
  await page.locator('[data-section="repository"]').click()
  await expect(
    page
      .locator('#gitna-repository-tree__tree')
      .getByRole('treeitem', { name: 'large-untracked.txt', exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Display settings' }).click()
  await expect(page.getByRole('menu', { name: 'Display settings' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Backgrounds' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Theme settings' }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Collapse all files' }).click()
  await expect(page.getByRole('button', { name: 'Expand all files' })).toBeVisible()
  await page.getByRole('button', { name: 'Expand all files' }).click()
  if (process.env.GITNA_CAPTURE_M3) await page.screenshot({ path: '/tmp/gitna-m3-desktop.png' })
  expect(errors).toEqual([])
})

test('narrow review switches to a single usable CodeView surface', async ({ page, app }) => {
  const errors = collectErrors(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible()
  await expect(page.locator('diffs-container').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.code-view')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Switch to unified view' })).toHaveCount(0)
  const geometry = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    reviewWidth: document
      .querySelector<HTMLElement>('[aria-label="Review"]')
      ?.getBoundingClientRect().width,
    reviewHeight: document
      .querySelector<HTMLElement>('[aria-label="Review"]')
      ?.getBoundingClientRect().height,
    codeViews: document.querySelectorAll('.code-view').length,
  }))
  expect(geometry.bodyWidth).toBe(geometry.viewportWidth)
  expect(geometry.bodyHeight).toBe(geometry.viewportHeight)
  expect(geometry.reviewWidth).toBe(390)
  expect(geometry.reviewHeight).toBe(844)
  expect(geometry.codeViews).toBe(1)
  if (process.env.GITNA_CAPTURE_M3) await page.screenshot({ path: '/tmp/gitna-m3-narrow.png' })
  expect(errors).toEqual([])
})
