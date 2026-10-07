import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

function addScrollFiles(repo: string): void {
  for (let index = 0; index < 70; index++) {
    const path = `scroll-${String(index).padStart(3, '0')}.txt`
    writeFileSync(
      join(repo, path),
      Array.from({ length: 30 }, (_, line) => `${path} reading line ${line + 1}`).join('\n') + '\n',
    )
  }
}

async function settleLayout(page: Page, frames = 40): Promise<void> {
  await page.evaluate(async (count) => {
    for (let frame = 0; frame < count; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, frames)
}

async function refreshUnrelatedFile(
  page: Page,
  repo: string,
  marker = 'unrelated refresh marker',
): Promise<void> {
  const refreshed = page.waitForResponse(
    (response) => response.url().includes('/api/v1/review?') && response.status() === 200,
  )
  writeFileSync(join(repo, 'modified.txt'), `${marker}\n`)
  await refreshed
  await settleLayout(page)
}

async function visibleLine(viewer: Locator): Promise<{ text: string; top: number }> {
  const bounds = await viewer.boundingBox()
  expect(bounds).not.toBeNull()
  const line = await viewer.locator('[data-line]').evaluateAll((lines, viewport) => {
    for (const element of lines) {
      const rect = element.getBoundingClientRect()
      if (
        rect.top >= viewport!.y + 40 &&
        rect.bottom < viewport!.y + viewport!.height &&
        element.textContent?.includes('reading line')
      ) {
        return { text: element.textContent, top: rect.top }
      }
    }
    return null
  }, bounds)
  expect(line, 'a reading line must be visible before the refresh').not.toBeNull()
  return line!
}

test('file selection jumps directly to the selected diff without animated scrolling', async ({
  page,
  app,
}) => {
  addScrollFiles(app.repo)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(app.url)
  const tree = page.locator('#gitna-unstaged-tree__tree')
  await tree.getByRole('treeitem', { name: 'binary.dat', exact: true }).click()
  const viewer = page.locator('.code-view')
  await expect(viewer).toBeVisible()
  await settleLayout(page)

  const path = 'scroll-002.txt'
  const row = tree.getByRole('treeitem', { name: path, exact: true })
  await expect(row).toBeVisible()
  const positions = await row.evaluate(async (element) => {
    const scroller = document.querySelector('.code-view')!
    const positions = [scroller.scrollTop]
    ;(element as HTMLElement).click()
    for (let frame = 0; frame < 40; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      positions.push(scroller.scrollTop)
    }
    return positions
  })
  await expect(row).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByRole('button', { name: `Stage file ${path}`, exact: true }),
  ).toBeInViewport()
  const start = positions[0]!
  const end = positions.at(-1)!
  expect(end - start).toBeGreaterThan(720)
  expect(
    positions.filter((position) => position > start + 2 && position < end - 2),
    'navigation must not render intermediate scroll positions',
  ).toEqual([])
})

for (const surface of ['Changes list', 'diff view'] as const) {
  test(`${surface} preserves the reading position during a background refresh`, async ({
    page,
    app,
  }) => {
    addScrollFiles(app.repo)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(app.url)
    const tree = page.locator('#gitna-unstaged-tree__tree')
    await expect(tree.getByRole('treeitem', { name: 'binary.dat', exact: true })).toBeVisible()
    await tree.getByRole('treeitem', { name: 'binary.dat', exact: true }).click()
    await expect(page.locator('.code-view')).toBeVisible()
    await settleLayout(page)
    const scroller =
      surface === 'Changes list'
        ? tree.locator('[data-file-tree-virtualized-scroll="true"]')
        : page.locator('.code-view')
    await scroller.evaluate((element) => {
      element.scrollTop = 600
    })
    await settleLayout(page)
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(600)
    const anchor = surface === 'diff view' ? await visibleLine(scroller) : null

    await refreshUnrelatedFile(page, app.repo)

    if (anchor == null) {
      expect(await scroller.evaluate((element) => element.scrollTop)).toBe(600)
    } else {
      const tops = await scroller
        .locator('[data-line]')
        .evaluateAll(
          (lines, text) =>
            lines
              .filter((line) => line.textContent === text)
              .map((line) => line.getBoundingClientRect().top),
          anchor.text,
        )
      expect(tops.length, 'the same reading line remains rendered').toBeGreaterThan(0)
      expect(Math.min(...tops.map((top) => Math.abs(top - anchor.top)))).toBeLessThanOrEqual(2)
    }

    const bounds = await scroller.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    const refresh = refreshUnrelatedFile(page, app.repo, 'refresh while scrolling')
    let previousTop = await scroller.evaluate((element) => element.scrollTop)
    for (let step = 0; step < 30; step++) {
      await page.mouse.wheel(0, 24)
      await settleLayout(page, 6)
      const top = await scroller.evaluate((element) => element.scrollTop)
      expect(top).toBeGreaterThanOrEqual(previousTop - 2)
      previousTop = top
    }
    await refresh
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(
      previousTop - 2,
    )

    const treeScroller = tree.locator('[data-file-tree-virtualized-scroll="true"]')
    await treeScroller.evaluate((element) => {
      element.scrollTop = 600
    })
    await settleLayout(page)
    const treeBounds = await treeScroller.boundingBox()
    const path = await tree.getByRole('treeitem').evaluateAll((items, bounds) => {
      const row = items.find((item) => {
        const rect = item.getBoundingClientRect()
        return (
          item.getAttribute('data-item-path')?.startsWith('scroll-') &&
          rect.top > bounds!.y + 20 &&
          rect.bottom < bounds!.y + bounds!.height - 20
        )
      })
      return row?.getAttribute('data-item-path')
    }, treeBounds)
    expect(path).toBeTruthy()
    const row = tree.getByRole('treeitem', { name: path!, exact: true })
    await row.click()
    await expect(row).toHaveAttribute('aria-selected', 'true')
    await expect(
      page.getByRole('button', { name: `Stage file ${path}`, exact: true }),
    ).toBeInViewport()
  })
}
