import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test as base, expect } from '@playwright/test'

const test = base.extend<{ localApp: { url: string; repo: string } }>({
  localApp: async ({ browser }, use) => {
    expect(browser.isConnected()).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'gitna-menus-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Menu Tests')
    git('config', 'user.email', 'menus@example.test')
    mkdirSync(join(repo, 'nested/deeper'), { recursive: true })
    writeFileSync(join(repo, 'nested/deeper/file.txt'), 'nested\n')
    writeFileSync(join(repo, 'main.txt'), 'base\n')
    writeFileSync(
      join(repo, 'two-hunk.txt'),
      Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`).join(''),
    )
    git('add', '.')
    git('commit', '-qm', 'base')
    writeFileSync(join(repo, 'main.txt'), 'committed\n')
    git('commit', '-qam', 'second')
    git('branch', 'other', 'HEAD~1')
    writeFileSync(
      join(repo, 'two-hunk.txt'),
      Array.from({ length: 60 }, (_, i) =>
        i === 1 ? 'TWO\n' : i === 49 ? 'FIFTY\n' : `line ${i + 1}\n`,
      ).join(''),
    )
    const child = spawn(process.env.GITNA_E2E_BINARY!, [repo], {
      env: { ...process.env, GITNA_NO_BROWSER: '1', XDG_CONFIG_HOME: join(root, 'config') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const lines = createInterface({ input: child.stdout! })
        const timer = setTimeout(() => reject(new Error('Gitna startup timed out')), 15000)
        lines.on('line', (line) => {
          const match = line.match(/^URL\s+(http:\/\/\S+)$/)
          if (match) {
            clearTimeout(timer)
            lines.close()
            resolve(match[1])
          }
        })
        child.once('error', reject)
      })
      await use({ url, repo })
    } finally {
      if (child.exitCode == null) {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
})

for (const [action, title] of [
  ['New File', 'New file'],
  ['New Folder', 'New folder'],
]) {
  test(`${action} supports keyboard cancellation and restores Explorer focus`, async ({
    page,
    localApp,
  }) => {
    await page.goto(localApp.url)
    const trigger = page.getByRole('button', { name: 'Explorer actions', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const item = page.getByRole('menuitem', { name: action, exact: true })
    await item.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('textbox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
}

test('Explorer Rename is unavailable without a selection and remaps the selected open file', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  const trigger = page.getByRole('button', { name: 'Explorer actions', exact: true })
  await trigger.click()
  await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await page.keyboard.press('Escape')
  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'main.txt', exact: true })
    .click()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename entry' })
  await dialog.getByRole('textbox').fill('renamed.txt')
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(readFileSync(join(localApp.repo, 'renamed.txt'), 'utf8')).toBe('committed\n')
})

test('Expand all follows lazily discovered directories and Collapse all stops it', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  await page.locator('[data-section="repository"]').click()
  const trigger = page.getByRole('button', { name: 'Explorer actions', exact: true })
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Expand all folders', exact: true }).click()
  const tree = page.locator('#gitna-repository-tree__tree')
  await expect(tree.getByRole('treeitem', { name: 'file.txt', exact: true })).toBeVisible()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Collapse all folders', exact: true }).click()
  await expect(tree.getByRole('treeitem', { name: 'file.txt', exact: true })).toHaveCount(0)
})

test('Failed file creation keeps its error in the dialog, not the workflow', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  const trigger = page.getByRole('button', { name: 'Explorer actions', exact: true })
  await trigger.click()
  await page.getByRole('menuitem', { name: 'New File', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New file', exact: true })
  await dialog.getByRole('textbox').fill('main.txt')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('Tags and stashes show empty lists; list failures stay visible with Retry', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  const trigger = page.getByRole('button', { name: 'More actions', exact: true })
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Tags…', exact: true }).click()
  const tags = page.getByRole('dialog', { name: 'Tags', exact: true })
  await expect(tags.getByText('No tags', { exact: true })).toBeVisible()
  await tags.getByRole('button', { name: 'Close dialog' }).click()
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Stashes…', exact: true }).click()
  const stash = page.getByRole('dialog', { name: 'Stashes', exact: true })
  await expect(stash.getByText('No stashes', { exact: true })).toBeVisible()
  await stash.getByRole('button', { name: 'Close dialog' }).click()
  await page.route('**/api/v1/tags', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'tag read failed', code: 'internal' }),
    }),
  )
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Tags…', exact: true }).click()
  await expect(tags.getByRole('alert')).toContainText('tag read failed')
  await page.unroute('**/api/v1/tags')
  await tags.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(tags.getByRole('alert')).toHaveCount(0)
})

test('Hunk actions reload after partial staging and across scopes', async ({ page, localApp }) => {
  await page.goto(localApp.url)
  const fileMenu = page.getByRole('button', { name: 'More actions for two-hunk.txt', exact: true })
  const loadHunks = async (label: 'Stage' | 'Unstage' = 'Stage') => {
    const hunk = page.getByRole('menuitem', {
      name: `${label} hunk 1 in two-hunk.txt`,
      exact: true,
    })
    await expect(async () => {
      if ((await fileMenu.getAttribute('aria-expanded')) !== 'true') await fileMenu.click()
      const load = page.getByRole('menuitem', {
        name: 'Show hunk actions for two-hunk.txt',
        exact: true,
      })
      if ((await load.isVisible()) && (await load.isEnabled())) {
        const response = page.waitForResponse((response) =>
          new URL(response.url()).pathname.endsWith('/diff'),
        )
        await load.focus()
        await page.keyboard.press('Enter')
        await response
        if ((await fileMenu.getAttribute('aria-expanded')) !== 'true') await fileMenu.click()
      }
      await expect(hunk).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 10000 })
  }
  await loadHunks()
  await page.getByRole('menuitem', { name: 'Stage hunk 1 in two-hunk.txt', exact: true }).click()
  const unstaged = page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'two-hunk.txt', exact: true })
  await expect(page.locator('#gitna-staged-tree__tree')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Stage file two-hunk.txt', exact: true }),
  ).toBeEnabled()
  await expect(page.locator('.code-view').getByText('TWO', { exact: true })).toHaveCount(0)
  await expect(page.locator('.code-view').getByText('FIFTY', { exact: true })).toBeVisible()
  await loadHunks()
  await expect(
    page.getByRole('menuitem', { name: 'Stage hunk 2 in two-hunk.txt', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Stage hunk 1 in two-hunk.txt', exact: true }).click()
  await expect(unstaged).toHaveCount(0)
  const staged = page
    .locator('#gitna-staged-tree__tree')
    .getByRole('treeitem', { name: 'two-hunk.txt', exact: true })
  await staged.click()
  await expect(
    page.getByRole('button', { name: 'Unstage file two-hunk.txt', exact: true }),
  ).toBeEnabled()
  await loadHunks('Unstage')
  await page.getByRole('menuitem', { name: 'Unstage hunk 1 in two-hunk.txt', exact: true }).click()
  await expect(unstaged).toBeVisible()
  expect(
    execFileSync('git', ['diff', '--cached'], { cwd: localApp.repo, encoding: 'utf8' }),
  ).toContain('FIFTY')
  expect(execFileSync('git', ['diff'], { cwd: localApp.repo, encoding: 'utf8' })).toContain('TWO')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Compare failures appear in both the dialog and review surface and can be retried', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Compare refs…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare references', exact: true })
  await dialog.getByRole('combobox', { name: 'Compare to', exact: true }).selectOption('other')
  await page.route('**/api/v1/compare*', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'compare read failed' }),
    }),
  )
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('compare read failed')
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByText('compare read failed', { exact: true })).toBeVisible()
  await expect(page.getByText('No changes', { exact: true })).toHaveCount(0)
  await page.unroute('**/api/v1/compare*')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByText('compare read failed', { exact: true })).toHaveCount(0)
})
