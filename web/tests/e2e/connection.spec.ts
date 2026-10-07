import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from './fixtures.js'

const SCREENSHOT_DIR = '/tmp/gitna-connection-notifications'

test('healthy filesystem refreshes do not flash connection state or disable file actions', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const connection = page.locator('span[data-connection-state]')
  await expect(connection).toHaveAttribute('data-connection-state', 'connected')
  const tree = page.locator('#gitna-unstaged-tree__tree')
  await tree.getByRole('treeitem', { name: 'modified.txt', exact: true }).click()
  const stage = page.getByRole('button', { name: 'Stage file modified.txt' })
  await expect(stage).toBeEnabled()
  const announcement = await connection.locator('[data-connection-announcement]').textContent()
  await connection.evaluate((element) => {
    element.setAttribute('data-observed-states', '')
    new MutationObserver(() => {
      element.setAttribute(
        'data-observed-states',
        `${element.getAttribute('data-observed-states')},${element.getAttribute('data-connection-state')}`,
      )
    }).observe(element, { attributes: true, attributeFilter: ['data-connection-state'] })
  })

  for (let index = 0; index < 3; index += 1) {
    let release!: () => void
    let started!: () => void
    const requested = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/v1/snapshot', async (route) => {
      started()
      await gate
      await route.continue()
    })
    const name = `background-refresh-${index}.txt`
    writeFileSync(join(app.repo, name), 'background update\n')
    try {
      await requested
      await expect(connection).toHaveAttribute('data-connection-state', 'connected')
      await expect(stage).toBeEnabled()
      await expect(connection.locator('[data-connection-announcement]')).toHaveText(
        announcement ?? '',
      )
      await expect(page.getByLabel('Notifications')).toHaveCount(0)
    } finally {
      release()
    }
    await expect(tree.getByRole('treeitem', { name, exact: true })).toBeVisible()
    await page.unroute('**/api/v1/snapshot')
  }
  await expect(connection).toHaveAttribute('data-observed-states', '')
  await expect(stage).toBeEnabled()
})

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
