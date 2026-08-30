import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
    const response = await fetch(
      `api/v1/diff?scope=${reviewScope}&path=${encodeURIComponent('two-hunk.txt')}`,
    )
    if (!response.ok) throw new Error(`diff request failed: ${response.status}`)
    return ((await response.json()) as { patch: string }).patch
  }, scope)
}

test('staging loop preserves VS Code section order and visibility', async ({ page, app }) => {
  await page.goto(app.url)
  const staged = page.locator('[data-section="staged"]')
  const changes = page.locator('[data-section="changes"]')
  const graph = page.locator('[data-section="graph"]')
  const stagedTree = page.locator('#gitna-staged-tree__tree')
  const changesTree = page.locator('#gitna-unstaged-tree__tree')

  await expect(staged).toBeVisible()
  await expect(changes).toBeVisible()
  const order = await page
    .locator('[data-section]')
    .evaluateAll((headers) => headers.map((header) => (header as HTMLElement).dataset.section))
  expect(order).toEqual(['workflow', 'staged', 'changes', 'repository', 'graph'])
  await expect(page.getByRole('combobox', { name: 'Folder path' })).toHaveValue(app.repo)
  await expect(page.getByRole('button', { name: 'Switch branch · main' })).toBeVisible()
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-m4-desktop.png', fullPage: true })
  }
  await expect(page.getByRole('button', { name: 'Search Changes' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Search Staged Changes' })).toHaveCount(0)

  const modifiedRow = changesTree.getByRole('treeitem', {
    name: 'modified.txt',
    exact: true,
  })
  const changesHeader = changes.locator('..')
  await changes.hover()
  expect(
    await changesHeader.evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe('rgba(0, 0, 0, 0)')
  const discardAll = page.getByRole('button', { name: 'Discard all changes', exact: true })
  const stageAll = page.getByRole('button', { name: 'Stage all changes', exact: true })
  await expect(discardAll).toBeVisible()
  await expect(stageAll).toBeVisible()
  const changeCount = changesHeader.locator('.section-count')
  const countBox = await changeCount.boundingBox()
  const stageAllBox = await stageAll.boundingBox()
  expect(countBox).not.toBeNull()
  expect(stageAllBox).not.toBeNull()
  expect(countBox!.x).toBeGreaterThan(stageAllBox!.x)
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-section-actions.png', fullPage: true })
  }
  await modifiedRow.hover()
  const discardModified = changesTree.getByRole('button', {
    name: 'Discard changes in modified.txt',
  })
  const stageModified = changesTree.getByRole('button', { name: 'Stage modified.txt' })
  await expect(discardModified).toBeVisible()
  await expect(stageModified).toBeVisible()
  await expect(discardModified).toHaveCSS('cursor', 'pointer')
  await expect(stageModified).toHaveCSS('cursor', 'pointer')
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-row-actions.png', fullPage: true })
  }
  await discardModified.click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toHaveClass(/shadow-lg/)
  await expect(confirmation).not.toHaveClass(/shadow-2xl/)
  await expect(confirmation).toContainText('Discard changes to modified.txt?')
  await expect(confirmation).toContainText('restored to its staged version')
  const cancelConfirmation = confirmation.getByRole('button', { name: 'Cancel' })
  await expect(cancelConfirmation).toBeFocused()
  await cancelConfirmation.click()
  await modifiedRow.hover()
  await stageModified.click()
  await expect(staged.locator('..').locator('.section-count')).toHaveText('4')
  await expect(
    stagedTree.getByRole('treeitem', { name: 'modified.txt', exact: true }),
  ).toBeVisible()

  await staged.hover()
  await expect(page.getByRole('button', { name: 'Unstage all changes', exact: true })).toBeVisible()
  for (const path of ['modified.txt', 'delete.txt', 'rename-new.txt', 'staged.txt']) {
    const row = stagedTree.getByRole('treeitem', { name: path, exact: true })
    await row.hover()
    await stagedTree.getByRole('button', { name: `Unstage ${path}` }).click()
    await expect(row).toHaveCount(0)
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

test('folder rows expose stage, unstage, and discard actions on hover', async ({ page, app }) => {
  const folder = join(app.repo, 'nested')
  mkdirSync(folder)
  writeFileSync(join(folder, 'one.txt'), 'one\n')
  writeFileSync(join(folder, 'two.txt'), 'two\n')

  await page.goto(app.url)
  const changesTree = page.locator('#gitna-unstaged-tree__tree')
  const stagedTree = page.locator('#gitna-staged-tree__tree')
  const changedFolder = changesTree.getByRole('treeitem', { name: 'nested', exact: true })

  await changedFolder.hover()
  await expect(changesTree.getByRole('button', { name: 'Discard changes in nested' })).toBeVisible()
  await changesTree.getByRole('button', { name: 'Stage nested' }).click()

  const stagedFolder = stagedTree.getByRole('treeitem', { name: 'nested', exact: true })
  await expect(stagedFolder).toBeVisible()
  await stagedFolder.hover()
  await stagedTree.getByRole('button', { name: 'Unstage nested' }).click()

  await expect(changedFolder).toBeVisible()
  await changedFolder.hover()
  await changesTree.getByRole('button', { name: 'Discard changes in nested' }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation).toContainText('permanently delete 2 untracked files')
  await confirmation.getByRole('button', { name: 'Delete files' }).click()
  await expect(changedFolder).toHaveCount(0)
})

test('tree navigation and Pierre header hunk actions preserve the other hunk', async ({
  page,
  app,
}) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    const expectedGenerationConflict =
      text === 'Failed to load resource: the server responded with a status of 409 (Conflict)'
    if (message.type() === 'error' && !expectedGenerationConflict) browserErrors.push(text)
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto(app.url)
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'two-hunk.txt', exact: true })
    .click()

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
    page
      .locator('#gitna-unstaged-tree__tree')
      .getByRole('treeitem', { name: 'large-untracked.txt', exact: true }),
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
  await page.locator('[data-section="graph"]').click()
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
  git(app.repo, 'reset', '--hard', 'HEAD')
  writeFileSync(join(app.repo, 'staged.txt'), 'one staged change\n')
  git(app.repo, 'add', 'staged.txt')
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
  await page.locator('[data-section="repository"]').click()
  const workflowBody = page.locator('[data-pane-body="source-control"]')
  await expect
    .poll(() =>
      workflowBody.evaluate((body) => {
        const lastSection = body.lastElementChild
        if (!(lastSection instanceof HTMLElement)) return Number.POSITIVE_INFINITY
        return Math.round(
          body.getBoundingClientRect().bottom - lastSection.getBoundingClientRect().bottom,
        )
      }),
    )
    .toBeLessThanOrEqual(1)
  await expect(review).toHaveCSS('width', '390px')
  if (process.env.GITNA_CAPTURE_M4) {
    await page.screenshot({ path: '/tmp/gitna-m4-mobile-overlay.png', fullPage: true })
  }

  await sourceControl.getByRole('button', { name: 'Close Source Control' }).click()
  await expect(sourceControl).toHaveAttribute('aria-hidden', 'true')
  await expect(review).toHaveCSS('width', '390px')
})
