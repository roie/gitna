import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures.js'

async function editFile(page: Page, path: string) {
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: path, exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: path, exact: true })
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' draft to keep')
  await expect(page.getByRole('tab', { name: new RegExp(`${path} Unsaved changes`) })).toBeVisible()
  return editor
}

for (const bulk of [false, true]) {
  test(`save-before-close retains drafts after failure and permits retry${bulk ? ' in bulk' : ''}`, async ({
    page,
    app,
  }) => {
    await page.goto(app.url)
    await page.locator('[data-section="repository"]').click()
    await editFile(page, 'main.txt')
    if (bulk) await editFile(page, 'feature.txt')
    const failedPath = bulk ? 'feature.txt' : 'main.txt'
    const original = readFileSync(join(app.repo, failedPath), 'utf8')
    let rejectSave = true
    const writes: string[] = []
    await page.route('**/api/v1/worktree/file', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      const { path } = route.request().postDataJSON() as { path: string }
      writes.push(path)
      if (path === failedPath && rejectSave) {
        await route.fulfill({ status: 409, json: { error: 'Save conflict for test' } })
      } else {
        await route.continue()
      }
    })
    if (bulk) {
      await page
        .getByRole('tab', { name: /feature.txt Unsaved changes/ })
        .click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Close All', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Close main.txt', exact: true }).click()
    }
    const confirmation = page.getByRole('alertdialog')
    await confirmation.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(page.getByText('Save conflict for test', { exact: true }).first()).toBeVisible()
    await expect(confirmation).toBeVisible()
    await expect(
      page.getByRole('tab', { name: new RegExp(`${failedPath} Unsaved changes`) }),
    ).toBeVisible()
    expect(readFileSync(join(app.repo, failedPath), 'utf8')).toBe(original)
    await expect(page.getByRole('textbox', { name: failedPath, exact: true })).toContainText(
      'draft to keep',
    )
    if (bulk) {
      expect(readFileSync(join(app.repo, 'main.txt'), 'utf8')).toContain('draft to keep')
      await expect(page.getByRole('tab', { name: 'main.txt', exact: true })).toBeVisible()
    }

    rejectSave = false
    await confirmation.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: `Close ${failedPath}`, exact: true }),
    ).toHaveCount(0)
    expect(readFileSync(join(app.repo, failedPath), 'utf8')).toContain('draft to keep')
    expect(writes).toEqual(
      bulk ? ['main.txt', 'feature.txt', 'feature.txt'] : ['main.txt', 'main.txt'],
    )
  })
}

for (const mode of ['append', 'undo', 'undo-failure']) {
  const undo = mode !== 'append'
  const rejectSave = mode === 'undo-failure'
  test(`save-before-close reconciles in-flight ${mode}`, async ({ page, app }) => {
    await page.goto(app.url)
    await page.locator('[data-section="repository"]').click()
    const editor = await editFile(page, 'main.txt')
    let releaseSave!: () => void
    let saveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve
    })
    let delaySave = true
    await page.route('**/api/v1/worktree/file', async (route) => {
      if (route.request().method() === 'PUT' && delaySave) {
        delaySave = false
        saveStarted()
        await new Promise<void>((resolve) => {
          releaseSave = resolve
        })
        if (rejectSave) {
          await route.fulfill({ status: 409, json: { error: 'Save conflict for test' } })
          return
        }
      }
      await route.continue()
    })
    await page.getByRole('button', { name: 'Close main.txt', exact: true }).click()
    const confirmation = page.getByRole('alertdialog')
    await confirmation.getByRole('button', { name: 'Save changes', exact: true }).click()
    await started
    await expect(
      confirmation.getByRole('button', { name: 'Save changes', exact: true }),
    ).toBeDisabled()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await editor.click()
    if (undo) {
      await page.keyboard.press('Control+z')
      await expect(editor).not.toContainText('draft to keep')
    } else {
      await page.keyboard.press('Control+End')
      await page.keyboard.insertText(' while saving')
    }
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/api/v1/worktree/file'),
    )
    releaseSave()
    expect((await response).status()).toBe(rejectSave ? 409 : 200)
    if (rejectSave) {
      await expect(page.getByText('Save conflict for test', { exact: true }).first()).toBeVisible()
      await expect(page.getByRole('tab', { name: 'main.txt', exact: true })).toBeVisible()
      await expect(editor).not.toContainText('draft to keep')
      expect(readFileSync(join(app.repo, 'main.txt'), 'utf8')).not.toContain('draft to keep')
      return
    }
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await expect(page.getByRole('tab', { name: /main.txt Unsaved changes/ })).toBeVisible()
    if (undo) {
      await expect(editor).not.toContainText('draft to keep')
      expect(readFileSync(join(app.repo, 'main.txt'), 'utf8')).toContain('draft to keep')
      await page.getByRole('button', { name: 'Close main.txt', exact: true }).click()
      await confirmation.getByRole('button', { name: 'Save changes', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Close main.txt', exact: true })).toHaveCount(0)
      expect(readFileSync(join(app.repo, 'main.txt'), 'utf8')).not.toContain('draft to keep')
    } else {
      await expect(editor).toContainText('draft to keep while saving')
      expect(readFileSync(join(app.repo, 'main.txt'), 'utf8')).not.toContain('while saving')
    }
  })
}
