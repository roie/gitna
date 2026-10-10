import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures.js'

const branch =
  'topic/customer-onboarding-enterprise-platform-infrastructure-production-regional-billing-notifications'

test('long branch names can be read with the mouse and keyboard before switching', async ({
  page,
  app,
}) => {
  execFileSync('git', ['-C', app.repo, 'branch', branch])
  await page.goto(app.url)
  const picker = page.getByRole('button', { name: 'Switch branch · main', exact: true })
  await picker.click()
  const item = page.getByRole('menuitem', { name: branch, exact: true })
  await item.hover()
  await expect(page.getByRole('tooltip', { name: branch, exact: true })).toBeVisible()
  await item.click()
  const submenu = page.getByRole('menu', { name: branch, exact: true })
  await expect(submenu.getByText(branch, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  await picker.click()
  await page.getByRole('textbox', { name: 'Search or create branch' }).fill('customer-onboarding')
  await page.keyboard.press('Escape')
  await picker.focus()
  await page.keyboard.press('ArrowDown')
  await expect(item).toBeFocused()
  await expect(page.getByRole('tooltip', { name: branch, exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(submenu.getByText(branch, { exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Switch to branch', exact: true }).click()
  await expect(
    page.getByRole('button', { name: `Switch branch · ${branch}`, exact: true }),
  ).toBeVisible()
})

test.describe('narrow viewport', () => {
  test.use({ hasTouch: true })

  test('branch actions and their full name fit a 320px viewport', async ({ page, app }) => {
    execFileSync('git', ['-C', app.repo, 'branch', branch])
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(app.url)
    await page.getByRole('button', { name: 'Open Source Control', exact: true }).click()
    const picker = page.getByRole('button', { name: 'Switch branch · main', exact: true })
    await expect(picker).toBeVisible()
    await picker.tap()
    await page.getByRole('menuitem', { name: branch, exact: true }).tap()
    const submenu = page.getByRole('menu', { name: branch, exact: true })
    await expect(submenu.getByText(branch, { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const box = await submenu.boundingBox()
        return box != null && box.x >= 0 && box.x + box.width <= 320
      })
      .toBe(true)
    await expect(
      submenu.getByRole('menuitem', { name: 'Switch to branch', exact: true }),
    ).toBeVisible()
    await expect(
      submenu.getByRole('menuitem', { name: 'Delete branch…', exact: true }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await picker.click()
    await page.getByRole('menuitem', { name: branch, exact: true }).hover()
    await submenu.getByText(branch, { exact: true }).hover()
    await submenu.getByRole('menuitem', { name: 'Switch to branch', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `Switch branch · ${branch}`, exact: true }),
    ).toBeVisible()
  })
})

test('commit controls stay inside the sidebar at 200 percent text size', async ({ page, app }) => {
  await page.goto(app.url)
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%'
  })
  const commit = page.getByRole('button', { name: 'Commit', exact: true })
  const amend = page.getByRole('switch', { name: 'Amend', exact: true })
  await expect(commit).toBeVisible()
  await expect(amend).toBeVisible()
  const form = await page
    .getByRole('textbox', { name: 'Commit message' })
    .locator('..')
    .boundingBox()
  expect(form).not.toBeNull()
  for (const control of [commit, amend]) {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(form!.x)
    expect(box!.x + box!.width).toBeLessThanOrEqual(form!.x + form!.width + 1)
  }
  await page.getByRole('textbox', { name: 'Commit message' }).fill('Commit with enlarged text')
  await expect(commit).toBeEnabled()
  await commit.click()
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toHaveValue('')
  expect(
    execFileSync('git', ['-C', app.repo, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(),
  ).toBe('Commit with enlarged text')
})
