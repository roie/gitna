import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures.js'

test('late editor responses and Git failures cannot display stale indicators or fan out requests', async ({
  page,
  app,
}) => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending: string[] = []
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/worktree/')) requests.push(request.url())
  })
  await page.route('**/worktree/{baseline,blame}?*', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path')
    if (path === 'two-hunk.txt') {
      const response = await route.fetch()
      pending.push(route.request().url())
      await blocked
      await route.fulfill({ response })
    } else if (path === 'feature.txt') {
      await route.fulfill({ status: 500, json: { error: 'Git repository unreadable' } })
    } else {
      await route.continue()
    }
  })
  await page.goto(app.url)
  const openFile = async (path: string) => {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
    await palette
      .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
      .click()
    await expect(page.getByRole('textbox', { name: path, exact: true })).toBeVisible()
  }
  await openFile('two-hunk.txt')
  await expect.poll(() => pending.length).toBe(2)
  await openFile('main.txt')
  await page.locator('[data-line][data-line-index="0"]').click()
  await expect(page.getByRole('button', { name: /^Open commit .*: main change$/ })).toBeVisible()
  release()
  await page.waitForTimeout(250)
  await expect(page.locator('[data-gitna-change]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Open commit .*: base fixture$/ })).toHaveCount(0)
  await openFile('feature.txt')
  await page.locator('[data-line][data-line-index="0"]').click()
  await page.waitForTimeout(300)
  await expect(page.locator('[data-gitna-change]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Open commit / })).toHaveCount(0)
  expect(requests.filter((url) => url.includes('/line-history'))).toHaveLength(0)
  expect(
    requests.filter((url) => url.includes('/blame?') && url.includes('feature.txt')),
  ).toHaveLength(1)
})

test('rapid typing keeps the editor responsive and only paints the latest contents', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('two-hunk.txt')
  await palette.getByRole('option', { name: /two-hunk\.txt/ }).click()
  await page.locator('[data-line][data-line-index="3"]').click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('Home')
  await page.evaluate(() => {
    const timing = { frames: 0, maxGap: 0, previous: performance.now(), stopped: false }
    Object.assign(window, { editorTiming: timing })
    const frame = (now: number) => {
      if (timing.stopped) return
      timing.frames++
      timing.maxGap = Math.max(timing.maxGap, now - timing.previous)
      timing.previous = now
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  await page.keyboard.type('rapid '.repeat(20), { delay: 3 })
  await expect(page.locator('[data-column-number="4"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )
  await expect(page.getByRole('button', { name: /^Open commit / })).toBeHidden()
  const timing = await page.evaluate(() => {
    const timing = (
      window as unknown as { editorTiming: { frames: number; maxGap: number; stopped: boolean } }
    ).editorTiming
    timing.stopped = true
    return timing
  })
  console.log(JSON.stringify({ editorFrames: timing.frames, maxFrameGapMs: timing.maxGap }))
  expect(timing.frames).toBeGreaterThan(5)
  expect(timing.maxGap).toBeLessThan(150)
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-column-number="4"][data-gitna-change]')).toHaveCount(0)
})

test('inline blame invalidates missing index entries and HEAD', async ({ page, app }) => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: app.repo })
  let requests = 0
  page.on('request', (request) => {
    if (request.url().includes('/worktree/blame?path=main.txt')) requests++
  })
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill('main.txt')
  await palette.getByRole('option', { name: /^main\.txt / }).click()
  await page.locator('[data-line][data-line-index="0"]').click()
  const annotation = page.getByRole('button', { name: /^Open commit .*: main change$/ })
  await expect(annotation).toBeVisible()
  expect(requests).toBe(1)
  git('rm', '--cached', '--', 'main.txt')
  await expect(annotation).toBeHidden()
  git('reset', '-q', 'HEAD', '--', 'main.txt')
  await expect(annotation).toBeVisible()
  const beforeCommit = requests
  git('commit', '--allow-empty', '-qm', 'new HEAD')
  await expect.poll(() => requests).toBe(beforeCommit + 1)
  await expect(annotation).toBeVisible()
})
