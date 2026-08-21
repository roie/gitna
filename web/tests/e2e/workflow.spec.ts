import { spawnSync } from 'node:child_process'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

async function reviewPatch(page: Page, scope: 'staged' | 'unstaged') {
  return page.evaluate(async (reviewScope) => {
    const response = await fetch(`api/v1/review?scope=${reviewScope}`)
    if (!response.ok) throw new Error(`review request failed: ${response.status}`)
    return ((await response.json()) as { patch: string }).patch
  }, scope)
}

test('staging loop preserves VS Code section order and visibility', async ({ page, app }) => {
  await page.goto(app.url)
  const sourceControl = page.locator('aside[aria-label="Source Control"]')
  const staged = page.locator('[data-section="staged"]')
  const changes = page.locator('[data-section="changes"]')
  const graph = page.locator('[data-section="graph"]')

  await expect(staged).toBeVisible()
  await expect(changes).toBeVisible()
  const order = await page.locator('.section-title').allTextContents()
  expect(order.indexOf('Staged Changes')).toBeLessThan(order.indexOf('Changes'))
  expect(order.indexOf('Changes')).toBeLessThan(order.indexOf('Graph'))
  await expect(page.getByRole('textbox', { name: 'Repository path' })).toHaveValue(app.repo)
  await expect(page.getByRole('button', { name: 'Switch branch · main' })).toBeVisible()
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-m4-desktop.png', fullPage: true })
  }
  await page.getByRole('button', { name: 'Search Changes' }).click()
  const treeSearch = page.getByRole('textbox', { name: 'Filter Changes' })
  await expect(treeSearch).toBeVisible()
  await treeSearch.fill('modified')
  await expect(page.getByRole('treeitem', { name: 'modified.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Search Changes' }).click()

  await page.getByRole('treeitem', { name: 'modified.txt', exact: true }).click()
  await sourceControl.getByRole('button', { name: 'Discard file modified.txt' }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText(app.repo)
  await expect(confirmation).toContainText('main')
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await sourceControl.getByRole('button', { name: 'Stage file modified.txt' }).click()
  await expect.poll(async () => (await staged.textContent()) ?? '').toContain('4')
  await expect(page.getByRole('treeitem', { name: 'modified.txt', exact: true })).toBeVisible()

  for (const path of ['modified.txt', 'delete.txt', 'rename-new.txt', 'staged.txt']) {
    await page.getByRole('treeitem', { name: path, exact: true }).click()
    await sourceControl.getByRole('button', { name: `Unstage file ${path}` }).click()
  }

  await expect(staged).toHaveCount(0)
  await expect(changes).toBeVisible()
  await expect(changes).toHaveAttribute('aria-expanded', 'true')
  await expect(graph).toBeVisible()

  await page.keyboard.press('F6')
  await expect(changes).toBeFocused()
  await page.keyboard.press('Shift+F6')
  await expect(graph).toBeFocused()
  await page.keyboard.press('F1')
  await expect(page.getByText('Refresh Graph', { exact: true })).toBeVisible()
  await page.keyboard.press('F1')
  await expect(page.getByText('Refresh Graph', { exact: true })).not.toBeVisible()
})

test('tree navigation and Pierre header hunk actions preserve the other hunk', async ({
  page,
  app,
}) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto(app.url)
  await page.getByRole('treeitem', { name: 'two-hunk.txt', exact: true }).click()

  const renderedFile = page.locator('diffs-container').filter({ hasText: 'two-hunk.txt' })
  await expect(renderedFile).toBeVisible()
  await expect
    .poll(async () => Math.round((await renderedFile.boundingBox())?.y ?? 999))
    .toBeLessThan(100)

  await page.getByRole('button', { name: 'Show hunk actions for two-hunk.txt' }).click()
  await page.getByRole('button', { name: 'Stage hunk 1 in two-hunk.txt' }).click()

  await expect.poll(() => reviewPatch(page, 'staged')).toContain('+TWO')
  const stagedPatch = await reviewPatch(page, 'staged')
  const unstagedPatch = await reviewPatch(page, 'unstaged')
  expect(stagedPatch).not.toContain('+FIFTY')
  expect(unstagedPatch).toContain('+FIFTY')

  await page.keyboard.press('Control+Shift+L')
  await expect(page.getByRole('button', { name: 'Switch to split view' })).toBeVisible()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(
    page.getByRole('treeitem', { name: 'large-untracked.txt', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  expect(browserErrors).toEqual([])
})

test('commit text survives hook failure and clears after authoritative success', async ({
  page,
  app,
}) => {
  const hook = join(app.repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho policy rejects this commit >&2\nexit 1\n')
  chmodSync(hook, 0o755)

  await page.goto(app.url)
  const composer = page.getByPlaceholder('Commit message')
  await composer.fill('milestone commit')
  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'policy rejects this commit' }),
  ).toBeVisible()
  await expect(composer).toHaveValue('milestone commit')

  rmSync(hook)
  await page.keyboard.press('Control+Shift+C')
  await expect(composer).toBeFocused()
  await page.keyboard.press('Control+Enter')
  await expect(composer).toHaveValue('')
  await expect(page.getByText('milestone commit', { exact: true })).toBeVisible()
})

test('advanced Git actions use compact dialogs and destructive confirmations', async ({
  page,
  app,
}) => {
  git(app.repo, 'stash', 'push', '-u', '-m', 'confirmation stash')
  await page.goto(app.url)
  const moreActions = page.getByRole('button', { name: 'More actions' })

  await moreActions.click()
  await page.getByRole('menuitem', { name: 'Merge or rebase…' }).click()
  const integrateDialog = page.getByRole('dialog', { name: 'Merge or rebase' })
  await expect(integrateDialog).toBeVisible()
  await expect(integrateDialog.getByRole('button', { name: 'Merge', exact: true })).toBeVisible()
  await expect(integrateDialog.getByRole('button', { name: 'Rebase', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(integrateDialog).not.toBeVisible()

  await moreActions.click()
  await page.getByRole('menuitem', { name: 'Compare refs…' }).click()
  await expect(page.getByRole('dialog', { name: 'Compare references' })).toBeVisible()
  await page.keyboard.press('Escape')

  await moreActions.click()
  await page.getByRole('menuitem', { name: 'Stashes…' }).click()
  const stashesDialog = page.getByRole('dialog', { name: 'Stashes' })
  await expect(stashesDialog).toBeVisible()
  await stashesDialog.getByRole('button', { name: 'Drop' }).click()
  const stashConfirmation = page.getByRole('alertdialog')
  await expect(stashConfirmation).toContainText('Drop stash@{0}?')
  await stashConfirmation.getByRole('button', { name: 'Cancel' }).click()
  await page.keyboard.press('Escape')

  await moreActions.click()
  await page.getByRole('menuitem', { name: 'Tags…' }).click()
  const tagsDialog = page.getByRole('dialog', { name: 'Tags' })
  await expect(tagsDialog).toBeVisible()
  await tagsDialog.getByRole('button', { name: 'Delete' }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('Delete tag v1?')
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(tagsDialog.locator('b', { hasText: /^v1$/ })).toBeVisible()
})

test('cherry-pick conflicts can accept both sides and continue', async ({ page, app }) => {
  git(app.repo, 'reset', '--hard', 'HEAD')
  git(app.repo, 'clean', '-fd')
  git(app.repo, 'switch', '-q', '-c', 'replay-conflict')
  writeFileSync(join(app.repo, 'modified.txt'), 'replay side\n')
  git(app.repo, 'add', '--', 'modified.txt')
  git(app.repo, 'commit', '-qm', 'replay conflict')
  const replayOid = git(app.repo, 'rev-parse', 'HEAD')
  git(app.repo, 'switch', '-q', 'main')
  writeFileSync(join(app.repo, 'modified.txt'), 'main side\n')
  git(app.repo, 'add', '--', 'modified.txt')
  git(app.repo, 'commit', '-qm', 'main conflict')
  const cherryPick = spawnSync('git', ['cherry-pick', replayOid], {
    cwd: app.repo,
    encoding: 'utf8',
  })
  expect(cherryPick.status).not.toBe(0)

  await page.goto(app.url)
  const conflictView = page.locator('.conflict-bar')
  await expect(conflictView).toContainText('Cherry-pick in progress')
  await expect(conflictView).toContainText('modified.txt')
  await conflictView.getByRole('button', { name: 'Both' }).click()
  const continueButton = conflictView.getByRole('button', { name: 'Continue' })
  await expect(continueButton).toBeEnabled()
  await continueButton.click()
  await expect(conflictView).not.toBeVisible()

  const content = git(app.repo, 'show', 'HEAD:modified.txt')
  expect(content).toContain('main side')
  expect(content).toContain('replay side')
})

test('narrow Source Control uses a dismissible overlay without squeezing review', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(app.url)
  const review = page.getByRole('region', { name: 'Review' })
  await expect(review).toBeVisible()
  const sourceControl = page.locator('aside[aria-label="Source Control"]')
  await expect(sourceControl).toHaveAttribute('aria-hidden', 'true')

  await page.getByRole('button', { name: 'Open Source Control' }).click()
  await expect(sourceControl).not.toHaveAttribute('aria-hidden', 'true')
  await expect(sourceControl).toBeVisible()
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  await expect(review).toHaveCSS('width', '390px')
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-m4-mobile-overlay.png', fullPage: true })
  }

  await sourceControl.getByRole('button', { name: 'Close Source Control' }).click()
  await expect(sourceControl).toHaveAttribute('aria-hidden', 'true')
  await expect(review).toHaveCSS('width', '390px')
})
