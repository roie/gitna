import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures.js'

test('file gutters track the index, unsaved edits, undo, and staging', async ({ page, app }) => {
  await page.goto(app.url)
  const openFile = async (path: string) => {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
    await palette
      .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
      .click()
  }
  const marks = page.locator('[data-file] [data-gitna-change]')
  const row = (index: number) => page.locator(`[data-file] [data-line][data-line-index="${index}"]`)

  await openFile('two-hunk.txt')
  await expect(page.locator('[data-column-number="2"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  await row(10).click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('Home')
  await page.keyboard.type('inserted')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-column-number="11"][data-gitna-change="added"]')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(marks).toHaveCount(1)
  await expect(page.locator('[data-column-number="2"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  await row(2).click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-column-number="2"][data-gitna-deletion="after"]')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-gitna-deletion]')).toHaveCount(0)

  await row(2).hover()
  await page.mouse.wheel(0, 800)
  await expect(page.locator('[data-column-number="50"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  execFileSync('git', ['add', '--', 'two-hunk.txt'], { cwd: app.repo })
  await expect(marks).toHaveCount(0)
  await openFile('staged.txt')
  await expect(marks).toHaveCount(0)
  await openFile('untracked.txt')
  await expect(page.locator('[data-column-number="1"][data-gitna-change="added"]')).toHaveCount(1)
})
