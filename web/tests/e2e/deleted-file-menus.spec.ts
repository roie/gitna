import { execFileSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures.js'

test('mixed staged modification and worktree deletion disables open and reveal', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'main.txt'), 'staged modification\n')
  execFileSync('git', ['-C', app.repo, 'add', 'main.txt'])
  unlinkSync(join(app.repo, 'main.txt'))
  let revealCalls = 0
  await page.route('**/api/v1/worktree/reveal', async (route) => {
    revealCalls += 1
    await route.fulfill({ status: 204 })
  })
  await page.goto(app.url)
  await expect(page.locator('span[data-connection-state]')).toHaveAttribute(
    'data-connection-state',
    'connected',
  )

  for (const id of ['gitna-unstaged-tree', 'gitna-staged-tree']) {
    const file = page
      .locator(`#${id}__tree`)
      .getByRole('treeitem', { name: 'main.txt', exact: true })
    await expect(file).toBeVisible()
    await file.click({ button: 'right' })
    await expect(
      page.getByRole('menuitem', { name: 'Open in Explorer', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true')
    await expect(
      page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    await file.click()
    await page.getByRole('button', { name: 'More actions for main.txt', exact: true }).click()
    await expect(
      page.getByRole('menuitem', { name: 'Open main.txt in Repository', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('menuitem', { name: 'Reveal in File Manager', exact: true }),
    ).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
  }
  expect(revealCalls).toBe(0)
})
