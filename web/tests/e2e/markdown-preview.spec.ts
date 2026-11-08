import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { pdfFixture } from './pdf-fixture.js'

test.use({ channel: 'chromium' })

async function openFile(page: Page, path: string) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill(path)
  await palette.getByRole('option').filter({ hasText: path }).first().click()
}

test('navigation keeps the outgoing Markdown preview until the destination is ready', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'outgoing.md'), '# Outgoing preview\n')
  writeFileSync(join(app.repo, 'destination.txt'), 'Destination content\n')
  await page.goto(app.url)
  await openFile(page, 'outgoing.md')
  await page.getByRole('button', { name: 'Open Markdown preview', exact: true }).click()
  const preview = page.getByRole('region', { name: 'Markdown preview' })
  await expect(preview.getByRole('heading', { name: 'Outgoing preview' })).toBeVisible()
  await page.evaluate(() => {
    const frames: string[] = []
    Object.assign(window, { previewNavigationFrames: frames })
    const inspect = () => {
      const outgoing = [...document.querySelectorAll('diffs-container')].some((host) =>
        host.shadowRoot?.querySelector('[aria-label="outgoing.md"]'),
      )
      if (outgoing && document.querySelector('.markdown-preview-open') == null)
        frames.push('editor')
      requestAnimationFrame(inspect)
    }
    requestAnimationFrame(inspect)
  })
  let received!: (route: Route) => void
  let release!: () => void
  const request = new Promise<Route>((resolve) => {
    received = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/worktree/file?*path=destination.txt*', async (route) => {
    received(route)
    await waiting
  })
  try {
    await openFile(page, 'destination.txt')
    const route = await request
    await expect(preview.getByRole('heading', { name: 'Outgoing preview' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'outgoing.md', exact: true })).toHaveCount(0)
    await route.continue()
    release()
    await expect(page.getByRole('textbox', { name: 'destination.txt', exact: true })).toContainText(
      'Destination content',
    )
    await expect(preview).toHaveCount(0)
    await openFile(page, 'outgoing.md')
    await expect(preview.getByRole('heading', { name: 'Outgoing preview' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'outgoing.md', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, 'previewNavigationFrames'))).toEqual([])
  } finally {
    release()
  }
})

test('rapid preview navigation rejects obsolete responses, preserves modes, and recovers from errors', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'first.md'), '# First preview\n')
  writeFileSync(join(app.repo, 'second.md'), '# Current second preview\n')
  writeFileSync(join(app.repo, 'failure.md'), '# Unavailable\n')
  await page.goto(app.url)
  await openFile(page, 'first.md')
  await page.getByRole('button', { name: 'Open Markdown preview', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'First preview' })).toBeVisible()

  let received!: (route: Route) => void
  let release!: () => void
  const request = new Promise<Route>((resolve) => {
    received = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route('**/api/v1/worktree/file?*path=second.md*', async (route) => {
    if (++requests > 1) return route.continue()
    received(route)
    await waiting
  })
  try {
    await openFile(page, 'second.md')
    const obsolete = await request
    await expect(page.getByRole('heading', { name: 'First preview' })).toBeVisible()
    await openFile(page, 'first.md')
    await expect(page.getByRole('heading', { name: 'First preview' })).toBeVisible()
    await openFile(page, 'second.md')
    await expect(page.getByRole('textbox', { name: 'second.md', exact: true })).toContainText(
      'Current second preview',
    )
    await page.getByRole('button', { name: 'Open Markdown preview', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Current second preview' })).toBeVisible()
    await page.clock.install()
    await obsolete.fulfill({
      json: { path: 'second.md', content: '# Obsolete preview\n', hash: 'obsolete' },
    })
    release()
    await page.clock.runFor(1000)
    await expect(page.getByRole('heading', { name: 'Current second preview' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Obsolete preview' })).toHaveCount(0)

    await page.route('**/api/v1/worktree/file?*path=failure.md*', (route) =>
      route.fulfill({
        status: 503,
        json: { error: { message: 'Preview navigation failed' } },
      }),
    )
    await openFile(page, 'failure.md')
    await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t open file' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Markdown preview' })).toHaveCount(0)
    await openFile(page, 'second.md')
    await expect(page.getByRole('heading', { name: 'Current second preview' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'second.md', exact: true })).toHaveCount(0)
    for (const path of ['first.md', 'second.md', 'first.md', 'second.md']) {
      await openFile(page, path)
      await expect(
        page.getByRole('heading', {
          name: path === 'first.md' ? 'First preview' : 'Current second preview',
        }),
      ).toBeVisible()
      await expect(page.getByRole('textbox', { name: path, exact: true })).toHaveCount(0)
    }
  } finally {
    release()
  }
})

test('SVG preview navigation keeps the outgoing image instead of exposing its editor', async ({
  page,
  app,
}) => {
  writeFileSync(
    join(app.repo, 'outgoing.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="red"/></svg>',
  )
  writeFileSync(join(app.repo, 'destination.md'), '# Markdown destination\n')
  await page.goto(app.url)
  await openFile(page, 'outgoing.svg')
  await page.getByRole('button', { name: 'Open SVG preview', exact: true }).click()
  const image = page.getByRole('region', { name: 'SVG preview' }).getByRole('img')
  await expect(image).toHaveJSProperty('naturalWidth', 240)
  let received!: (route: Route) => void
  let release!: () => void
  const request = new Promise<Route>((resolve) => {
    received = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/worktree/file?*path=destination.md*', async (route) => {
    received(route)
    await waiting
  })
  try {
    await openFile(page, 'destination.md')
    const route = await request
    await expect(image).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'outgoing.svg', exact: true })).toHaveCount(0)
    await expect(page.getByRole('status').filter({ hasText: 'Opening file' })).toBeVisible()
    await expect(image).toHaveJSProperty('naturalWidth', 240)
    const largestStatusSurface = await page
      .getByRole('status')
      .filter({ hasText: 'Opening file' })
      .evaluate((element) => {
        const viewer = element.closest('.markdown-file-view')!
        let largest = 0
        for (
          let node: Element | null = element;
          node != null && node !== viewer;
          node = node.parentElement
        ) {
          if (getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)') continue
          const bounds = node.getBoundingClientRect()
          largest = Math.max(largest, bounds.width * bounds.height)
        }
        return largest
      })
    const viewerBounds = (await page.locator('.markdown-file-view').boundingBox())!
    expect(largestStatusSurface).toBeLessThan((viewerBounds.width * viewerBounds.height) / 10)
    await page.screenshot({ path: test.info().outputPath('retained-svg-pending.png') })
    await route.continue()
    release()
    await page.unroute('**/api/v1/worktree/file?*path=destination.md*')
    await expect(page.getByRole('textbox', { name: 'destination.md', exact: true })).toContainText(
      'Markdown destination',
    )
    await expect(image).toHaveCount(0)
    await page.getByRole('button', { name: 'Open Markdown preview', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Markdown destination' })).toBeVisible()
    await openFile(page, 'outgoing.svg')
    await expect(image).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'outgoing.svg', exact: true })).toHaveCount(0)
    await openFile(page, 'destination.md')
    await expect(page.getByRole('heading', { name: 'Markdown destination' })).toBeVisible()
  } finally {
    release()
  }
})

test.describe('native preview navigation', () => {
  for (const extension of ['mp3', 'mp4', 'pdf']) {
    test(`retains Markdown through pending ${extension} authorization, cancellation, and failure`, async ({
      page,
      app,
    }) => {
      writeFileSync(join(app.repo, 'outgoing.md'), '# Retained outgoing preview\n')
      const path = `destination.${extension}`
      if (extension === 'pdf') writeFileSync(join(app.repo, path), pdfFixture())
      else
        copyFileSync(
          new URL(
            `./media-fixtures/${extension === 'mp3' ? 'mp3.mp3' : 'h264.mp4'}`,
            import.meta.url,
          ),
          join(app.repo, path),
        )
      await page.goto(app.url)
      await openFile(page, 'outgoing.md')
      await page.getByRole('button', { name: 'Open Markdown preview', exact: true }).click()
      const heading = page.getByRole('heading', { name: 'Retained outgoing preview' })
      await expect(heading).toBeVisible()
      const pattern = `**/api/v1/${extension === 'pdf' ? 'pdf-preview' : 'media'}?path=${path}`
      const method = extension === 'pdf' ? 'POST' : 'HEAD'
      let received!: (route: Route) => void
      let release!: () => void
      const request = new Promise<Route>((resolve) => {
        received = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route(pattern, async (route) => {
        if (route.request().method() !== method) return route.continue()
        received(route)
        await waiting
      })
      try {
        await openFile(page, path)
        const pending = await request
        await expect(heading).toBeVisible()
        await expect(page.getByRole('status').filter({ hasText: 'Opening file' })).toBeVisible()
        await expect(page.getByRole('region', { name: 'Media preview' })).toHaveCount(0)
        await expect(page.getByRole('textbox', { name: 'outgoing.md', exact: true })).toHaveCount(0)
        await openFile(page, 'outgoing.md')
        await pending.continue().catch(() => {})
        release()
        await page.unroute(pattern)
        await expect(heading).toBeVisible()
        await expect(page.getByRole('region', { name: 'Media preview' })).toHaveCount(0)
        await openFile(page, path)
        await expect(page.getByRole('region', { name: 'Media preview' })).toBeVisible()
        await expect(heading).toHaveCount(0)
        if (extension === 'pdf')
          await expect(page.getByTitle(`PDF preview: ${path}`, { exact: true })).toBeVisible()
        else await expect(page.locator(extension === 'mp3' ? 'audio' : 'video')).toBeVisible()
        await openFile(page, 'outgoing.md')
        await expect(heading).toBeVisible()
        await page.route(pattern, (route) =>
          route.request().method() === method
            ? route.fulfill({ status: 503, body: '' })
            : route.continue(),
        )
        await openFile(page, path)
        await expect(page.getByRole('region', { name: 'Media preview' })).toBeVisible()
        await expect(
          page.getByText(
            extension === 'pdf'
              ? 'PDF preview is unavailable. Reload it or download the file to open it locally.'
              : 'Could not load this file. It may have changed or the connection was lost.',
            { exact: true },
          ),
        ).toBeVisible()
        await expect(heading).toHaveCount(0)
      } finally {
        release()
      }
    })
  }
})

test('long Markdown scrolls in preview and editor after switching modes', async ({ page, app }) => {
  writeFileSync(
    join(app.repo, 'long.md'),
    Array.from(
      { length: 120 },
      (_, i) => `## ScrollSection${i}\n\nParagraph ${i} with some content.\n`,
    ).join('\n'),
  )
  await page.goto(app.url)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  await search.getByRole('textbox', { name: 'Search files', exact: true }).fill('ScrollSection0')
  await search.getByRole('button', { name: 'Open long.md:1' }).click()
  await search.getByRole('button', { name: 'Show Source Control' }).click()
  const scroller = page.locator('.code-view.cv-scrollbar')
  const previewButton = page.getByRole('button', { name: 'Open Markdown preview', exact: true })
  const splitButton = page.getByRole('button', { name: 'Open Markdown preview to the side' })
  const heading = page.getByRole('heading', { name: 'ScrollSection0' })
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => (element as HTMLElement).offsetWidth - (element as HTMLElement).clientWidth,
      ),
    )
    .toBe(12)
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => getComputedStyle(element, '::-webkit-scrollbar-track').marginTop,
      ),
    )
    .toBe('44px')
  await previewButton.click()
  await expect(heading).toBeVisible()
  const previewScroll = page.getByRole('region', { name: 'Markdown preview' }).locator('article')
  await expect
    .poll(() => scroller.evaluate((element) => getComputedStyle(element).scrollbarWidth))
    .toBe('none')
  await expect
    .poll(() =>
      previewScroll.evaluate(
        (element) => (element as HTMLElement).offsetWidth - (element as HTMLElement).clientWidth,
      ),
    )
    .toBe(12)
  await heading.hover()
  await page.mouse.wheel(0, 740)
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(350)
  await previewScroll.focus()
  const beforeKeyboard = await previewScroll.evaluate((element) => element.scrollTop)
  await page.keyboard.press('PageDown')
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeKeyboard + 100)
  const previewBeforeSplit = await previewScroll.evaluate((element) => element.scrollTop)
  await splitButton.click()
  await expect
    .poll(() => scroller.evaluate((element) => getComputedStyle(element).scrollbarWidth))
    .toBe('none')
  await expect
    .poll(() => previewScroll.evaluate((element) => getComputedStyle(element).scrollbarWidth))
    .not.toBe('none')
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(previewBeforeSplit - 30)
  await previewScroll.hover()
  await page.mouse.wheel(0, 740)
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(350)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(250)
  await previewScroll.evaluate((article) => {
    const anchor = article.querySelector<HTMLElement>('[data-source-line="81"]')!
    article.scrollTop += anchor.getBoundingClientRect().top - article.getBoundingClientRect().top
  })
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(1200)
  const visibleEditorLine = () =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.code-view.cv-scrollbar')!
      const root = scroller.querySelector('diffs-container')!.shadowRoot!
      const top = scroller.getBoundingClientRect().top
      const lines = Array.from(
        root.querySelectorAll<HTMLElement>('[data-line-index][data-line-type="context"]'),
      )
        .filter((line) => line.getBoundingClientRect().bottom >= top)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      return Number(lines[0]?.dataset.lineIndex) + 1
    })
  await expect.poll(visibleEditorLine).toBeGreaterThan(70)
  await expect.poll(visibleEditorLine).toBeLessThan(95)
  await scroller.hover()
  const previewBeforeEditorWheel = await previewScroll.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 740)
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(previewBeforeEditorWheel + 100)
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await expect
    .poll(() => scroller.evaluate((element) => getComputedStyle(element).scrollbarWidth))
    .not.toBe('none')
  await scroller.hover()
  const before = await scroller.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 740)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before + 350)
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(5000)
  await previewButton.click()
  await expect(page.locator('diffs-container [data-diffs-header]')).toBeVisible()
  await previewScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(page.getByRole('heading', { name: 'ScrollSection119' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await previewScroll.evaluate((element) => {
    element.scrollTop = 0
  })
  await previewScroll.hover()
  await page.mouse.wheel(0, 740)
  await expect
    .poll(() => previewScroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(350)
})

test('Markdown preview follows the live editor and keeps its undo state across modes', async ({
  page,
  app,
}) => {
  mkdirSync(join(app.repo, 'docs'), { recursive: true })
  writeFileSync(
    join(app.repo, 'docs/notes.md'),
    '# UniquePreviewTitle\n\n- [x] checked\n\n![local](picture.png#fragment)\n\n![remote](https://example.com/tracker.png)\n\n![escape](../../outside.png)\n\n[other note](other.txt) [unsafe](javascript:alert(1))\n\n<script>alert(1)</script>\n',
  )
  writeFileSync(join(app.repo, 'docs/other.txt'), 'A linked note\n')
  writeFileSync(
    join(app.repo, 'docs/picture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await page.goto(app.url)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toBeVisible()
  await page.keyboard.press('Control+Shift+f')
  const search = page.getByRole('region', { name: 'Find in Files' })
  await search
    .getByRole('textbox', { name: 'Search files', exact: true })
    .fill('UniquePreviewTitle')
  await search.getByRole('button', { name: 'Open docs/notes.md:1' }).click()
  const previewButton = page.getByRole('button', { name: 'Open Markdown preview', exact: true })
  const splitButton = page.getByRole('button', { name: 'Open Markdown preview to the side' })
  await expect(previewButton).toBeVisible()
  await splitButton.click()
  const nativeHeader = page.locator('diffs-container [data-diffs-header]')
  const splitHeader = page.getByText('Preview', { exact: true })
  await expect(nativeHeader).toBeVisible()
  await expect(splitHeader).toBeVisible()
  await expect
    .poll(async () =>
      Math.abs((await nativeHeader.boundingBox())!.y - (await splitHeader.boundingBox())!.y),
    )
    .toBeLessThan(2)
  const preview = page.getByRole('region', { name: 'Markdown preview' })
  await expect(preview.getByRole('heading', { name: 'UniquePreviewTitle' })).toBeVisible()
  await page.screenshot({ path: '/tmp/gitna-markdown-split.png' })
  await expect(preview.getByRole('checkbox')).toBeChecked()
  await expect(preview.getByRole('img', { name: 'local' })).toHaveJSProperty('naturalWidth', 1)
  await expect(preview.getByText('Blocked image resource: remote')).toBeVisible()
  await expect(preview.getByText('Blocked image resource: escape')).toBeVisible()
  await expect(preview.locator('script, img[src*="example.com"]')).toHaveCount(0)
  await expect(preview.getByText('unsafe')).not.toHaveAttribute('href', /javascript:/i)
  const editor = page.getByRole('textbox', { name: 'docs/notes.md', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.insertText('NEW ')
  await expect(preview.getByRole('heading', { name: 'NEW UniquePreviewTitle' })).toBeVisible()
  await previewButton.click()
  await expect(preview.getByRole('heading', { name: 'NEW UniquePreviewTitle' })).toBeVisible()
  await expect(nativeHeader).toBeVisible()
  await expect(splitHeader).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'docs/notes.md', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Return to editor', exact: true }).click()
  await expect(preview).toHaveCount(0)
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\n# HiddenEditRevision\n')
  await expect(page.getByLabel('Rendered Markdown')).toHaveAttribute('aria-busy', 'true')
  await page.evaluate(() => {
    const state = { stale: false }
    Object.assign(window, { markdownReopenState: state })
    const observer = new MutationObserver(() => {
      const article = document.querySelector('[aria-label="Rendered Markdown"]')
      if (
        article != null &&
        article.getAttribute('aria-busy') !== 'true' &&
        !article.textContent?.includes('HiddenEditRevision')
      )
        state.stale = true
    })
    observer.observe(document.body, { subtree: true, childList: true, attributes: true })
    Object.assign(window, { markdownReopenObserver: observer })
  })
  await splitButton.click()
  // Parsing may be asynchronous, but reopening must never mark the retained revision ready.
  await expect(preview.getByRole('heading', { name: 'HiddenEditRevision' })).toBeVisible()
  expect(
    await page.evaluate(() => {
      const w = window as unknown as {
        markdownReopenState: { stale: boolean }
        markdownReopenObserver: MutationObserver
      }
      w.markdownReopenObserver.disconnect()
      return w.markdownReopenState.stale
    }),
  ).toBe(false)
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await editor.focus()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await splitButton.click()
  await expect(preview.getByRole('heading', { name: 'UniquePreviewTitle' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(preview.getByRole('heading', { name: 'UniquePreviewTitle' })).toBeVisible()
  await page.screenshot({ path: '/tmp/gitna-markdown-mobile.png' })
  await page.setViewportSize({ width: 320, height: 844 })
  const headingBounds = await preview
    .getByRole('heading', { name: 'UniquePreviewTitle' })
    .boundingBox()
  expect(headingBounds).not.toBeNull()
  expect(headingBounds!.x + headingBounds!.width).toBeLessThanOrEqual(320)
  await preview.getByRole('link', { name: 'other note' }).click()
  await expect(page.getByRole('tab', { name: /other.txt/ })).toBeVisible()
})

test('Markdown worker failure leaves the editor usable and shows a render error', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'worker.md'), '# WorkerFailureTitle\n')
  await page.route('**/assets/markdown.worker-*.js', (route) => route.abort())
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  await page.locator('[aria-label="Search files and commands"]').fill('worker.md')
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.getByRole('option').click()
  await page.getByRole('button', { name: 'Open Markdown preview to the side' }).click()
  await expect(page.getByRole('alert')).toContainText('Markdown parser worker failed')
  const editor = page.getByRole('textbox', { name: 'worker.md', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('Editor still works')
  await expect(editor).toContainText('Editor still works')
})
