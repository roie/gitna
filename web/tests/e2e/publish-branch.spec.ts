import { execFileSync } from 'node:child_process'
import { test, expect } from './fixtures.js'

// Reconciliation may still be inside route.fetch() when the assertions finish.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' })
})

for (const branch of ['', ' \t ']) {
  test(`publish refuses blank error branch ${JSON.stringify(branch)}`, async ({ page, app }) => {
    const submitted: unknown[] = []
    await page.route('**/api/v1/operations?op=push', (route) =>
      route.fulfill({
        status: 409,
        json: { error: 'Cannot publish without a branch', code: 'no-upstream', branch },
      }),
    )
    await page.route('**/api/v1/operations?op=push-upstream', (route) => {
      submitted.push(route.request().postDataJSON())
      return route.fulfill({ json: { ok: true } })
    })
    await page.goto(app.url)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Push', exact: true }).click()
    await expect(page.getByText('Cannot publish without a branch', { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(submitted).toEqual([])
  })
}

for (const headBranch of ['', ' \t ']) {
  test(`publish refuses blank snapshot fallback ${JSON.stringify(headBranch)}`, async ({
    page,
    app,
  }) => {
    await page.route('**/api/v1/snapshot', async (route) => {
      const response = await route.fetch()
      await route.fulfill({ json: { ...(await response.json()), headBranch, upstream: null } })
    })
    await page.route('**/api/v1/operations?op=push', (route) =>
      route.fulfill({
        status: 409,
        json: { error: 'No local branch to publish', code: 'no-upstream' },
      }),
    )
    await page.goto(app.url)
    await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Publish branch', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Push', exact: true }).click()
    await expect(page.getByText('No local branch to publish', { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
}

test('publish submits an attached branch to the selected remote', async ({ page, app }) => {
  execFileSync('git', ['-C', app.repo, 'switch', '-c', 'topic'])
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Publish branch', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Publish topic', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Publish remote' })).toHaveValue('origin')
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(
    execFileSync('git', ['-C', app.repo, 'rev-parse', '--symbolic-full-name', '@{u}'], {
      encoding: 'utf8',
    }).trim(),
  ).toBe('refs/remotes/origin/topic')
})
