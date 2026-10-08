import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures.js'

for (const dirtySibling of [false, true]) {
  test(`Close All saves untitled and closes ${dirtySibling ? 'dirty' : 'clean'} siblings`, async ({
    page,
    app,
  }) => {
    await page.goto(app.url)
    await page.locator('[data-section="repository"]').click()
    await page
      .locator('#gitna-repository-tree__tree')
      .getByRole('treeitem', { name: 'main.txt', exact: true })
      .click()
    if (dirtySibling) {
      const editor = page.getByRole('textbox', { name: 'main.txt', exact: true })
      await editor.click()
      await editor.press('Control+End')
      await page.keyboard.insertText(' sibling draft')
    }
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const search = page.getByRole('combobox', { name: 'Search files and commands' })
    await search.fill('>new file')
    await expect(
      page.getByRole('option', { name: /New File Create an untitled file in memory/ }),
    ).toBeVisible()
    await search.press('Enter')
    const editor = page.locator('.code-view').locator('[contenteditable="true"], textarea').first()
    await editor.click()
    await page.keyboard.insertText('untitled draft')
    await page.getByRole('tab', { name: /Untitled/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close All', exact: true }).click()
    const confirmation = page.getByRole(dirtySibling ? 'alertdialog' : 'dialog', {
      name: dirtySibling
        ? 'Discard unsaved changes to these files?'
        : 'Save changes before closing?',
    })
    await confirmation
      .getByRole('button', { name: dirtySibling ? 'Save changes' : 'Save', exact: true })
      .click()
    const saveAs = page.getByRole('dialog', { name: 'Save As' })
    await saveAs.getByRole('textbox', { name: 'Repository-relative path' }).fill('saved-close.txt')
    await saveAs.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(saveAs).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'saved-close.txt', exact: true })).toHaveCount(0)
    if (dirtySibling) {
      const remaining = page.getByRole('alertdialog')
      await expect(remaining).toBeVisible()
      await remaining.getByRole('button', { name: 'Save changes', exact: true }).click()
      expect(readFileSync(join(app.repo, 'main.txt'), 'utf8')).toContain('sibling draft')
    }
    await expect(confirmation).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(0)
    expect(readFileSync(join(app.repo, 'saved-close.txt'), 'utf8')).toBe('untitled draft')
  })
}
