import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function images(repo: string) {
  writeFileSync(join(repo, 'preview.png'), png)
  execFileSync('git', ['add', 'preview.png'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'add preview image'], { cwd: repo })
  writeFileSync(join(repo, 'preview.png'), Buffer.concat([png, Buffer.from('changed')]))
  writeFileSync(join(repo, 'untracked-preview.png'), png)
}

function file(page: Page, path: string) {
  return page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: path, exact: true })
}

async function renderedImage(page: Page, path: string) {
  const image = page.getByRole('img', { name: `Image preview for ${path}`, exact: true })
  await expect(image).toBeInViewport()
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(1)
}

test('initial raster selection reveals the measured image body rather than header-only estimates', async ({
  page,
  app,
}) => {
  images(app.repo)
  await page.addInitScript(() => {
    let instance: unknown
    const reveals: { id: string; afterInitialFrame: boolean }[] = []
    Object.assign(window, { rasterReveals: reveals })
    Object.defineProperty(window, '__INSTANCE', {
      configurable: true,
      get: () => instance,
      set: (viewer: { scrollTo(target: { type: string; id?: string }): void }) => {
        instance = viewer
        let afterInitialFrame = false
        requestAnimationFrame(() => {
          afterInitialFrame = true
        })
        const scrollTo = viewer.scrollTo.bind(viewer)
        viewer.scrollTo = (target) => {
          if (target.type === 'item' && target.id != null)
            reveals.push({
              id: target.id,
              afterInitialFrame,
            })
          scrollTo(target)
        }
      },
    })
  })
  let release!: () => void
  let requested!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = new Promise<void>((resolve) => {
    requested = resolve
  })
  await page.route('**/api/v1/review?*', async (route) => {
    requested()
    await gate
    await route.continue()
  })
  try {
    await page.goto(app.url)
    await pending
    await expect(file(page, 'untracked-preview.png')).toBeVisible()
    await file(page, 'untracked-preview.png').click()
    await expect(file(page, 'untracked-preview.png')).toHaveAttribute('aria-selected', 'true')
    const reviewed = page.waitForResponse(
      (response) => new URL(response.url()).pathname.endsWith('/review') && response.ok(),
    )
    release()
    await reviewed
    await expect(page.locator('.code-view')).toBeAttached()
    await renderedImage(page, 'untracked-preview.png')
    const reveal = await page.evaluate(() =>
      (
        window as unknown as { rasterReveals: { id: string; afterInitialFrame: boolean }[] }
      ).rasterReveals.find((entry) => entry.id === 'untracked-preview.png'),
    )
    expect(reveal).toBeDefined()
    expect(reveal!.afterInitialFrame).toBe(true)
  } finally {
    release()
  }
})

test('rapid raster navigation ignores obsolete image responses and queued reveals', async ({
  page,
  app,
}) => {
  images(app.repo)
  await page.goto(app.url)
  await file(page, 'preview.png').click()
  await renderedImage(page, 'preview.png')
  let received!: (route: Route) => void
  let release!: () => void
  const pending = new Promise<Route>((resolve) => {
    received = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/diff?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('path') !== 'untracked-preview.png')
      return route.continue()
    received(route)
    await gate
    await route.continue()
  })
  try {
    await file(page, 'untracked-preview.png').click()
    const stale = await pending
    await file(page, 'preview.png').click()
    await renderedImage(page, 'preview.png')
    const completed = page.waitForResponse((response) => response.url() === stale.request().url())
    release()
    await completed
    await expect(file(page, 'preview.png')).toHaveAttribute('aria-selected', 'true')
    await renderedImage(page, 'preview.png')
    const time = new Date()
    await page.clock.install({ time })
    await page.clock.pauseAt(new Date(time.getTime() + 1000))
    await file(page, 'untracked-preview.png').dispatchEvent('click')
    await file(page, 'preview.png').dispatchEvent('click')
    await page.clock.runFor(100)
    await expect(file(page, 'preview.png')).toHaveAttribute('aria-selected', 'true')
    await renderedImage(page, 'preview.png')
    await expect(page.getByRole('heading', { name: 'Fetching diff', exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})
