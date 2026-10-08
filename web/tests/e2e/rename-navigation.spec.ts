import { test, expect } from './fixtures.js'

test('finishing a dismissed rename preserves newer tabs and navigation', async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.locator('span[data-connection-state]')).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.locator('[data-section="repository"]').click()
  const tree = page.locator('#gitna-repository-tree__tree')
  const main = tree.getByRole('treeitem', { name: 'main.txt', exact: true })
  await main.click()
  await main.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename entry' })
  await dialog.getByLabel('Repository-relative path').fill('renamed.txt')

  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/worktree/entry', async (route) => {
    if (route.request().method() === 'PATCH') await pending
    await route.continue()
  })
  const request = page.waitForRequest(
    (request) => request.method() === 'PATCH' && request.url().endsWith('/api/v1/worktree/entry'),
  )
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await request
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Close main.txt', exact: true }).click()
  await tree.getByRole('treeitem', { name: 'feature.txt', exact: true }).click()
  release()

  await expect(tree.getByRole('treeitem', { name: 'renamed.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'feature.txt', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: 'main.txt', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toHaveCount(0)
})
