import { expect, test } from './fixtures.js'

test('current-line blame stays still and uses the graph commit hover', async ({ page, app }) => {
  const commitRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(`/commit/${app.baseOid}/files`)) commitRequests.push(request.url())
  })
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('two-hunk.txt')
  await palette.getByRole('option', { name: /two-hunk\.txt/ }).click()

  const row = (index: number) =>
    page.locator(`[data-line][data-line-index="${index}"][data-line-type="context"]`)
  const annotation = page.getByRole('button', { name: /^Open commit .*: base fixture$/ })
  await row(2).click({ position: { x: 20, y: 8 } })
  await expect(annotation).toBeVisible()
  await expect(annotation).toContainText('base fixture')
  const first = (await annotation.boundingBox())!
  const code = (await row(2).boundingBox())!
  expect(Math.abs(first.y + first.height / 2 - (code.y + code.height / 2))).toBeLessThan(1)

  await annotation.evaluate((element) => {
    const state = { blankFrames: 0, stopped: false }
    Object.assign(window, { blameObservation: state })
    const sample = () => {
      if (state.stopped) return
      if (!element.textContent || getComputedStyle(element).visibility === 'hidden')
        state.blankFrames += 1
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  await row(3).click({ position: { x: 20, y: 8 } })
  await expect.poll(async () => (await annotation.boundingBox())?.y).toBeGreaterThan(first.y)
  await row(2).click({ position: { x: 20, y: 8 } })
  await expect.poll(async () => (await annotation.boundingBox())?.y).toBe(first.y)
  await row(2).click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await annotation.boundingBox())?.y).toBeGreaterThan(first.y)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await annotation.boundingBox())?.y).toBe(first.y)

  const beforeHover = await annotation.boundingBox()
  await annotation.hover()
  const hover = page.getByRole('tooltip')
  await expect(hover).toContainText('Gitna E2E')
  await expect(hover).toContainText('base fixture')
  await expect(
    hover.getByRole('button', { name: `Copy commit ID ${app.baseOid.slice(0, 8)}` }),
  ).toBeVisible()
  await expect(hover).toContainText('files')
  expect(commitRequests).toHaveLength(1)
  expect(await annotation.boundingBox()).toEqual(beforeHover)
  const blankFrames = await page.evaluate(() => {
    const state = (
      window as unknown as { blameObservation: { blankFrames: number; stopped: boolean } }
    ).blameObservation
    state.stopped = true
    return state.blankFrames
  })
  expect(blankFrames).toBe(0)

  await page.getByRole('button', { name: 'Display settings', exact: true }).click()
  await page.getByRole('switch', { name: 'Inline blame', exact: true }).click()
  await expect(annotation).toBeHidden()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => localStorage.getItem('gitna:inline-blame'))).toBe('false')
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/worktree/line-history')) requests.push(request.url())
  })
  await row(4).click({ position: { x: 20, y: 8 } })
  await page.waitForTimeout(350)
  expect(requests).toEqual([])
  await page.reload()
  await page.getByRole('button', { name: 'Display settings', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Inline blame', exact: true })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Open command palette' }).click()
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('two-hunk.txt')
  await palette.getByRole('option', { name: /two-hunk\.txt/ }).click()

  await row(2).click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('Shift+ArrowDown')
  await expect(annotation).toBeHidden()
  await page.keyboard.press('ArrowLeft')
  await expect(annotation).toBeVisible()
  await page.keyboard.type('x')
  await expect(annotation).toBeHidden()
  await page.keyboard.press('Control+z')
  await expect(annotation).toBeVisible()

  await page.mouse.move(10, 10)
  await page.locator('[data-section="graph"]').click()
  await page.locator(`[data-graph-oid="${app.baseOid}"] [data-graph-disclosure]`).hover()
  await expect(hover).toContainText('base fixture')
  await expect(
    hover.getByRole('button', { name: `Copy commit ID ${app.baseOid.slice(0, 8)}` }),
  ).toBeVisible()

  await expect(hover).toContainText('files')
  expect(commitRequests).toHaveLength(2)
  await annotation.click()
  await expect(
    page.getByRole('tab', { name: new RegExp(`${app.baseOid.slice(0, 7)}.*base fixture`) }),
  ).toBeVisible()
  expect(commitRequests).toHaveLength(2)
})

test('inline blame hides uncommitted lines and untracked files', async ({ page, app }) => {
  await page.goto(app.url)
  const openFile = async (path: string) => {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
    await palette
      .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
      .click()
  }
  const row = (index: number) =>
    page.locator(`[data-line][data-line-index="${index}"][data-line-type="context"]`)
  const annotation = page.getByRole('button', { name: /^Open commit / })

  await openFile('two-hunk.txt')
  await row(2).click({ position: { x: 20, y: 8 } })
  await expect(annotation).toBeVisible()
  const changed = page.waitForResponse((response) =>
    response.url().includes('/worktree/line-history?path=two-hunk.txt&line=2'),
  )
  await row(1).click({ position: { x: 20, y: 8 } })
  expect(await (await changed).json()).toMatchObject({ uncommitted: true })
  await expect(annotation).toBeHidden()
  await expect(page.getByText('Not committed yet', { exact: true })).toHaveCount(0)
  await row(2).click({ position: { x: 20, y: 8 } })
  await expect(annotation).toBeVisible()
  await row(1).click({ position: { x: 20, y: 8 } })
  await expect(annotation).toBeHidden()

  await openFile('untracked.txt')
  const untracked = page.waitForResponse((response) =>
    response.url().includes('/worktree/line-history?path=untracked.txt&line=1'),
  )
  await row(0).click({ position: { x: 20, y: 8 } })
  expect(await (await untracked).json()).toMatchObject({ uncommitted: true })
  await expect(annotation).toBeHidden()
  await expect(page.getByText('Not committed yet', { exact: true })).toHaveCount(0)
})

test('inline blame truncates the message before author and relative age', async ({ page, app }) => {
  const summary = 'Explain why this line changed '.repeat(20)
  await page.route('**/worktree/line-history?*', async (route) => {
    const response = await route.fetch()
    const history = await response.json()
    await route.fulfill({
      response,
      json: {
        ...history,
        summary,
        authoredAt: new Date(Date.now() - 90 * 86400_000).toISOString(),
      },
    })
  })
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('two-hunk.txt')
  await palette.getByRole('option', { name: /two-hunk\.txt/ }).click()
  await page.locator('[data-line][data-line-index="2"][data-line-type="context"]').click()
  const annotation = page.getByRole('button', {
    name: `Open commit ${app.baseOid.slice(0, 7)}: ${summary}`,
  })
  await expect(annotation).toBeVisible()
  await expect(annotation.locator('span').first()).toHaveText('Gitna E2E · 3 months ago')
  const widths = await annotation.evaluate((button) => {
    const [prefix, message] = Array.from(button.querySelectorAll('span'))
    return {
      prefix: prefix!.clientWidth,
      prefixContent: prefix!.scrollWidth,
      message: message!.clientWidth,
      messageContent: message!.scrollWidth,
      right: button.getBoundingClientRect().right,
      viewport: window.innerWidth,
    }
  })
  expect(widths.prefix).toBe(widths.prefixContent)
  expect(widths.message).toBeGreaterThan(0)
  expect(widths.message).toBeLessThan(widths.messageContent)
  expect(widths.right).toBeLessThan(widths.viewport)
})
