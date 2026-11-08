import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { pdfFixture } from './pdf-fixture.js'

test.use({ channel: 'chromium' })

async function openFile(page: Page, path: string, timed = false) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
  const option = palette.getByRole('option').filter({ hasText: path }).first()
  await expect(option).toBeVisible()
  if (timed) await pause(page)
  await option.click()
  if (timed) await page.clock.runFor(0)
}

async function hold(page: Page, pattern: string, method = 'GET') {
  let received!: (route: Route) => void
  let release!: () => void
  let requested = false
  const request = new Promise<Route>((resolve) => {
    received = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method) return route.continue()
    requested = true
    received(route)
    await waiting
  })
  return { request, release, isRequested: () => requested }
}

async function pause(page: Page) {
  const time = new Date()
  await page.clock.install({ time })
  await page.clock.pauseAt(new Date(time.getTime() + 1000))
}

for (const delay of [80, 199, 201, 1200]) {
  test(`file content is immediate and loading follows the 200 ms threshold (${delay} ms)`, async ({
    page,
    app,
  }) => {
    writeFileSync(join(app.repo, 'pending.txt'), 'Ready without a minimum loading duration\n')
    await page.goto(app.url)
    await expect(page.getByRole('button', { name: 'Open command palette' })).toBeEnabled()
    const pending = await hold(page, '**/api/v1/worktree/file?*path=pending.txt*')
    try {
      await openFile(page, 'pending.txt', true)
      const route = await pending.request
      const status = page.getByRole('status').filter({ hasText: 'Opening file' })
      await expect(status).toHaveCount(0)
      await page.clock.runFor(delay)
      if (delay < 200) await expect(status).toHaveCount(0)
      else await expect(status).toBeVisible()
      await route.fulfill({
        json: {
          path: 'pending.txt',
          content: 'Ready without a minimum loading duration\n',
          hash: 'pending',
        },
      })
      pending.release()
      await page.clock.runFor(16)
      await expect(page.getByRole('textbox', { name: 'pending.txt', exact: true })).toContainText(
        'Ready without a minimum loading duration',
      )
      await expect(status).toHaveCount(0)
    } finally {
      pending.release()
    }
  })
}

test('obsolete file loads cannot resurrect an indicator after rapid switching', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'pending.txt'), 'Old response\n')
  writeFileSync(join(app.repo, 'ready.txt'), 'Latest response\n')
  await page.goto(app.url)
  const pending = await hold(page, '**/api/v1/worktree/file?*path=pending.txt*')
  try {
    await openFile(page, 'pending.txt')
    const route = await pending.request
    await openFile(page, 'ready.txt')
    const editor = page.getByRole('textbox', { name: 'ready.txt', exact: true })
    await expect(editor).toContainText('Latest response')
    await route
      .fulfill({ json: { path: 'pending.txt', content: 'Old response\n', hash: 'old' } })
      .catch(() => {})
    pending.release()
    await pause(page)
    await page.clock.runFor(1000)
    await expect(editor).toContainText('Latest response')
    await expect(
      page.getByRole('status').filter({ hasText: /Opening file|Preparing file/ }),
    ).toHaveCount(0)
  } finally {
    pending.release()
  }
})

test('file load failures immediately replace visible loading', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'pending.txt'), 'Never returned\n')
  await page.goto(app.url)
  const pending = await hold(page, '**/api/v1/worktree/file?*path=pending.txt*')
  try {
    await openFile(page, 'pending.txt', true)
    const route = await pending.request
    await page.clock.runFor(220)
    await expect(page.getByRole('status').filter({ hasText: 'Opening file' })).toBeVisible()
    await route.fulfill({ status: 500, json: { error: 'Controlled file failure' } })
    pending.release()
    await page.clock.runFor(16)
    await expect(page.getByRole('heading', { name: 'Couldn’t open file' })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'Opening file' })).toHaveCount(0)
  } finally {
    pending.release()
  }
})

test('PDF navigation delays its visible indicator and cancels when closed', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'pending.pdf'), pdfFixture())
  await page.goto(app.url)
  const pending = await hold(page, '**/api/v1/pdf-preview?*', 'POST')
  try {
    await openFile(page, 'pending.pdf', true)
    const route = await pending.request
    const status = page.getByRole('status').filter({ hasText: /^(Loading PDF|Opening file)…$/ })
    await page.clock.runFor(150)
    await expect(status).toHaveCount(0)
    await page.clock.runFor(70)
    await expect(status).toBeVisible()
    await page.getByRole('button', { name: 'Close pending.pdf', exact: true }).click()
    await route
      .fulfill({ status: 500, json: { error: 'Obsolete preview failure' } })
      .catch(() => {})
    pending.release()
    await page.clock.runFor(1000)
    await expect(status).toHaveCount(0)
    await expect(page.getByText('Obsolete preview failure', { exact: false })).toHaveCount(0)
  } finally {
    pending.release()
  }
})

test('startup loader waits 200 ms while module delivery is pending and errors bypass the delay', async ({
  page,
  app,
}) => {
  const pending = await hold(page, '**/assets/GitnaReviewUI-*.js')
  try {
    await page.goto(app.url, { waitUntil: 'commit' })
    const route = await pending.request
    const content = page.locator('[data-startup-loading] .startup-content')
    await content.evaluate((element) => {
      const animation = element.getAnimations()[0]!
      animation.pause()
      animation.currentTime = 199
    })
    await expect(content).toBeHidden()
    await content.evaluate((element) => {
      element.getAnimations()[0]!.currentTime = 201
    })
    await expect(content).toBeVisible()
    await content.evaluate((element) => {
      element.getAnimations()[0]!.currentTime = 0
    })
    await route.abort()
    pending.release()
    await expect(page.getByText('Could not load Gitna. Reload to try again.')).toBeVisible()
  } finally {
    pending.release()
  }
})

for (const mode of ['files', 'commits'] as const) {
  test(`${mode} palette resets the indicator deadline for overlapping queries`, async ({
    page,
    app,
  }) => {
    await page.goto(app.url)
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const dialog = page.getByRole('dialog', { name: 'Command palette' })
    const input = dialog.getByRole('combobox', { name: 'Search files and commands' })
    await expect(dialog.getByRole('option').first()).toBeVisible()
    const endpoint = mode === 'files' ? 'files/search' : 'commits/search'
    const first = await hold(page, `**/api/v1/${endpoint}?*q=PendingOne*`)
    const second = await hold(page, `**/api/v1/${endpoint}?*q=PendingTwo*`)
    const prefix = mode === 'commits' ? '#' : ''
    const spinner = dialog.locator('span[role="status"]')
    try {
      await pause(page)
      await input.fill(`${prefix}PendingOne`)
      await page.clock.runFor(199)
      const firstRoute = await first.request
      await expect(spinner).toHaveCount(0)
      await page.clock.runFor(2)
      await expect(spinner).toBeVisible()
      const height = (await dialog.boundingBox())!.height
      await input.fill(`${prefix}PendingTwo`)
      await expect(spinner).toHaveCount(0)
      await page.clock.runFor(199)
      const secondRoute = await second.request
      await expect(spinner).toHaveCount(0)
      await page.clock.runFor(2)
      await expect(spinner).toBeVisible()
      expect((await dialog.boundingBox())!.height).toBe(height)
      await firstRoute
        .fulfill({ status: 500, json: { error: 'Obsolete search error' } })
        .catch(() => {})
      first.release()
      await secondRoute.continue()
      second.release()
      await page.clock.runFor(16)
      await expect(dialog.getByRole('listbox')).toHaveAttribute('aria-busy', 'false')
      await expect(spinner).toHaveCount(0)
      await expect(dialog.getByText('Obsolete search error')).toHaveCount(0)
      await input.press('Escape')
      await page.clock.runFor(1000)
      await expect(dialog).not.toBeVisible()
    } finally {
      first.release()
      second.release()
    }
  })
}

test('workspace search delays its label but renders results immediately after cancellation', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'search.txt'), 'CurrentNeedle\n')
  await page.goto(app.url)
  await expect(page.getByRole('button', { name: 'Open command palette' })).toBeEnabled()
  await page.keyboard.press('Control+Shift+f')
  const panel = page.getByRole('region', { name: 'Find in Files' })
  const input = panel.getByRole('textbox', { name: 'Search files', exact: true })
  await expect(input).toBeVisible()
  const pending = await hold(page, '**/api/v1/search/content?*q=ObsoleteNeedle*')
  const current = await hold(page, '**/api/v1/search/content?*q=CurrentNeedle*')
  try {
    await pause(page)
    await input.fill('ObsoleteNeedle')
    await page.clock.runFor(199)
    await expect.poll(pending.isRequested).toBe(true)
    const route = await pending.request
    await expect(panel.getByText('Searching…', { exact: true })).toHaveCount(0)
    await page.clock.runFor(2)
    await expect(panel.getByText('Searching…', { exact: true })).toBeVisible()
    await input.fill('CurrentNeedle')
    await expect(panel.getByText('Searching…', { exact: true })).toHaveCount(0)
    await page.clock.runFor(100)
    await (
      await current.request
    ).fulfill({
      json: {
        generation: 1,
        complete: true,
        truncated: false,
        results: [
          {
            path: 'search.txt',
            matches: [
              {
                line: 1,
                column: 1,
                length: 13,
                excerpt: 'CurrentNeedle',
                matchStart: 0,
                matchEnd: 13,
              },
            ],
          },
        ],
      },
    })
    current.release()
    await page.clock.runFor(16)
    await expect(panel.getByText('1 result in 1 file', { exact: true })).toBeVisible()
    await route.fulfill({ status: 500, json: { error: 'Obsolete search error' } }).catch(() => {})
    pending.release()
    await page.clock.runFor(1000)
    await expect(panel.getByText('Searching…', { exact: true })).toHaveCount(0)
    await expect(panel.getByText('Obsolete search error')).toHaveCount(0)
  } finally {
    pending.release()
    current.release()
  }
})

test('Graph refresh delays animation without delaying the refresh itself', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const button = page.getByRole('button', { name: /^Refresh(?:ing)? Graph$/ })
  await expect(button).toBeEnabled()
  const pending = await hold(page, '**/api/v1/graph?*')
  try {
    await pause(page)
    await button.click()
    const route = await pending.request
    await page.clock.runFor(199)
    await expect(button.locator('.animate-spin')).toHaveCount(0)
    await page.clock.runFor(2)
    await expect(button.locator('.animate-spin')).toHaveCount(1)
    await route.continue()
    pending.release()
    await page.clock.runFor(16)
    await expect(button).toBeEnabled()
    await expect(button.locator('.animate-spin')).toHaveCount(0)
  } finally {
    pending.release()
  }
})

test('Markdown preview keeps rendered content mounted during pending revisions', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'article.md'), '# Stable preview\n\nOriginal paragraph.\n')
  await page.goto(app.url)
  await openFile(page, 'article.md')
  await page.getByRole('button', { name: 'Open Markdown preview to the side' }).click()
  const heading = page.getByRole('article', { name: 'Rendered Markdown' }).getByRole('heading')
  await expect(heading).toHaveText('Stable preview')
  const original = await heading.elementHandle()
  const editor = page.getByRole('textbox', { name: 'article.md', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('Updated paragraph.')
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await expect(page.getByRole('article', { name: 'Rendered Markdown' })).toContainText(
    'Updated paragraph.',
  )
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await expect(page.getByText('Rendering Markdown…', { exact: true })).toHaveCount(0)
})

test('SVG preview keeps its image mounted during pending revisions', async ({ page, app }) => {
  writeFileSync(
    join(app.repo, 'picture.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>',
  )
  await page.goto(app.url)
  await openFile(page, 'picture.svg')
  await page.getByRole('button', { name: 'Open SVG preview to the side' }).click()
  const image = page.getByRole('img', { name: 'SVG preview' })
  await expect(image).toHaveJSProperty('naturalWidth', 200)
  const original = await image.elementHandle()
  const editor = page.getByRole('textbox', { name: 'picture.svg', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText(' ')
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await expect(image).toHaveAttribute('src', /utf-8,%20/)
  expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
  await expect(page.getByText('Updating SVG preview…', { exact: true })).toHaveCount(0)
})
