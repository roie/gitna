import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures.js'

test('reveals clicked files and folders without changing the active view', async ({
  page,
  app,
}) => {
  mkdirSync(join(app.repo, 'nested'))
  writeFileSync(join(app.repo, 'nested', 'file.txt'), 'nested content\n')
  const paths: string[] = []
  await page.route('**/api/v1/worktree/reveal', async (route) => {
    paths.push((route.request().postDataJSON() as { path: string }).path)
    await route.fulfill({ status: 204 })
  })
  await page.goto(app.url)
  await expect(page.locator('span[data-connection-state]')).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.locator('[data-section="repository"]').click()
  const tree = page.locator('#gitna-repository-tree__tree')
  const main = tree.getByRole('treeitem', { name: 'main.txt', exact: true })
  await main.click()
  const tab = page.getByRole('tab', { name: 'main.txt', exact: true })
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await tree.getByRole('treeitem', { name: 'feature.txt', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.at(-1)).toBe('feature.txt')
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  await tree.getByRole('treeitem', { name: 'nested', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.at(-1)).toBe('nested/')
  await tab.focus()
  await tab.press('Shift+F10')
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.at(-1)).toBe('main.txt')

  const changes = page.locator('#gitna-unstaged-tree__tree')
  const modified = changes.getByRole('treeitem', { name: 'modified.txt', exact: true })
  await modified.click()
  await page.getByRole('button', { name: 'More actions for modified.txt', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.at(-1)).toBe('modified.txt')
  await expect(
    page.getByRole('button', { name: 'More actions for modified.txt', exact: true }),
  ).toBeVisible()
  await modified.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.length).toBe(5)

  const directory = changes.getByRole('treeitem', { name: 'nested', exact: true })
  await directory.focus()
  await directory.press('Shift+F10')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.at(-1)).toBe('nested')
  await directory.press('ArrowRight')
  await directory.press('ArrowDown')
  await expect(changes.getByRole('treeitem', { name: 'file.txt', exact: true })).toBeFocused()

  const staged = page.locator('#gitna-staged-tree__tree')
  await staged.getByRole('treeitem', { name: 'staged.txt', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect.poll(() => paths.at(-1)).toBe('staged.txt')
  await staged.getByRole('treeitem', { name: 'delete.txt', exact: true }).click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  await page.unroute('**/api/v1/worktree/reveal')
  await page.route('**/api/v1/worktree/reveal', (route) =>
    route.fulfill({ status: 400, json: { error: 'File manager unavailable' } }),
  )
  await tab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }).click()
  await expect(page.getByText('File manager unavailable', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('>new file')
  await palette.getByRole('combobox', { name: 'Search files and commands' }).press('Enter')
  await page.getByRole('tab', { name: 'Untitled-1', exact: true }).click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true')
})
