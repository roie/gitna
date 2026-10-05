import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

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
