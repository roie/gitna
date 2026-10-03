import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, expect } from './fixtures.js'
import { NativeTransportProxy } from './native-transport.js'

async function openEditor(page: import('@playwright/test').Page) {
  await page.locator('[data-section="repository"]').click()
  const tree = page.locator('#gitna-repository-tree__tree')
  await tree.getByRole('treeitem', { name: 'main.txt', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'main.txt' })
  await expect(editor).toBeVisible()
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({ timeout: 20_000 })
  return editor
}

test('native SSE severing preserves dirty editor and recovers through the same route', async ({
  page,
  app,
}) => {
  test.setTimeout(90_000)
  const proxy = new NativeTransportProxy(app.url)
  await proxy.start()
  try {
    await page.goto(proxy.urlFor(app.url))
    await proxy.waitForStream()
    const editor = await openEditor(page)
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' native outage draft')
    const beforeOutage = (await editor.textContent()) ?? ''
    const editorHandle = await editor.elementHandle()
    expect(editorHandle).not.toBeNull()
    await expect(page.getByRole('tab', { name: /main\.txt Unsaved changes/ })).toBeVisible()

    const writesBeforeOutage = proxy.mutations
    proxy.setOutage(true)
    await expect(
      page.locator('span[role="status"][data-connection-state="unreachable"]'),
    ).toBeVisible({
      timeout: 16_000,
    })
    const blockedFile = page
      .locator('#gitna-repository-tree__tree')
      .getByRole('treeitem', { name: 'feature.txt', exact: true })
    await blockedFile.click({ force: true })
    await expect(page.getByRole('tab', { name: 'feature.txt', exact: true })).toHaveCount(0)
    await expect(page.getByText('Failed to fetch')).toHaveCount(0)

    // Native transport loss must not replace the mounted editor or its draft.
    expect(await editorHandle!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(editor).toHaveText(beforeOutage)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    expect(proxy.mutations).toBe(writesBeforeOutage)

    proxy.setOutage(false)
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(editor).toHaveText(beforeOutage)
    await editor.click()
    await page.keyboard.press('Control+z')
    await expect(editor).toHaveText('main branch')
    await page.keyboard.press('Control+Shift+z')
    await expect(editor).toHaveText(beforeOutage)
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' after reconnect')
    await expect(editor).toContainText('after reconnect')
    const save = page.getByRole('button', { name: 'Save', exact: true })
    await expect(save).toBeEnabled()
    const saveResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith('/api/v1/worktree/file'),
    )
    await save.click()
    const response = await saveResponse
    expect(response.status(), await response.text()).toBe(200)
    await expect
      .poll(() => readFileSync(join(app.repo, 'main.txt'), 'utf8'))
      .toContain('native outage draft')
    expect(proxy.mutations - writesBeforeOutage).toBe(1)
  } finally {
    await proxy.close()
  }
})

test('native transport distinguishes Snapshot session failures from file failures', async ({
  page,
  app,
}) => {
  test.setTimeout(60_000)
  const proxy = new NativeTransportProxy(app.url)
  await proxy.start()
  try {
    await page.goto(proxy.urlFor(app.url))
    await proxy.waitForStream()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    proxy.failNextSnapshot(403, 'session capability rejected')
    writeFileSync(join(app.repo, 'native-session-failure.txt'), 'trigger\n')
    const connection = page.getByLabel('Notifications').getByRole('status')
    await expect(connection).toHaveAttribute('data-connection-state', 'session-error', {
      timeout: 20_000,
    })
    await expect(connection).toContainText('session capability rejected')
    const openFolder = join(dirname(app.repo), 'native-open-folder')
    mkdirSync(openFolder)
    const folder = page.getByRole('combobox', { name: 'Folder path' })
    await expect(folder).toBeVisible()
    await folder.fill(openFolder)
    await page.getByRole('button', { name: 'Switch folder' }).click()
    await expect(page).toHaveTitle('native-open-folder - Gitna', { timeout: 30_000 })
    proxy.failNextSnapshot(404, 'session route not found')
    writeFileSync(join(openFolder, 'native-session-failure-404.txt'), 'trigger\n')
    await expect(connection).toHaveAttribute('data-connection-state', 'session-error', {
      timeout: 20_000,
    })
    await expect(connection).toContainText('session route not found', { timeout: 20_000 })
    const folders = await page.evaluate(async () => {
      const response = await fetch('api/v1/folders')
      return { status: response.status, body: await response.json() }
    })
    expect(folders.status).toBe(200)

    const missing = await page.evaluate(async () => {
      const response = await fetch('api/v1/worktree/file?path=missing-native-file.txt')
      return { status: response.status, body: await response.json() }
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toContain('missing-native-file.txt')
    await expect(connection).toHaveAttribute('data-connection-state', 'session-error')
  } finally {
    await proxy.close()
  }
})

test('ordinary folder recovery does not issue Git capability reads', async ({ page, app }) => {
  const ordinary = join(dirname(app.repo), 'native-ordinary-folder')
  mkdirSync(ordinary)
  writeFileSync(join(ordinary, 'ordinary.txt'), 'ordinary folder\n')
  const proxy = new NativeTransportProxy(app.url)
  await proxy.start()
  try {
    await page.goto(proxy.urlFor(app.url))
    await proxy.waitForStream()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    const folder = page.getByRole('combobox', { name: 'Folder path' })
    await folder.fill(ordinary)
    await Promise.all([page.waitForURL(/native-ordinary-folder/), folder.press('Enter')])
    const files = await page.evaluate(async () => {
      const response = await fetch('api/v1/files')
      return (await response.json()) as { paths: string[] }
    })
    expect(files.paths).toContain('ordinary.txt')
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    const folderSessionPath = new URL(page.url()).pathname
    expect(proxy.gitReadPaths.filter((path) => path.startsWith(folderSessionPath))).toEqual([])
  } finally {
    await proxy.close()
  }
})

test('Open Folder remains blocked while a mutation is busy', async ({ page, app }) => {
  const ordinary = join(dirname(app.repo), 'native-busy-folder')
  mkdirSync(ordinary)
  writeFileSync(join(ordinary, 'ordinary.txt'), 'busy folder\n')
  let releaseStage!: () => void
  let markStageStarted!: () => void
  const stageStarted = new Promise<void>((resolve) => {
    markStageStarted = resolve
  })
  const stageReleased = new Promise<void>((resolve) => {
    releaseStage = resolve
  })
  let stageRequests = 0
  await page.route('**/api/v1/operations?op=stage', async (route) => {
    stageRequests += 1
    markStageStarted()
    await stageReleased
    await route.continue()
  })
  try {
    await page.goto(app.url)
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    await page
      .locator('#gitna-unstaged-tree__tree')
      .getByRole('treeitem', {
        name: 'modified.txt',
        exact: true,
      })
      .click()
    await page.getByRole('button', { name: 'Stage file modified.txt' }).click()
    await stageStarted
    const folder = page.getByRole('combobox', { name: 'Folder path' })
    await folder.fill(ordinary)
    const switchFolder = page.getByRole('button', { name: 'Switch folder' })
    await expect(switchFolder).toBeDisabled()
    await expect(switchFolder).toHaveAttribute('title', /operation is in progress/i)
    await switchFolder.click({ force: true })
    await expect(page).toHaveTitle(/Gitna$/)
    expect(stageRequests).toBe(1)
  } finally {
    releaseStage()
  }
})

test('application file 404 remains a file error while the session stays connected', async ({
  page,
  app,
}) => {
  await page.route('**/api/v1/worktree/file?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')
    if (path === 'modified.txt') {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'file disappeared from the worktree' }),
      })
      return
    }
    await route.continue()
  })
  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
    timeout: 20_000,
  })
  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', {
      name: 'modified.txt',
      exact: true,
    })
    .click()
  await expect(page.getByRole('heading', { name: 'Couldn’t open file' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Gitna couldn’t read this file')
  await expect(page.getByRole('region', { name: 'Review' })).toBeVisible()
})

test('authoritative file-count catch-up gates readiness after native recovery', async ({
  page,
  app,
}) => {
  test.setTimeout(90_000)
  const proxy = new NativeTransportProxy(app.url)
  await proxy.start()
  try {
    await page.goto(proxy.urlFor(app.url))
    await proxy.waitForStream()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    proxy.setOutage(true)
    await expect(
      page.locator('span[role="status"][data-connection-state="unreachable"]'),
    ).toBeVisible({
      timeout: 16_000,
    })
    const held = proxy.holdNextFileCount()
    proxy.setOutage(false)
    await page.getByLabel('Notifications').getByRole('button', { name: 'Retry' }).click()
    await held.requested
    await expect(
      page.locator('span[role="status"][data-connection-state="reconciling"]'),
    ).toBeVisible()
    await expect(page.getByRole('region', { name: 'Review' })).toHaveAttribute(
      'data-connection-state',
      'reconciling',
    )
    held.release()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 30_000,
    })
  } finally {
    await proxy.close()
  }
})

test('failed authoritative directory refresh keeps the session non-ready', async ({
  page,
  app,
}) => {
  test.setTimeout(90_000)
  const proxy = new NativeTransportProxy(app.url)
  await proxy.start()
  try {
    await page.goto(proxy.urlFor(app.url))
    await proxy.waitForStream()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    proxy.setOutage(true)
    await expect(
      page.locator('span[role="status"][data-connection-state="unreachable"]'),
    ).toBeVisible({
      timeout: 20_000,
    })
    proxy.failNextDirectory(503, 'authoritative directory unavailable')
    proxy.setOutage(false)
    await page.getByLabel('Notifications').getByRole('button', { name: 'Retry' }).click()
    await expect(
      page.locator('span[role="status"][data-connection-state="reconciling"]'),
    ).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByRole('region', { name: 'Review' })).toHaveAttribute(
      'data-connection-state',
      'reconciling',
    )
    await expect(page.getByText('Refreshing backend state…')).toBeVisible()
  } finally {
    await proxy.close()
  }
})

test('repeated Retry joins one native recovery and does not dispatch mutations', async ({
  page,
  app,
}) => {
  test.setTimeout(90_000)
  const proxy = new NativeTransportProxy(app.url)
  await proxy.start()
  try {
    await page.goto(proxy.urlFor(app.url))
    await proxy.waitForStream()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 20_000,
    })
    const writesBefore = proxy.mutations
    proxy.setOutage(true)
    await expect(
      page.locator('span[role="status"][data-connection-state="unreachable"]'),
    ).toBeVisible({
      timeout: 16_000,
    })

    const held = proxy.holdNextSnapshot()
    proxy.setOutage(false)
    const retry = page.getByLabel('Notifications').getByRole('button', {
      name: 'Retry',
      exact: true,
    })
    await expect(retry).toBeVisible()
    await retry.click()
    await expect(
      page.getByLabel('Notifications').getByRole('button', { name: 'Retrying…' }),
    ).toBeDisabled()
    await held.requested
    await expect(
      page.locator('span[role="status"][data-connection-state="reconciling"]'),
    ).toBeVisible()
    expect(proxy.activeStreamCount).toBeLessThanOrEqual(1)
    held.release()
    await expect(page.getByRole('region', { name: 'Review' })).toBeVisible({
      timeout: 30_000,
    })
    expect(proxy.activeStreamCount).toBe(1)
    expect(proxy.maxConcurrentReadCount).toBeGreaterThan(0)
    expect(proxy.mutations).toBe(writesBefore)
  } finally {
    await proxy.close()
  }
})
