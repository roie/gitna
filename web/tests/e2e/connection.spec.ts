import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures.js'

const SCREENSHOT_DIR = '/tmp/gitna-b2-consolidation-visual'
const LONG_CONNECTION_ERROR =
  '读取失败 🧭 Не удалось обновить состояние: ' +
  '超长错误详情_'.repeat(12) +
  'unbroken-error-detail-'.repeat(18)

async function setColorMode(page: import('@playwright/test').Page, mode: 'light' | 'dark') {
  await page.getByRole('button', { name: 'Theme settings' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: mode === 'light' ? 'Light' : 'Dark', exact: true }).click()
}

async function assertSingleGlobalConnection(page: import('@playwright/test').Page) {
  const connections = page.locator('[data-connection-state]')
  await expect(connections).toHaveCount(1)
  expect(
    await connections
      .first()
      .evaluate(
        (element) =>
          element.closest('aside') == null &&
          element.closest('[data-pane-body="source-control"]') == null,
      ),
  ).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
}

async function captureRecovery(
  page: import('@playwright/test').Page,
  appRepo: string,
  name: string,
  focus: 'summary' | 'retry',
) {
  let failureSent = false
  let recoverySnapshotHeld = false
  let releaseRecoverySnapshot!: () => void
  const recoverySnapshotGate = new Promise<void>((resolve) => {
    releaseRecoverySnapshot = resolve
  })
  let markSnapshotSeen!: () => void
  const snapshotRequested = new Promise<void>((resolve) => {
    markSnapshotSeen = resolve
  })
  await page.route('**/api/v1/snapshot', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue()
      return
    }
    if (!failureSent) {
      failureSent = true
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: LONG_CONNECTION_ERROR }),
      })
      return
    }
    if (!recoverySnapshotHeld) {
      recoverySnapshotHeld = true
      markSnapshotSeen()
      await recoverySnapshotGate
    }
    await route.continue()
  })

  writeFileSync(join(appRepo, `visual-recovery-${name}.txt`), 'native SSE visual recovery\n')
  await snapshotRequested
  const connection = page.locator('[data-connection-state]')
  await expect(connection).toHaveAttribute('data-connection-state', 'reconciling')
  await expect(connection).toContainText(LONG_CONNECTION_ERROR)
  const details = connection.locator('div').filter({ hasText: LONG_CONNECTION_ERROR }).last()
  expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)

  const summary = connection.locator('summary')
  await summary.click({ force: true })
  await expect(summary).toBeVisible()
  await expect(connection.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(connection).toContainText(
    'Connection is open, but authoritative refresh is not complete.',
  )
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}-details.png`,
    fullPage: true,
  })

  const focusTarget =
    focus === 'summary' ? summary : connection.getByRole('button', { name: 'Retry', exact: true })
  await focusTarget.focus()
  await expect(focusTarget).toBeFocused()
  releaseRecoverySnapshot()
  await expect(connection).toHaveAttribute('data-connection-state', 'connected', {
    timeout: 20_000,
  })
  await expect(connection).toContainText('Refresh complete')
  await expect(focusTarget).toBeFocused()
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}-recovered.png`,
    fullPage: true,
  })
  await page.unroute('**/api/v1/snapshot')
  await assertSingleGlobalConnection(page)
}

test('bounded visual recovery acceptance covers desktop, mobile, themes, home, and drawer', async ({
  page,
  app,
}) => {
  test.setTimeout(120_000)
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(app.url)
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-section="repository"]').click()
  await setColorMode(page, 'dark')
  await captureRecovery(page, app.repo, 'desktop-dark', 'summary')

  await setColorMode(page, 'light')
  await captureRecovery(page, app.repo, 'desktop-light', 'retry')

  await page.getByRole('button', { name: 'Open Gitna Home' }).click()
  await expect(page.getByRole('textbox', { name: 'Folder path' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
  await assertSingleGlobalConnection(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop-home-header.png`, fullPage: true })
  await captureRecovery(page, app.repo, 'desktop-home-unavailable', 'summary')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(app.url)
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('aside[aria-label="Source Control"]')).toHaveAttribute(
    'aria-hidden',
    'true',
  )
  await assertSingleGlobalConnection(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/mobile-sidebar-hidden.png`, fullPage: true })

  await page.getByRole('button', { name: 'Open Source Control' }).click()
  const sidebar = page.locator('aside[aria-label="Source Control"]')
  await expect(sidebar).toBeVisible()
  await expect(sidebar).not.toHaveAttribute('aria-hidden', 'true')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/mobile-drawer-open.png`, fullPage: true })
  await captureRecovery(page, app.repo, 'mobile-drawer-unavailable', 'retry')
  await page.goto(app.url)
  await expect(page.locator('[data-connection-state="connected"]')).toBeVisible({ timeout: 20_000 })
  await setColorMode(page, 'dark')
  await captureRecovery(page, app.repo, 'mobile-dark', 'summary')
  await setColorMode(page, 'light')
  await captureRecovery(page, app.repo, 'mobile-light', 'retry')
})
