import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test, expect } from './fixtures.js'

test('Home has its own URL and survives history navigation and reload', async ({ page, app }) => {
  await page.goto(app.url)
  const folderURL = page.url()
  const homeURL = new URL('../', folderURL).href
  const home = page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true })

  await page.getByRole('button', { name: 'Open Gitna Home' }).click()
  await expect(home).toBeVisible()
  await expect(page).toHaveURL(homeURL)
  await expect(page).toHaveTitle('Gitna')

  await page.goBack()
  await expect(page).toHaveURL(folderURL)
  await expect(home).toHaveCount(0)
  await page.goForward()
  await expect(home).toBeVisible()
  await expect(page).toHaveURL(homeURL)

  await page.reload()
  await expect(home).toBeVisible()
  await expect(page).toHaveURL(homeURL)
  await page.getByRole('button', { name: `Back to ${basename(app.repo)}` }).click()
  await expect(page).toHaveURL(folderURL)
  await expect(home).toHaveCount(0)

  await page.goto(homeURL)
  await expect(home).toBeVisible()
  await page
    .getByRole('button')
    .filter({ hasText: basename(app.repo) })
    .first()
    .click()
  await expect(page).toHaveURL(folderURL)
  await expect(home).toHaveCount(0)
})

test('a folder named home does not open Home', async ({ page, app }) => {
  const folder = join(dirname(app.repo), 'home')
  mkdirSync(folder)
  const homeURL = new URL('../', app.url).href
  await page.goto(homeURL)
  await expect(page.getByRole('heading', { name: 'Welcome back to Gitna' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Folder path', exact: true }).fill(folder)
  await page.getByRole('button', { name: 'Open Folder', exact: true }).click()
  await expect(page).toHaveURL(new URL('home/', homeURL).href)
  await expect(page).toHaveTitle('home - Gitna')
  await expect(page.getByRole('heading', { name: 'Welcome back to Gitna' })).toHaveCount(0)
  await page.reload()
  await expect(page).toHaveTitle('home - Gitna')
  await expect(page.getByRole('heading', { name: 'Welcome back to Gitna' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open Gitna Home' }).click()
  await expect(page).toHaveURL(homeURL)
  await expect(page.getByRole('heading', { name: 'Welcome back to Gitna' })).toBeVisible()
})

test('a file at the same path shows the new folder contents after a switch', async ({
  page,
  app,
}) => {
  const folder = join(dirname(app.repo), 'second-folder')
  mkdirSync(folder)
  writeFileSync(join(app.repo, 'notes.txt'), 'first folder notes\n')
  writeFileSync(join(folder, 'notes.txt'), 'second folder notes\n')
  await page.goto(app.url)

  async function openNotes() {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    await page.getByLabel('Search files and commands').fill('notes.txt')
    await page.getByRole('option').filter({ hasText: 'notes.txt' }).first().click()
    const editor = page.getByRole('textbox', { name: 'notes.txt', exact: true })
    await expect(editor).toBeVisible()
    return editor
  }

  await expect(await openNotes()).toContainText('first folder notes')
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.fill(folder)
  await folderPath.press('Enter')
  await expect(page).toHaveTitle('second-folder - Gitna')
  const editor = await openNotes()
  await expect(editor).toContainText('second folder notes')
  await expect(editor).not.toContainText('first folder notes')
})
