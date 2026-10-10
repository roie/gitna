import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

test('preview layouts are remembered independently for each file', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'first.md'), '# FirstPreviewFile\n')
  writeFileSync(join(app.repo, 'second.md'), '# SecondPreviewFile\n')
  writeFileSync(
    join(app.repo, 'picture.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="red"/></svg>',
  )
  await page.goto(app.url)

  async function openFile(path: string) {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    await page.getByLabel('Search files and commands').fill(path)
    await page.getByRole('option').click()
    await expect(page.getByRole('textbox', { name: path, exact: true })).toBeVisible()
  }

  const markdown = page.getByRole('region', { name: 'Markdown preview' })
  const svg = page.getByRole('region', { name: 'SVG preview' })
  const markdownSplit = page.getByRole('button', { name: 'Open Markdown preview to the side' })
  const svgPreview = page.getByRole('button', { name: 'Open SVG preview', exact: true })
  const tabs = page.getByRole('tablist', { name: 'Open repository files' })

  await openFile('first.md')
  await markdownSplit.click()
  await expect(markdown.getByRole('heading', { name: 'FirstPreviewFile' })).toBeVisible()

  await openFile('picture.svg')
  await expect(svg).toHaveCount(0)
  await svgPreview.click()
  await expect(svg.getByRole('img')).toHaveJSProperty('naturalWidth', 240)
  await expect(page.getByRole('textbox', { name: 'picture.svg', exact: true })).toHaveCount(0)

  await openFile('second.md')
  await expect(markdown).toHaveCount(0)
  await openFile('main.txt')
  await expect(markdown).toHaveCount(0)
  await expect(svg).toHaveCount(0)

  await tabs.getByRole('tab', { name: 'first.md', exact: true }).click()
  await expect(markdown.getByRole('heading', { name: 'FirstPreviewFile' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'first.md', exact: true })).toBeVisible()

  await tabs.getByRole('tab', { name: 'picture.svg', exact: true }).click()
  await expect(svg.getByRole('img')).toHaveJSProperty('naturalWidth', 240)
  await expect(page.getByRole('textbox', { name: 'picture.svg', exact: true })).toHaveCount(0)

  await tabs.getByRole('tab', { name: 'second.md', exact: true }).click()
  await expect(markdown).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'second.md', exact: true })).toBeVisible()

  await tabs.getByRole('tab', { name: 'first.md', exact: true }).click()
  await markdownSplit.click()
  await expect(markdown).toHaveCount(0)
  await tabs.getByRole('tab', { name: 'picture.svg', exact: true }).click()
  await expect(svg.getByRole('img')).toBeVisible()
  await tabs.getByRole('tab', { name: 'first.md', exact: true }).click()
  await expect(markdown).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'first.md', exact: true })).toBeVisible()
})
