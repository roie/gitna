import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

test('an open editable file follows a dark to light theme round trip', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'theme.ts'), 'export const answer = 42\n')
  await page.goto(app.url)

  const chooseTheme = async (name: 'Dark' | 'Light') => {
    const trigger = page.getByRole('button', { name: 'Theme settings' })
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name, exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  }

  await chooseTheme('Light')

  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'theme.ts', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'theme.ts' })).toBeVisible()

  const codeSurface = page.locator('diffs-container').first()
  const background = () =>
    codeSurface.evaluate((element) => getComputedStyle(element).backgroundColor)
  const lightBackground = await background()

  await chooseTheme('Dark')
  await expect.poll(background).not.toBe(lightBackground)

  await chooseTheme('Light')
  await expect.poll(background).toBe(lightBackground)
})
