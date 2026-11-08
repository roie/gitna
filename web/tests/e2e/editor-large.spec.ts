import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

test.use({ trace: 'off' })

async function openFile(page: Page, path: string) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
  await palette
    .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
    .click()
}

for (const file of ['ordinary-2.tsx', 'ordinary-8.tsx', 'wrapped-6.txt']) {
  test(`large editor preserves typing, undo and navigation: ${file}`, async ({
    page,
    app,
  }, info) => {
    const fixtures = process.env.GITNA_EDITOR_FIXTURES
    if (fixtures != null) {
      copyFileSync(join(fixtures, file), join(app.repo, file))
    } else {
      const contents =
        file === 'wrapped-6.txt'
          ? 'text '.repeat(Math.ceil((6 << 20) / 5)).slice(0, 6 << 20)
          : 'export const line = <div>Some ordinary source code</div>\n'
              .repeat(160000)
              .slice(0, (file === 'ordinary-2.tsx' ? 2 : 8) << 20)
      writeFileSync(join(app.repo, file), contents)
    }
    execFileSync('git', ['add', '--', file], { cwd: app.repo })
    execFileSync('git', ['commit', '-qm', 'large editor fixture', '--', file], { cwd: app.repo })
    await page.goto(app.url)
    await openFile(page, file)
    await page.getByRole('button', { name: 'Open anyway', exact: true }).click()
    const editor = page.getByRole('textbox', { name: file, exact: true })
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-line][data-line-index="0"]')).toBeVisible()
    await page.locator('[data-line][data-line-index="0"]').click({ position: { x: 12, y: 8 } })
    await page.keyboard.press('Control+Home')
    await page.waitForTimeout(500)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.start')
    await page.evaluate(() => {
      const metrics = {
        gaps: [] as number[],
        tasks: [] as number[],
        events: [] as { name: string; duration: number; delay: number }[],
        running: true,
      }
      Object.assign(window, { largeEditorMetrics: metrics })
      let previous = performance.now()
      const frame = (now: number) => {
        if (!metrics.running) return
        metrics.gaps.push(now - previous)
        previous = now
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
      new PerformanceObserver((list) => {
        metrics.tasks.push(...list.getEntries().map((entry) => entry.duration))
      }).observe({ type: 'longtask' })
      const eventOptions = { type: 'event', durationThreshold: 16 }
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEventTiming[]) {
          metrics.events.push({
            name: entry.name,
            duration: entry.duration,
            delay: entry.processingStart - entry.startTime,
          })
        }
      }).observe(eventOptions)
    })
    for (const key of ['x', 'y', 'z']) {
      await page.keyboard.press(key)
      await page.waitForTimeout(800)
    }
    await expect(
      page.locator('[data-column-number="1"][data-gitna-change="modified"]'),
    ).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^Open commit / })).toBeHidden()
    const metrics = await page.evaluate(() => {
      const metrics = (
        window as unknown as {
          largeEditorMetrics: {
            running: boolean
            gaps: number[]
            tasks: number[]
            events: unknown[]
          }
        }
      ).largeEditorMetrics
      metrics.running = false
      return metrics
    })
    const { profile } = await cdp.send('Profiler.stop')
    await info.attach('typing-profile', {
      body: JSON.stringify(profile),
      contentType: 'application/json',
    })
    if (process.env.GITNA_EDITOR_RESULTS != null) {
      writeFileSync(
        join(process.env.GITNA_EDITOR_RESULTS, `${file}.cpuprofile`),
        JSON.stringify(profile),
      )
      writeFileSync(join(process.env.GITNA_EDITOR_RESULTS, `${file}.json`), JSON.stringify(metrics))
    }
    console.log(
      JSON.stringify({
        file,
        frames: metrics.gaps.length,
        maxFrameGapMs: Math.max(...metrics.gaps),
        longTasks: metrics.tasks,
        events: metrics.events,
      }),
    )
    await openFile(page, 'main.txt')
    await expect(page.getByRole('textbox', { name: 'main.txt', exact: true })).toBeVisible()
    await openFile(page, file)
    await expect(editor).toBeVisible()
    await expect(
      page.locator('[data-column-number="1"][data-gitna-change="modified"]'),
    ).toHaveCount(1)
    await editor.focus()
    await page.keyboard.press('Control+z')
    await expect(page.locator('[data-gitna-change]')).toHaveCount(0)
    const firstRow = page.locator('[data-line][data-line-index="0"]')
    const scroller = page.locator('.code-view.cv-scrollbar')
    const scrollBefore = await scroller.evaluate((element) => element.scrollTop)
    await firstRow.hover({ position: { x: 20, y: 8 } })
    await page.mouse.wheel(0, 2000)
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBefore + 100)
    await page.keyboard.press('Control+Home')
    await openFile(page, 'main.txt')
    await expect(page.getByRole('textbox', { name: 'main.txt', exact: true })).toBeVisible()
    await openFile(page, file)
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-gitna-change]')).toHaveCount(0)
  })
}

test('large Unicode drafts retain byte approval and survive backend restart', async ({
  page,
  app,
}) => {
  const file = 'unicode-draft.txt'
  const original = `${'é'.repeat(512)}\n`.repeat(520)
  writeFileSync(join(app.repo, file), original)
  await page.goto(app.url)
  await openFile(page, file)
  await page.getByRole('button', { name: 'Open anyway', exact: true }).click()
  const editor = page.getByRole('textbox', { name: file, exact: true })
  await expect(editor).toBeVisible()
  await page.locator('[data-line][data-line-index="0"]').click({ position: { x: 12, y: 8 } })
  await page.keyboard.press('Control+Home')
  const backedUp = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && response.url().includes('/api/v1/drafts'),
  )
  await page.keyboard.insertText('🙂')
  const response = await backedUp
  expect(response.ok()).toBe(true)
  const record = (await response.json()) as { contents: string; maxBytes: number }
  expect(record.contents).toBe(`🙂${original}`)
  expect(record.maxBytes).toBeGreaterThanOrEqual(Buffer.byteLength(record.contents))
  expect(Number(new URL(response.url()).searchParams.get('maxBytes'))).toBe(record.maxBytes)
  expect(readFileSync(join(app.repo, file), 'utf8')).toBe(original)
  const restarted = await app.restart()
  await page.goto(restarted.url)
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved documents' })
  await expect(recovery).toBeVisible()
  await recovery.getByRole('button', { name: 'Restore copy' }).click()
  await expect(page.getByRole('textbox').filter({ hasText: /^🙂é/ })).toBeVisible()
})
