import { mkdirSync } from 'node:fs'

import { test, expect } from './fixtures.js'

const SCREENSHOT_DIR = '/tmp/gitna-connection-notifications'

test('connection notification stays stable across backend shutdown and recovery', async ({
  page,
  app,
}) => {
  test.setTimeout(90_000)
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Notifications')).toHaveCount(0)

  const restarted = await app.restart()
  const notifications = page.getByLabel('Notifications')
  await expect(notifications).toBeVisible({ timeout: 25_000 })
  await expect(notifications).toContainText('Connection interrupted')
  await expect(notifications).toContainText('Trying to reconnect.')
  await expect(notifications.getByText('Details', { exact: true })).toHaveCount(0)
  await expect(notifications).not.toContainText('folder data may be out of date')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/connection-interrupted.png`, fullPage: true })

  await page.waitForTimeout(2_000)
  await expect(notifications).toBeVisible()
  await expect(notifications).toContainText('Connection interrupted')

  await notifications.getByRole('button', { name: 'Dismiss Connection interrupted' }).click()
  await expect(page.getByLabel('Notifications')).toHaveCount(0)

  await page.goto(restarted.url)
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByLabel('Notifications')).toHaveCount(0)
})
