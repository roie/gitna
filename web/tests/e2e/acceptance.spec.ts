import { readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

test('0.4.0 acceptance: create, save, find, edit, preview, review, commit and inspect Graph', async ({
  page,
  app,
}) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  copyFileSync(
    new URL('./media-fixtures/vp8.webm', import.meta.url),
    join(app.repo, 'acceptance.webm'),
  )
  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Review' })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('>new file')
  await palette.getByRole('combobox', { name: 'Search files and commands' }).press('Enter')
  const untitled = page.getByRole('tab', { name: 'Untitled-1' })
  await expect(untitled).toBeVisible()
  const untitledEditor = page
    .locator('.code-view [contenteditable="true"], .code-view textarea')
    .first()
  await untitledEditor.click()
  await page.keyboard.insertText('# AcceptanceNeedle\n\nCreated in Gitna.\n')
  await expect(untitled.getByLabel('Unsaved changes')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await untitledEditor.press('Control+s')
  const saveAs = page.getByRole('dialog', { name: 'Save As' })
  await expect(saveAs).toBeVisible()
  await saveAs.getByRole('textbox', { name: 'Repository-relative path' }).fill('acceptance.md')
  await saveAs.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(saveAs).toHaveCount(0)
  await expect
    .poll(() => readFileSync(join(app.repo, 'acceptance.md'), 'utf8'))
    .toContain('AcceptanceNeedle')

  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  await search.getByRole('textbox', { name: 'Search files', exact: true }).fill('AcceptanceNeedle')
  await search.getByRole('button', { name: 'Open acceptance.md:1' }).click()
  const editor = page.getByRole('textbox', { name: 'acceptance.md', exact: true })
  await expect(editor).toBeFocused()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('Edited search result.\n')
  await page.getByRole('button', { name: 'Open Markdown preview to the side' }).click()
  const preview = page.getByRole('region', { name: 'Markdown preview' })
  await expect(preview.getByRole('heading', { name: 'AcceptanceNeedle' })).toBeVisible()
  await expect(preview.getByText('Edited search result.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await editor.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'acceptance.md'), 'utf8'))
    .toContain('Edited search result.')

  await search.getByRole('button', { name: 'Show Source Control' }).click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'acceptance.webm', exact: true })
    .click()
  const video = page.locator('video')
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1)
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'two-hunk.txt', exact: true })
    .click()
  await expect(video).toHaveCount(0)
  await page.getByRole('button', { name: 'Show hunk actions for two-hunk.txt' }).click()
  await page.getByRole('button', { name: 'Stage hunk 1 in two-hunk.txt' }).click()
  await expect.poll(() => readFileSync(join(app.repo, 'two-hunk.txt'), 'utf8')).toContain('FIFTY')
  await page.getByRole('button', { name: 'Stage all changes', exact: true }).click()
  await page.getByPlaceholder('Commit message').fill('0.4.0 acceptance flow')
  await page.getByRole('button', { name: 'Commit', exact: true }).click()
  await page.locator('[data-section="graph"]').click()
  const commit = page.getByRole('button', { name: /^0\.4\.0 acceptance flow/ })
  await expect(commit).toBeVisible()
  await commit.click()
  await page
    .locator('[id^="gitna-graph-"][id$="__tree"]')
    .getByRole('treeitem', { name: 'acceptance.md', exact: true })
    .click()
  await page.getByRole('button', { name: 'Open acceptance.md in Repository' }).click()
  await expect(page.getByRole('textbox', { name: 'acceptance.md', exact: true })).toContainText(
    'Edited search result.',
  )
  expect(errors).toEqual([])
})
