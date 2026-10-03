import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

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
  await splitButton.click()
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
  await previewButton.click()
  await expect(preview).toHaveCount(0)
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\n# HiddenEditRevision\n')
  await splitButton.click()
  // Reopening must not expose the retained revision during the edit debounce.
  expect(await preview.getByRole('heading', { name: 'HiddenEditRevision' }).count()).toBe(1)
  await splitButton.click()
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
