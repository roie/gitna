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

async function selectLongLineOffset(page: Page, character: number) {
  const editor = page.getByRole('textbox', { name: 'windowed.txt', exact: true })
  await editor.evaluate((element) => {
    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true, composed: true }),
    )
    element.focus({ preventScroll: true })
  })
  await expect
    .poll(() =>
      editor
        .locator('span[data-char]')
        .evaluateAll(
          (tokens, offset) =>
            tokens.some(
              (token) =>
                Number(token.getAttribute('data-char')) <= offset &&
                Number(token.getAttribute('data-char')) + (token.textContent?.length ?? 0) >=
                  offset,
            ),
          character,
        ),
    )
    .toBe(true)
  await editor.evaluate((element, offset) => {
    const row = element.querySelector('[data-line-index="0"]')!
    const tokens = row.querySelectorAll<HTMLElement>('span[data-char]')
    for (const token of tokens) {
      const start = Number(token.dataset.char)
      if (offset < start || offset > start + (token.textContent?.length ?? 0)) continue
      const walker = document.createTreeWalker(token, NodeFilter.SHOW_TEXT)
      let remaining = offset - start
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (remaining <= (node.textContent?.length ?? 0)) {
          window.getSelection()!.setBaseAndExtent(node, remaining, node, remaining)
          return
        }
        remaining -= node.textContent?.length ?? 0
      }
    }
    throw new Error(`Column ${offset} is not rendered`)
  }, character)
  await page.waitForTimeout(50)
  await page.evaluate(() =>
    document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', bubbles: true })),
  )
}

for (const wrapped of [false]) {
  test(`long ASCII line edits, search, selection and scroll: wrap ${wrapped}`, async ({
    page,
    app,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const original = Array.from(
      { length: 5000 },
      (_, index) => `${String(index).padStart(9, '0')} `,
    ).join('')
    const file = join(app.repo, 'windowed.txt')
    writeFileSync(file, original)
    await page.goto(app.url)
    await openFile(page, 'windowed.txt')
    await page.getByRole('button', { name: 'Display settings', exact: true }).click()
    const wrap = page.getByRole('switch', { name: 'Word wrap', exact: true })
    if ((await wrap.isChecked()) !== wrapped) await wrap.click()
    await page.keyboard.press('Escape')
    const editor = page.getByRole('textbox', { name: 'windowed.txt', exact: true })
    await editor.focus()
    await page.keyboard.press('Control+f')
    await page
      .getByRole('textbox', { name: 'Search', exact: true })
      .fill(original.slice(25000, 25030))
    await expect(page.locator('[data-matches]')).toHaveText('1 of 1')
    await expect
      .poll(() =>
        page.evaluate(() => {
          const registry = (CSS as typeof CSS & { highlights: Map<string, Set<Range>> }).highlights
          return [...(registry.get('diffs-search-current') ?? [])].some((range) => {
            if (!(range instanceof Range)) return false
            const rect = range.getBoundingClientRect()
            return range.toString().length === 30 && rect.right > 0 && rect.left < innerWidth
          })
        }),
      )
      .toBe(true)
    await selectLongLineOffset(page, 25000)
    await page.keyboard.insertText('INSERT')
    await page.keyboard.press('Control+s')
    const changed = `${original.slice(0, 25000)}INSERT${original.slice(25000)}`
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(changed)
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+c')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('T')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(original)
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+c')
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(original[24999])
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Control+Shift+z')
    await page.keyboard.press('Control+s')
    await expect.poll(() => readFileSync(file, 'utf8')).toBe(changed)
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Escape')
    if (!wrapped) {
      await expect
        .poll(() => editor.textContent().then((text) => text?.length ?? 0))
        .toBeLessThan(10000)
      await editor.evaluate((element) => {
        element.parentElement!.scrollLeft = 200000
      })
    } else {
      await page.locator('.code-view.cv-scrollbar').evaluate((element) => {
        element.scrollTop = 5000
      })
    }
    await page.waitForTimeout(100)
    const visible = await editor.locator('[data-line] span[data-char]').evaluateAll((tokens) =>
      tokens.map((token) => ({
        start: Number(token.getAttribute('data-char')),
        text: token.textContent ?? '',
      })),
    )
    expect(visible.length).toBeGreaterThan(0)
    for (const token of visible)
      expect(changed.slice(token.start, token.start + token.text.length)).toBe(token.text)
    if (!wrapped) expect(visible[0]!.start).toBeGreaterThan(0)
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
