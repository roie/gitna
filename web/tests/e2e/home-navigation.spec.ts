import { mkdirSync } from 'node:fs'
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
