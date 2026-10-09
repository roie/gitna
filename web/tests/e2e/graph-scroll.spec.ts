import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

test('expanded commit trees keep their height and folders across virtual remounts', async ({
  page,
  app,
}) => {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: app.repo, encoding: 'utf8' }).trim()
  for (let index = 0; index < 65; index += 1)
    git('commit', '--allow-empty', '-qm', `older ${index}`)
  mkdirSync(join(app.repo, 'nested'))
  for (let index = 0; index < 20; index += 1) {
    if (index < 8) writeFileSync(join(app.repo, `scroll-${index}.txt`), 'scroll fixture\n')
    writeFileSync(join(app.repo, 'nested', `child-${index}.txt`), 'nested fixture\n')
  }
  const rootPaths = Array.from({ length: 8 }, (_, index) => `scroll-${index}.txt`)
  git('add', '--', 'nested', ...rootPaths)
  git('commit', '-qm', 'expanded scroll fixture', '--', 'nested', ...rootPaths)
  const oid = git('rev-parse', 'HEAD')
  for (let index = 0; index < 6; index += 1) git('commit', '--allow-empty', '-qm', `newer ${index}`)

  await page.goto(app.url)
  await page.locator('[data-section="graph"]').click()
  const row = page.locator(`[data-graph-oid="${oid}"]`)
  await row.locator('[data-graph-disclosure]').click()
  const folder = row.getByRole('treeitem', { name: 'nested', exact: true })
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  const height = await row.evaluate((element) => element.getBoundingClientRect().height)
  expect(height).toBeGreaterThan(100)

  // Focus pins only the head commit, allowing the expanded fixture to unmount.
  await page.locator('[data-graph-index="0"] [data-graph-disclosure]').focus()
  await page.mouse.move(900, 600)
  const graph = page.locator('[data-pane-body="graph"]')
  await graph.evaluate((element) => { element.scrollTop = 160 })
  await folder.hover()
  await page.mouse.wheel(0, 120)
  await expect.poll(() => graph.evaluate((element) => element.scrollTop)).toBeGreaterThan(160)

  await graph.evaluate((element) => { element.scrollTop = 160 })
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await graph.evaluate((element) => { element.scrollTop = 160 })
  const treeScroller = row.locator('[data-file-tree-virtualized-scroll]')
  await folder.hover()
  await page.mouse.wheel(0, 80)
  await expect.poll(() => treeScroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(await graph.evaluate((element) => element.scrollTop)).toBe(160)

  await treeScroller.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await page.mouse.wheel(0, 80)
  await expect.poll(() => graph.evaluate((element) => element.scrollTop)).toBeGreaterThan(160)

  await graph.evaluate((element) => { element.scrollTop = 160 })
  await treeScroller.evaluate((element) => { element.scrollTop = 0 })
  await folder.hover()
  await page.mouse.wheel(0, -80)
  await expect.poll(() => graph.evaluate((element) => element.scrollTop)).toBeLessThan(160)

  await graph.evaluate((element) => { element.scrollTop = 160 })
  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await graph.evaluate((element) => {
      element.scrollTop = 1300
    })
    await expect(row).toHaveCount(0)
    await graph.evaluate((element) => {
      element.scrollTop = 300
    })
    await expect(row).toBeAttached()
    await expect(folder).toHaveAttribute('aria-expanded', 'false')
    await expect
      .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
      .toBeCloseTo(height, 0)
    await expect.poll(() => graph.evaluate((element) => element.scrollTop)).toBeCloseTo(300, 0)
  }
  await page.getByRole('button', { name: 'Graph actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Show as List', exact: true }).click()
  await expect(folder).toHaveCount(0)
  await expect(
    row.getByRole('treeitem', { name: 'nested › child-0.txt', exact: true }),
  ).toBeAttached()
  await page.getByRole('button', { name: 'Graph actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Show as Tree', exact: true }).click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await expect
    .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(height, 0)

  await row.locator('[data-graph-disclosure]').click()
  await expect(row.locator('[data-graph-files]')).toHaveCount(0)
  await row.locator('[data-graph-disclosure]').click()
  await expect(folder).toHaveAttribute('aria-expanded', 'false')
  await expect
    .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(height, 0)

  await folder.click()
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  const expandedHeight = await row.evaluate((element) => element.getBoundingClientRect().height)
  expect(expandedHeight).toBeGreaterThan(height)
  await page.locator('[data-graph-index="0"] [data-graph-disclosure]').focus()
  await page.mouse.move(900, 600)
  await graph.evaluate((element) => {
    element.scrollTop = 1300
  })
  await expect(row).toHaveCount(0)
  await graph.evaluate((element) => {
    element.scrollTop = 300
  })
  await expect(folder).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(() => row.evaluate((element) => element.getBoundingClientRect().height))
    .toBeCloseTo(expandedHeight, 0)
  await expect.poll(() => graph.evaluate((element) => element.scrollTop)).toBeCloseTo(300, 0)
})
