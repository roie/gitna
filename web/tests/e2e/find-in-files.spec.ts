import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from './fixtures.js'

test('optional search tools are downloaded only when first opened', async ({ page, app }) => {
  const downloadedTools = new Set<string>()
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(
      /\/(GitnaCommandPalette|FindInFilesPanel)-[^/]+\.js$/,
    )
    if (match) downloadedTools.add(match[1]!)
  })

  await page.goto(app.url)
  const paletteTrigger = page.getByRole('button', { name: 'Open command palette' })
  await expect(paletteTrigger).toBeVisible()
  expect([...downloadedTools]).toEqual([])

  await paletteTrigger.click()
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  expect([...downloadedTools]).toEqual(['GitnaCommandPalette'])

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+f')
  await expect(
    page.getByRole('region', { name: 'Find in Files' }).getByRole('textbox', {
      name: 'Search files',
      exact: true,
    }),
  ).toBeFocused()
  expect([...downloadedTools]).toEqual(['GitnaCommandPalette', 'FindInFilesPanel'])
})

test('Find in Files keeps its query, focuses on shortcut, and opens matching lines', async ({
  page,
  app: gitna,
}) => {
  await page.goto(gitna.url)
  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  const input = search.getByRole('textbox', { name: 'Search files', exact: true })
  await expect(input).toBeFocused()
  await input.fill('FIFTY')
  await expect(search.getByText('1 result in 1 file', { exact: true })).toBeVisible()
  await search.getByRole('button', { name: 'Open two-hunk.txt:50' }).click()
  await expect(page.getByRole('tab', { name: /two-hunk.txt/ })).toBeVisible()
  const editor = page.locator('.code-view').locator('[contenteditable="true"], textarea').first()
  await expect(editor).toBeFocused()
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights.get('gitna-search') ?? [], (range) =>
          range instanceof Range ? range.toString() : null,
        ),
      ),
    )
    .toEqual(['FIFTY'])
  await page.keyboard.insertText('HERE:')
  await expect(editor.getByText('HERE:FIFTY', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+f')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('FIFTY')
  await search.getByRole('button', { name: 'Show Source Control' }).click()
  await page.keyboard.press('Control+Shift+f')
  await expect(input).toHaveValue('FIFTY')
  await expect(input).toBeFocused()
  await expect(search.getByText('1 result in 1 file', { exact: true })).toBeVisible()
  await page.screenshot({ path: join(tmpdir(), 'gitna-find-desktop.png') })
  await input.press('ArrowDown')
  await page.keyboard.press('ArrowLeft')
  await expect(search.getByRole('button', { name: 'Open two-hunk.txt:50' })).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(search.getByRole('button', { name: 'Open two-hunk.txt:50' })).toBeFocused()
  await search.getByRole('button', { name: 'Clear search' }).click()
  await expect(input).toHaveValue('')
  await expect(search.getByText('No results found.')).toHaveCount(0)
})

test('Find in Files filters, regex highlights and ignore controls use the real backend', async ({
  page,
  app: gitna,
}) => {
  mkdirSync(join(gitna.repo, 'nested'), { recursive: true })
  writeFileSync(
    join(gitna.repo, 'nested/search.txt'),
    '😀 NeedLE needle needles\n' + 'x'.repeat(600) + ' needle\n',
  )
  writeFileSync(join(gitna.repo, '.gitignore'), 'ignored/\n')
  mkdirSync(join(gitna.repo, 'ignored'), { recursive: true })
  writeFileSync(join(gitna.repo, 'ignored/search.txt'), 'needle\n')
  await page.goto(gitna.url)
  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  await search.getByRole('textbox', { name: 'Search files', exact: true }).fill('need[a-z]+')
  await search.getByRole('button', { name: 'Use regular expression', exact: true }).click()
  await expect(search.getByText('4 results in 1 file', { exact: true })).toBeVisible()
  await expect(search.locator('mark')).toHaveCount(4)
  await search.getByRole('button', { name: 'Filters', exact: true }).click()
  await search.getByLabel('Use ignore files').uncheck()
  await expect(search.getByText('5 results in 2 files', { exact: true })).toBeVisible()
  await search.getByRole('textbox', { name: 'Files to exclude' }).fill('**/ignored/**')
  await expect(search.getByText('4 results in 1 file', { exact: true })).toBeVisible()
  await search.getByRole('textbox', { name: 'Files to include' }).fill('**/*.txt')
  await expect(search.getByText('4 results in 1 file', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.keyboard.press('Control+Shift+f')
  await expect(search.getByRole('textbox', { name: 'Search files', exact: true })).toBeFocused()
  await page.screenshot({ path: join(tmpdir(), 'gitna-find-mobile.png') })
  await search
    .getByRole('button', { name: 'Open nested/search.txt:1', exact: true })
    .first()
    .click()
  const editor = page.locator('.code-view').locator('[contenteditable="true"], textarea').first()
  await expect(editor).toBeFocused()
  await page.keyboard.insertText('HIT:')
  await expect(editor.getByText('😀 HIT:NeedLE needle needles', { exact: true })).toBeVisible()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+Shift+f')
  await search.getByRole('textbox', { name: 'Search files', exact: true }).fill('[')
  await expect(search.getByRole('alert')).toBeVisible()
  await search
    .getByRole('textbox', { name: 'Search files', exact: true })
    .fill('not-found-anywhere')
  await expect(search.getByText('No results found.')).toBeVisible()
})

test('search uses file-type icons and highlights every editor match without changing selection', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'matches.ts'), 'export const needle = "needle"\n// needle again\n')
  await page.goto(app.url)
  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  const input = search.getByRole('textbox', { name: 'Search files', exact: true })
  await input.fill('needle')
  await expect(search.getByText('3 results in 1 file', { exact: true })).toBeVisible()
  await expect(search.locator('[data-icon-token="typescript"]')).toBeVisible()
  await search.getByRole('button', { name: 'Open matches.ts:1', exact: true }).first().click()
  await expect(page.getByRole('textbox', { name: 'matches.ts', exact: true })).toBeFocused()
  const highlightedText = () =>
    page.evaluate(() =>
      Array.from(CSS.highlights.get('gitna-search') ?? [], (range) =>
        range instanceof Range ? range.toString() : null,
      ),
    )
  await expect.poll(highlightedText).toEqual(['needle', 'needle', 'needle'])
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get('gitna-search-active')?.size))
    .toBe(1)
  await page.keyboard.press('Control+Shift+f')
  await expect(input).toBeFocused()
  await expect.poll(highlightedText).toEqual(['needle', 'needle', 'needle'])
  await page.screenshot({ path: join(tmpdir(), 'gitna-search-highlights-light.png') })
  await page.getByRole('button', { name: 'Theme settings' }).click()
  await page.getByRole('menu').getByRole('button', { name: 'Dark', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(highlightedText).toEqual(['needle', 'needle', 'needle'])
  await page.screenshot({ path: join(tmpdir(), 'gitna-search-highlights-dark.png') })
  await input.fill('again')
  await expect(search.getByText('1 result in 1 file', { exact: true })).toBeVisible()
  await expect.poll(highlightedText).toEqual(['again'])
  await search.getByRole('button', { name: 'Clear search' }).click()
  await expect.poll(highlightedText).toEqual([])
})
