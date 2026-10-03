import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures.js'

test('startup enables current repository actions before the exact file count', async ({
  page,
  app,
}) => {
  let releaseCount!: () => void
  const pendingCount = new Promise<void>((resolve) => {
    releaseCount = resolve
  })
  let requested = false
  await page.route('**/api/v1/files/count?*', async (route) => {
    requested = true
    await pendingCount
    const generation = Number(new URL(route.request().url()).searchParams.get('generation'))
    await route.fulfill({ json: { generation, total: 59 } })
  })
  try {
    await page.goto(app.url)
    await expect.poll(() => requested).toBe(true)
    await expect(page.getByRole('region', { name: 'Review', exact: true })).toHaveAttribute(
      'data-connection-state',
      'connected',
    )
    await expect(page.getByRole('button', { name: 'Open command palette' })).toBeEnabled()
    await expect(
      page.getByRole('button', { name: 'Stage file modified.txt', exact: true }),
    ).toBeEnabled()
    await page.getByRole('button', { name: 'Stage file modified.txt', exact: true }).click()
    await expect
      .poll(() =>
        execFileSync('git', ['show', ':modified.txt'], { cwd: app.repo, encoding: 'utf8' }),
      )
      .toBe('unstaged change\n')
    releaseCount()
    await expect(page.locator('[data-section="repository"] .section-count')).toHaveAttribute(
      'title',
      '59 files in Repository',
    )
  } finally {
    releaseCount()
  }
})
