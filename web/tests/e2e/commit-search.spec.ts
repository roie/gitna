import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures.js'

test('commit palette searches history and opens changes without checkout', async ({
  page,
  app,
}) => {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: app.repo, encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD')
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  const input = dialog.getByRole('combobox', { name: 'Search files and commands' })
  await input.fill('>search commits')
  await dialog.getByRole('option', { name: /Search Commits/ }).click()
  await expect(input).toHaveValue('#')
  await expect(dialog.getByRole('listbox', { name: 'Commits' })).toBeVisible()
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(4)
  await input.fill('#e2e@example.com')
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(4)
  await input.fill('#base fixture')
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await input.fill('#[')
  await expect(dialog.getByRole('status')).toHaveText('No commits match.')
  await input.fill(`#${app.baseOid.slice(0, 3)}`)
  await expect(
    dialog
      .getByRole('listbox')
      .getByRole('option')
      .filter({ hasText: app.baseOid.slice(0, 8) }),
  ).toBeVisible()
  await input.fill(`#${app.baseOid.slice(0, 8)}`)
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  const review = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/review?') && response.url().includes(app.baseOid),
  )
  await input.press('Enter')
  await expect(dialog).not.toBeVisible()
  expect((await review).ok()).toBe(true)
  await expect(page.getByRole('button', { name: 'Collapse diff' }).first()).toBeVisible()
  expect(git('rev-parse', 'HEAD')).toBe(head)
  const revealed = page.locator(`[data-graph-oid="${app.baseOid}"] [data-graph-disclosure]`)
  await expect(revealed).toHaveAttribute('aria-expanded', 'true')
  await expect(revealed).toBeInViewport()

  await page.getByRole('button', { name: 'Graph actions' }).click()
  const menuItems = page.getByRole('menuitem')
  const searchIndex = await menuItems.allTextContents()
  expect(searchIndex.indexOf('Search Commits…')).toBeLessThan(
    searchIndex.indexOf('Load more commits'),
  )
  await page.getByRole('menuitem', { name: 'Search Commits…' }).click()
  await expect(input).toHaveValue('#')
  await input.press('Escape')

  writeFileSync(join(app.repo, '#notes.txt'), 'notes\n')
  await page.getByRole('button', { name: 'Open command palette' }).click()
  await input.fill('\\#notes')
  await expect(dialog.getByRole('option', { name: /#notes.txt/ })).toBeVisible()
})

test('commit search paginates and resets paging for a new query', async ({ page, app }) => {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: app.repo, encoding: 'utf8' }).trim()
  const tree = git('rev-parse', 'HEAD^{tree}')
  let head = git('rev-parse', 'HEAD')
  for (let index = 0; index < 105; index++) {
    head = git('commit-tree', tree, '-p', head, '-m', `pagination ${index}`)
  }
  git('update-ref', 'HEAD', head)
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  const input = dialog.getByRole('combobox', { name: 'Search files and commands' })
  const results = dialog.getByRole('listbox').getByRole('option')
  await input.fill('>toggle sidebar')
  await dialog.getByRole('option', { name: /Toggle Sidebar/ }).click()
  await expect(page.getByRole('button', { name: 'Graph actions' })).not.toBeVisible()
  await page.getByRole('button', { name: 'Open command palette' }).click()
  await input.fill('#pagination')
  await expect(results).toHaveCount(101)
  await dialog.getByRole('option', { name: 'Load more commits' }).click()
  await expect(dialog).toBeVisible()
  await expect(results).toHaveCount(105)
  await expect(dialog.getByRole('option', { name: 'Load more commits' })).toHaveCount(0)
  await input.fill('#base fixture')
  await expect(results).toHaveCount(1)
  await expect(results).toContainText('base fixture')
  const continuation = page.waitForResponse(
    (response) => response.url().includes('/api/v1/graph?') && !response.url().includes('skip=0'),
  )
  await input.press('Enter')
  await expect(dialog).not.toBeVisible()
  expect((await continuation).ok()).toBe(true)
  const revealed = page.locator(`[data-graph-oid="${app.baseOid}"] [data-graph-disclosure]`)
  await expect(revealed).toHaveAttribute('aria-expanded', 'true')
  await expect(revealed).toBeInViewport()
  expect(git('rev-parse', 'HEAD')).toBe(head)
})

test('commit search scope includes other branches and ignores stale responses', async ({
  page,
  app,
}) => {
  const tree = execFileSync('git', ['rev-parse', `${app.baseOid}^{tree}`], {
    cwd: app.repo,
    encoding: 'utf8',
  }).trim()
  const other = execFileSync(
    'git',
    ['commit-tree', tree, '-p', app.baseOid, '-m', 'other branch only'],
    { cwd: app.repo, encoding: 'utf8' },
  ).trim()
  execFileSync('git', ['branch', 'other', other], { cwd: app.repo })
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const dialog = page.getByRole('dialog', { name: 'Command palette' })
  const input = dialog.getByRole('combobox', { name: 'Search files and commands' })
  await input.fill('#other branch only')
  await expect(dialog.getByRole('status')).toHaveText('No commits match.')
  const toggle = dialog.getByRole('button', { name: 'Include All Branches' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(dialog.getByRole('button', { name: 'Exclude Other Branches' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await expect(dialog.getByRole('listbox').getByRole('option')).toContainText('other branch only')
  await expect(dialog.getByRole('listbox').getByRole('option')).toContainText('Branches: other')
  await expect(dialog.getByRole('listbox').getByRole('option')).toContainText(/\d{1,2}:\d{2}/)
  await dialog.getByRole('button', { name: 'Exclude Other Branches' }).click()
  await expect(dialog.getByRole('status')).toHaveText('No commits match.')
  await dialog.getByRole('button', { name: 'Include All Branches' }).click()
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/v1/commits/search?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') === 'base fixture') await held
    await route.continue().catch(() => {})
  })
  const requested = page.waitForRequest((request) => request.url().includes('q=base+fixture'))
  await input.fill('#base fixture')
  await requested
  await input.fill('#main change')
  await expect(dialog.getByRole('listbox').getByRole('option')).toHaveCount(1)
  await expect(dialog.getByRole('listbox').getByRole('option')).toContainText('main change')
  release()
  await expect(dialog.getByRole('listbox').getByRole('option')).toContainText('main change')
})
