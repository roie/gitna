import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

async function openUnstaged(page: Page, path: string) {
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: path, exact: true })
    .click()
  const editor = page.locator('.code-view').getByRole('textbox', { name: path, exact: true })
  await expect(editor).toBeVisible()
  return editor
}

async function append(page: Page, editor: ReturnType<Page['locator']>, text: string) {
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(text)
}

test('edits the working tree side of an unstaged diff and saves it', async ({ page, app }) => {
  await page.goto(app.url)
  const editor = await openUnstaged(page, 'modified.txt')
  await append(page, editor, ' edited in diff')
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'modified.txt'), 'utf8'))
    .toBe('unstaged change edited in diff\n')
  await expect(editor).toContainText('edited in diff')
})

test('a diff draft and the editor tab share one unsaved state', async ({ page, app }) => {
  await page.goto(app.url)
  const editor = await openUnstaged(page, 'modified.txt')
  await append(page, editor, ' from diff')
  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'modified.txt', exact: true })
    .click()
  await expect(page.getByRole('tab', { name: /modified\.txt Unsaved changes/ })).toBeVisible()
  const tabEditor = page.getByRole('textbox', { name: 'modified.txt', exact: true })
  await expect(tabEditor).toContainText('from diff')
  await append(page, tabEditor, ' and tab')

  const diffEditor = await openUnstaged(page, 'modified.txt')
  await expect(diffEditor).toContainText('and tab')
  await diffEditor.click()
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'modified.txt'), 'utf8'))
    .toBe('unstaged change from diff\n and tab')
  await expect(page.getByRole('tab', { name: /modified\.txt Unsaved changes/ })).toHaveCount(0)
})

test('saving while a review loads saves the edited file still on screen', async ({ page, app }) => {
  await page.goto(app.url)
  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'modified.txt', exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: 'modified.txt', exact: true })
  await append(page, editor, ' while loading')
  await expect(page.getByRole('tab', { name: /modified\.txt Unsaved changes/ })).toBeVisible()

  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/v1/review?*', async (route) => {
    await held
    await route.continue()
  })
  const reviewRequested = page.waitForRequest('**/api/v1/review?*')
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'modified.txt', exact: true })
    .click()
  await reviewRequested
  await editor.click()
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'modified.txt'), 'utf8'))
    .toBe('unstaged change\n while loading')
  release()
  await expect(page.getByRole('tab', { name: /modified\.txt Unsaved changes/ })).toHaveCount(0)
})

test('the staged side of a diff is read-only', async ({ page, app }) => {
  await page.goto(app.url)
  await page
    .locator('#gitna-staged-tree__tree')
    .getByRole('treeitem', { name: 'staged.txt', exact: true })
    .click()
  await expect(page.locator('.code-view')).toContainText('staged change')
  await expect(page.locator('.code-view').getByRole('textbox')).toHaveCount(0)
})

test('edits the right file of a comparison', async ({ page, app }) => {
  await page.goto(app.url)
  await page.locator('[data-section="repository"]').click()
  const explorer = page.locator('#gitna-repository-tree__tree')
  await explorer.getByRole('treeitem', { name: 'main.txt', exact: true }).click()
  const right = explorer.getByRole('treeitem', { name: 'feature.txt', exact: true })
  await right.click({ modifiers: ['Control'] })
  await right.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Compare Selected' }).click()
  await expect(page.getByRole('tab', { name: 'main.txt ↔ feature.txt' })).toBeVisible()
  const editor = page.locator('.code-view').getByRole('textbox', { name: 'feature.txt' })
  await append(page, editor, ' compared')
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'feature.txt'), 'utf8'))
    .toBe('feature branch compared\n')
})

test('a refresh keeps the diff being edited', async ({ page, app }) => {
  await page.goto(app.url)
  const editor = await openUnstaged(page, 'modified.txt')
  await append(page, editor, ' keep me')
  writeFileSync(join(app.repo, 'untracked.txt'), 'changed outside\n')
  await expect(
    page.locator('.code-view').getByRole('textbox', { name: 'untracked.txt', exact: true }),
  ).toContainText('changed outside')
  await expect(editor).toContainText('keep me')
  await page.keyboard.insertText(' still typing')
  await expect(editor).toContainText('keep me still typing')
})

test('one save in a review writes every edited diff and clears their dots', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const modified = await openUnstaged(page, 'modified.txt')
  await append(page, modified, ' first')
  const untracked = await openUnstaged(page, 'untracked.txt')
  await append(page, untracked, ' second')
  const unsaved = page.locator('.code-view').getByLabel('Unsaved changes')
  await expect(unsaved).toHaveCount(2)
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'modified.txt'), 'utf8'))
    .toBe('unstaged change first\n')
  await expect
    .poll(() => readFileSync(join(app.repo, 'untracked.txt'), 'utf8'))
    .toBe('untracked content second\n')
  await expect(unsaved).toHaveCount(0)
})

test('undo in a diff survives leaving and reopening the review', async ({ page, app }) => {
  await page.goto(app.url)
  const editor = await openUnstaged(page, 'modified.txt')
  await append(page, editor, ' undo me')
  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'main.txt', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'main.txt', exact: true })).toBeVisible()
  const reopened = await openUnstaged(page, 'modified.txt')
  await expect(reopened).toContainText('undo me')
  await reopened.click()
  await page.keyboard.press('Control+z')
  await expect(reopened).not.toContainText('undo me')
})

for (const surface of ['file', 'diff'] as const) {
  test(`${surface} undo and redo retain history after saving`, async ({ page, app }) => {
    await page.goto(app.url)
    if (surface === 'file') {
      await page.locator('[data-section="repository"]').click()
      await page
        .locator('#gitna-repository-tree__tree')
        .getByRole('treeitem', { name: 'modified.txt', exact: true })
        .click()
    } else {
      await openUnstaged(page, 'modified.txt')
    }
    const editor = page.getByRole('textbox', { name: 'modified.txt', exact: true })
    const original = await editor.textContent()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' undo-redo')
    await expect(editor).toContainText('undo-redo')
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText(original ?? '')
    await page.keyboard.press('Control+y')
    await expect(editor).toContainText('undo-redo')
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText(original ?? '')
    await page.keyboard.press('Control+Shift+z')
    await expect(editor).toContainText('undo-redo')
    await page.keyboard.press('Control+s')
    await expect
      .poll(() => readFileSync(join(app.repo, 'modified.txt'), 'utf8'))
      .toBe(surface === 'file' ? 'unstaged change\n undo-redo' : 'unstaged change undo-redo\n')
    await expect(editor).toBeFocused()
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText(original ?? '')
    await page.keyboard.press('Control+Shift+z')
    await expect(editor).toContainText('undo-redo')
  })
}

test('an undo after saving a diff survives the refresh that follows the save', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const editor = await openUnstaged(page, 'modified.txt')
  await append(page, editor, ' saved')
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/v1/review?*', async (route) => {
    await held
    await route.continue()
  })
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'modified.txt'), 'utf8'))
    .toBe('unstaged change saved\n')
  const unsaved = page.locator('.code-view').getByLabel('Unsaved changes')
  await expect(unsaved).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(editor).not.toContainText('saved')
  await expect(unsaved).toHaveCount(1)
  const refreshed = page.waitForResponse('**/api/v1/review?*')
  release()
  await refreshed
  await expect(editor).not.toContainText('saved')
  await page.keyboard.press('Control+Shift+z')
  await expect(editor).toContainText('saved')
})

test('an intent-to-add file can be edited in its diff', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'intent.txt'), 'intent\n')
  const result = spawnSync('git', ['add', '-N', '--', 'intent.txt'], {
    cwd: app.repo,
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  await page.goto(app.url)
  const editor = await openUnstaged(page, 'intent.txt')
  await append(page, editor, ' added')
  await page.keyboard.press('Control+s')
  await expect.poll(() => readFileSync(join(app.repo, 'intent.txt'), 'utf8')).toBe('intent added\n')
})
