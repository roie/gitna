import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test as base, expect, type Page } from '@playwright/test'
import { stopGitna } from './fixtures.js'

const test = base.extend<{ localApp: { url: string; repo: string } }>({
  localApp: async ({ browser, context }, use) => {
    expect(browser.isConnected()).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'gitna-menus-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
    git('init', '-q', '-b', 'main')
    git('config', 'core.autocrlf', 'false')
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
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        APPDATA: join(root, 'config'),
        GITNA_NO_BROWSER: '1',
        XDG_CONFIG_HOME: join(root, 'config'),
      },
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
      try {
        await context.close()
      } finally {
        try {
          await stopGitna(child)
        } finally {
          rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
        }
      }
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
    await expect(trigger).toBeEnabled()
    await trigger.focus()
    await page.keyboard.press('Enter')
    const item = page.getByRole('menuitem', { name: action, exact: true })
    await expect(item).toBeEnabled()
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
  const loadHunks = (label: 'Stage' | 'Unstage' = 'Stage') => hunkMenu(page, label)
  const applyHunk = async (label: 'Stage' | 'Unstage') => {
    await expect(async () => {
      await loadHunks(label)
      const response = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).searchParams.get('op') === 'patch',
      )
      await page
        .getByRole('menuitem', { name: `${label} hunk 1 in two-hunk.txt`, exact: true })
        .click()
      const result = await response
      if (result.status() === 409) {
        expect((await result.json()).code).toBe('stale-patch')
      }
      expect(result.ok()).toBe(true)
    }).toPass({ timeout: 20000 })
  }
  await applyHunk('Stage')
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
  await applyHunk('Stage')
  await expect(unstaged).toHaveCount(0)
  const staged = page
    .locator('#gitna-staged-tree__tree')
    .getByRole('treeitem', { name: 'two-hunk.txt', exact: true })
  await staged.click()
  await expect(
    page.getByRole('button', { name: 'Unstage file two-hunk.txt', exact: true }),
  ).toBeEnabled()
  await applyHunk('Unstage')
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

async function sourceMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

async function explorerMenu(page: Page, item: string) {
  await page.getByRole('button', { name: 'Explorer actions', exact: true }).click()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

for (const kind of ['tag', 'stash'] as const) {
  test(`Nested ${kind} confirmation restores focus on Cancel, Escape and removal`, async ({
    page,
    localApp,
  }) => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: localApp.repo, encoding: 'utf8' })
    if (kind === 'tag') git('tag', 'edge-tag')
    else git('stash', 'push', '-qm', 'edge-stash')
    await page.goto(localApp.url)
    await sourceMenu(page, kind === 'tag' ? 'Tags…' : 'Stashes…')
    const parent = page.getByRole('dialog', {
      name: kind === 'tag' ? 'Tags' : 'Stashes',
      exact: true,
    })
    const trigger = parent.getByRole('button', {
      name: kind === 'tag' ? 'Delete' : 'Drop',
      exact: true,
    })
    for (const dismissal of ['Cancel', 'Escape']) {
      await trigger.click()
      const confirm = page.getByRole('alertdialog')
      await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
      if (dismissal === 'Cancel')
        await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      else await page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(trigger).toBeFocused()
      expect(kind === 'tag' ? git('tag', '--list') : git('stash', 'list')).not.toBe('')
    }
    await trigger.click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: kind === 'tag' ? 'Delete tag' : 'Drop stash', exact: true })
      .click()
    await expect(
      parent.getByText(kind === 'tag' ? 'No tags' : 'No stashes', { exact: true }),
    ).toBeVisible()
    expect(kind === 'tag' ? git('tag', '--list') : git('stash', 'list')).toBe('')
    await expect(parent.getByRole('button', { name: 'Close dialog' })).toBeFocused()
  })
}

for (const interruption of ['Collapse all folders', 'Show as List']) {
  test(`Pending lazy expansion is canceled by ${interruption}`, async ({ page, localApp }) => {
    await page.goto(localApp.url)
    await page.locator('[data-section="repository"]').click()
    const started = barrier()
    const resume = barrier()
    await page.route('**/api/v1/directory?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('path') !== 'nested')
        return route.continue()
      const response = await route.fetch()
      started.release()
      await resume.promise
      await route.fulfill({ response })
    })
    try {
      await explorerMenu(page, 'Expand all folders')
      await started.promise
      await explorerMenu(page, interruption)
      const response = page.waitForResponse(
        (response) => new URL(response.url()).searchParams.get('path') === 'nested',
      )
      resume.release()
      await response
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      )
      await expect(
        page
          .locator('#gitna-repository-tree__tree')
          .getByRole('treeitem', { name: 'file.txt', exact: true }),
      ).toHaveCount(0)
      if (interruption === 'Show as List') await explorerMenu(page, 'Show as Tree')
      await expect(
        page
          .locator('#gitna-repository-tree__tree')
          .getByRole('treeitem', { name: 'nested', exact: true }),
      ).toHaveAttribute('aria-expanded', 'false')
      await page.unroute('**/api/v1/directory?*')
      await explorerMenu(page, 'Expand all folders')
      await expect(
        page
          .locator('#gitna-repository-tree__tree')
          .getByRole('treeitem', { name: 'nested', exact: true }),
      ).toHaveAttribute('aria-expanded', 'true')
      await expect(
        page
          .locator('#gitna-repository-tree__tree')
          .getByRole('treeitem', { name: 'file.txt', exact: true }),
      ).toBeVisible()
    } finally {
      resume.release()
    }
  })
}

test('Failed lazy directory load settles without retries and explicit expansion recovers', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  await page.locator('[data-section="repository"]').click()
  let failures = 0
  await page.route('**/api/v1/directory?*', (route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== 'nested')
      return route.continue()
    failures++
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'edge directory failure' }),
    })
  })
  await explorerMenu(page, 'Expand all folders')
  await expect(page.getByText('edge directory failure', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Explorer actions', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Show hidden files', exact: true }).click()
  await page.keyboard.press('Escape')
  await explorerMenu(page, 'Collapse all folders')
  expect(failures).toBe(1)
  await page.unroute('**/api/v1/directory?*')
  await explorerMenu(page, 'Expand all folders')
  await expect(
    page
      .locator('#gitna-repository-tree__tree')
      .getByRole('treeitem', { name: 'file.txt', exact: true }),
  ).toBeVisible()
  expect(failures).toBe(1)
})

test('Dismissed pending tag failure cannot contaminate a new operation dialog', async ({
  page,
  localApp,
}) => {
  await page.goto(localApp.url)
  const started = barrier()
  const resume = barrier()
  const finished = barrier()
  await page.route('**/api/v1/operations?op=create-tag', async (route) => {
    started.release()
    await resume.promise
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'old tag operation failure' }),
    })
    finished.release()
  })
  try {
    await sourceMenu(page, 'Tags…')
    const tags = page.getByRole('dialog', { name: 'Tags', exact: true })
    await tags.getByRole('textbox', { name: 'New tag name' }).fill('pending-tag')
    await tags.getByRole('button', { name: 'Create', exact: true }).click()
    await started.promise
    await tags.getByRole('button', { name: 'Close dialog' }).click()
    await sourceMenu(page, 'Stashes…')
    const stash = page.getByRole('dialog', { name: 'Stashes', exact: true })
    await expect(stash).toBeVisible()
    resume.release()
    await finished.promise
    await expect(stash.getByRole('alert')).toHaveCount(0)
    await expect(stash.getByRole('button', { name: 'Stash', exact: true })).toBeEnabled()
    await stash.getByRole('button', { name: 'Close dialog' }).click()
    await sourceMenu(page, 'Tags…')
    await expect(tags.getByRole('alert')).toHaveCount(0)
    expect(execFileSync('git', ['tag', '--list'], { cwd: localApp.repo, encoding: 'utf8' })).toBe(
      '',
    )
  } finally {
    resume.release()
  }
})

for (const operation of ['merge', 'rebase', 'cherry-pick'] as const) {
  test(`Local ${operation} conflict reports target, preserves Git state and permits recovery`, async ({
    page,
    localApp,
  }) => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: localApp.repo, encoding: 'utf8' })
    git('restore', 'two-hunk.txt')
    git('checkout', '-q', 'other')
    writeFileSync(join(localApp.repo, 'main.txt'), 'conflicting topic\n')
    git('commit', '-qam', 'conflicting topic')
    const target = git('rev-parse', 'HEAD').trim()
    git('checkout', '-q', 'main')
    let original = git('rev-parse', 'HEAD').trim()
    expect(git('remote')).toBe('')
    await page.goto(localApp.url)
    if (operation === 'cherry-pick') {
      await page.locator('[data-section="graph"]').click()
      await page.getByRole('button', { name: 'Actions for base', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(
        page.getByRole('button', { name: 'Actions for base', exact: true }),
      ).toBeFocused()
      git('merge', '-q', '--no-commit', '-s', 'ours', 'other')
      git('commit', '-qm', 'expose topic history')
      original = git('rev-parse', 'HEAD').trim()
      await page.getByRole('button', { name: 'Refresh Graph', exact: true }).click()
      await page.getByRole('button', { name: 'Actions for conflicting topic', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Cherry-pick', exact: true }).click()
      await expect(
        page
          .getByRole('alert')
          .filter({ hasText: /conflict|could not apply/i })
          .first(),
      ).toBeVisible()
    } else {
      await sourceMenu(page, 'Merge or rebase…')
      const dialog = page.getByRole('dialog', { name: 'Merge or rebase', exact: true })
      const button = dialog.getByRole('button', {
        name: operation === 'merge' ? 'Merge' : 'Rebase',
        exact: true,
      })
      await expect(button).toBeDisabled()
      await dialog.getByRole('combobox').selectOption('other')
      await expect(button).toBeEnabled()
      await button.click()
      if (operation === 'merge') {
        await expect(dialog).toHaveCount(0)
        await expect(page.getByText('Merge in progress', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
      } else {
        await expect(dialog.getByRole('alert')).toContainText(/conflict|could not apply/i)
        await expect(dialog.getByRole('combobox')).toHaveValue('other')
        await expect(button).toBeEnabled()
        await dialog.getByRole('button', { name: 'Close dialog' }).click()
      }
    }
    expect(git('diff', '--name-only', '--diff-filter=U').trim()).toBe('main.txt')
    if (operation !== 'rebase')
      expect(
        git('rev-parse', `${operation === 'merge' ? 'MERGE_HEAD' : 'CHERRY_PICK_HEAD'}`).trim(),
      ).toBe(target)
    if (operation === 'rebase') {
      const onto = git('rev-parse', '--git-path', 'rebase-merge/onto').trim()
      expect(readFileSync(join(localApp.repo, onto), 'utf8').trim()).toBe(target)
    }
    expect(readFileSync(join(localApp.repo, 'main.txt'), 'utf8')).toContain('<<<<<<<')
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Abort', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Abort', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Abort', exact: true })).toHaveCount(0)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('rev-parse', 'HEAD').trim()).toBe(original)
    await page.getByRole('button', { name: 'Refresh Graph', exact: true }).click()
    await sourceMenu(page, 'Merge or rebase…')
    await expect(
      page.getByRole('dialog', { name: 'Merge or rebase', exact: true }).getByRole('alert'),
    ).toHaveCount(0)
  })
}

async function hunkMenu(page: Page, label = 'Stage') {
  const menu = page.getByRole('button', {
    name: 'More actions for two-hunk.txt',
    exact: true,
    includeHidden: true,
  })
  await expect(async () => {
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click()
    const load = page.getByRole('menuitem', {
      name: 'Show hunk actions for two-hunk.txt',
      exact: true,
    })
    if (await load.isVisible()) await load.click({ timeout: 1000 })
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click()
    await expect(
      page.getByRole('menuitem', { name: `${label} hunk 1 in two-hunk.txt` }),
    ).toBeEnabled({ timeout: 1000 })
  }).toPass({ timeout: 20000 })
}

test('Pending hunk load cannot populate a different scope', async ({ page, localApp }) => {
  execFileSync('git', ['add', 'two-hunk.txt'], { cwd: localApp.repo })
  writeFileSync(
    join(localApp.repo, 'two-hunk.txt'),
    readFileSync(join(localApp.repo, 'two-hunk.txt'), 'utf8').replace('line 20\n', 'TWENTY\n'),
  )
  await page.goto(localApp.url)
  const started = barrier()
  const resume = barrier()
  await page.route('**/api/v1/diff?*', async (route) => {
    const url = new URL(route.request().url())
    if (
      url.searchParams.get('scope') !== 'unstaged' ||
      url.searchParams.get('path') !== 'two-hunk.txt'
    )
      return route.continue()
    const response = await route.fetch()
    started.release()
    await resume.promise
    await route.fulfill({ response })
  })
  try {
    const menu = page.getByRole('button', { name: 'More actions for two-hunk.txt', exact: true })
    await menu.click()
    await page
      .getByRole('menuitem', { name: 'Show hunk actions for two-hunk.txt', exact: true })
      .click()
    await started.promise
    await page
      .locator('#gitna-staged-tree__tree')
      .getByRole('treeitem', { name: 'two-hunk.txt', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: 'Unstage file two-hunk.txt', exact: true }),
    ).toBeVisible()
    const response = page.waitForResponse(
      (response) =>
        new URL(response.url()).searchParams.get('scope') === 'unstaged' &&
        new URL(response.url()).pathname.endsWith('/diff'),
    )
    resume.release()
    await response
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await menu.click()
    await expect(
      page.getByRole('menuitem', { name: 'Show hunk actions for two-hunk.txt', exact: true }),
    ).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: /Unstage hunk/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.unroute('**/api/v1/diff?*')
    await hunkMenu(page, 'Unstage')
    await expect(
      page.getByRole('menuitem', { name: 'Unstage hunk 2 in two-hunk.txt', exact: true }),
    ).toBeVisible()
    expect(
      execFileSync('git', ['diff', '--cached'], { cwd: localApp.repo, encoding: 'utf8' }),
    ).toContain('FIFTY')
    expect(execFileSync('git', ['diff'], { cwd: localApp.repo, encoding: 'utf8' })).toContain(
      'TWENTY',
    )
  } finally {
    resume.release()
  }
})

test('Same-scope file changes invalidate loaded hunk actions', async ({ page, localApp }) => {
  await page.goto(localApp.url)
  await hunkMenu(page)
  await expect(
    page.getByRole('menuitem', { name: 'Stage hunk 2 in two-hunk.txt', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  writeFileSync(
    join(localApp.repo, 'two-hunk.txt'),
    Array.from({ length: 60 }, (_, i) => (i === 1 ? 'NEW TWO\n' : `line ${i + 1}\n`)).join(''),
  )
  await expect(page.locator('.code-view').getByText('NEW TWO', { exact: true })).toBeVisible()
  await hunkMenu(page)
  await expect(
    page.getByRole('menuitem', { name: 'Stage hunk 2 in two-hunk.txt', exact: true }),
  ).toHaveCount(0)
  expect(execFileSync('git', ['diff', '--cached'], { cwd: localApp.repo, encoding: 'utf8' })).toBe(
    '',
  )
})

test('Stale patch refusal clears hunk cache without replaying the action', async ({
  page,
  localApp,
}) => {
  let mutations = 0
  const paths: string[] = []
  await page.route('**/api/v1/operations?op=patch', async (route) => {
    mutations++
    paths.push(route.request().postDataJSON().path)
    if (mutations === 1)
      return route.continue({
        postData: JSON.stringify({
          ...route.request().postDataJSON(),
          patchId: 'stale-edge-identity',
        }),
      })
    return route.continue()
  })
  await page.goto(localApp.url)
  await hunkMenu(page)
  await page.getByRole('menuitem', { name: 'Stage hunk 1 in two-hunk.txt', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'stale patch identity' })).toBeVisible()
  await page.getByRole('button', { name: 'More actions for two-hunk.txt', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /Stage hunk/ })).toHaveCount(0)
  await expect(
    page.getByRole('menuitem', { name: 'Show hunk actions for two-hunk.txt', exact: true }),
  ).toBeEnabled()
  expect(mutations).toBe(1)
  expect(execFileSync('git', ['diff', '--cached'], { cwd: localApp.repo, encoding: 'utf8' })).toBe(
    '',
  )
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: 'Stage file two-hunk.txt', exact: true }),
  ).toBeEnabled({ timeout: 35000 })
  await hunkMenu(page)
  expect(mutations).toBe(1)
  await page.getByRole('menuitem', { name: 'Stage hunk 1 in two-hunk.txt', exact: true }).click()
  await expect(page.locator('#gitna-staged-tree__tree')).toBeVisible()
  expect(mutations).toBe(2)
  expect(paths).toEqual(['two-hunk.txt', 'two-hunk.txt'])
  expect(
    execFileSync('git', ['diff', '--cached'], { cwd: localApp.repo, encoding: 'utf8' }),
  ).toContain('TWO')
  expect(execFileSync('git', ['diff'], { cwd: localApp.repo, encoding: 'utf8' })).toContain('FIFTY')
})

test('Repository switching cancels expansion and ignores the old directory response', async ({
  page,
  localApp,
}) => {
  const alternate = join(localApp.repo, '..', 'alternate')
  mkdirSync(join(alternate, 'fresh/deeper'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: alternate, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Menu Tests')
  git('config', 'user.email', 'menus@example.test')
  writeFileSync(join(alternate, 'fresh/deeper/new.txt'), 'alternate\n')
  git('add', '.')
  git('commit', '-qm', 'alternate base')
  expect(git('remote')).toBe('')
  await page.goto(localApp.url)
  await page.locator('[data-section="repository"]').click()
  const started = barrier()
  const resume = barrier()
  const finished = barrier()
  await page.route('**/api/v1/directory?*', async (route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.includes('/repo/') || url.searchParams.get('path') !== 'nested')
      return route.continue()
    const response = await route.fetch()
    started.release()
    await resume.promise
    try {
      await route.fulfill({ response })
    } finally {
      finished.release()
    }
  })
  try {
    await explorerMenu(page, 'Expand all folders')
    await started.promise
    await page.getByRole('combobox', { name: 'Folder path' }).fill(alternate)
    await page.getByRole('button', { name: 'Switch folder', exact: true }).click()
    await expect(page).toHaveURL(/alternate\/$/)
    await expect(page.getByRole('combobox', { name: 'Folder path' })).toHaveValue(alternate)
    resume.release()
    await finished.promise
    if (
      (await page.locator('[data-section="repository"]').getAttribute('aria-expanded')) !== 'true'
    )
      await page.locator('[data-section="repository"]').click()
    const tree = page.locator('#gitna-repository-tree__tree')
    await expect(tree.getByRole('treeitem', { name: 'fresh', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(tree.getByRole('treeitem', { name: 'nested', exact: true })).toHaveCount(0)
    await expect(tree.getByRole('treeitem', { name: 'new.txt', exact: true })).toHaveCount(0)
    await explorerMenu(page, 'Expand all folders')
    await expect(tree.getByRole('treeitem', { name: 'new.txt', exact: true })).toBeVisible()
  } finally {
    resume.release()
  }
})

for (const vanished of ['file', 'commit']) {
  test(`Confirmation dismissal restores relevant focus after initiating ${vanished} disappears`, async ({
    page,
    localApp,
  }) => {
    await page.goto(localApp.url)
    if (vanished === 'file') {
      await page.getByRole('button', { name: 'More actions for two-hunk.txt', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Discard', exact: true }).click()
      execFileSync('git', ['restore', 'two-hunk.txt'], { cwd: localApp.repo })
      await expect(page.locator('button[aria-label="More actions for two-hunk.txt"]')).toHaveCount(
        0,
      )
    } else {
      await page.locator('[data-section="graph"]').click()
      await page.getByRole('button', { name: 'Actions for second', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Reset hard…', exact: true }).click()
      execFileSync('git', ['reset', '--hard', 'HEAD~1'], { cwd: localApp.repo })
      await expect(page.locator('button[aria-label="Actions for second"]')).toHaveCount(0)
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )
    await expect(
      page.getByRole('button', {
        name: vanished === 'file' ? 'More actions' : 'Graph actions',
        exact: true,
      }),
    ).toBeFocused()
  })
}
