import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from './fixtures.js'

const componentPath = 'src/component/home/deliveredcta.astro'
const imagePath = 'src/assets/footer/sunburst.png'

function prepareMixedChanges(repo: string) {
  const components = [componentPath, 'src/component/home/footer.astro']
  for (const path of components) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), '<section>Before</section>\n')
  }
  for (const args of [
    ['add', '-A'],
    ['commit', '-qm', 'Prepare navigation fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  }
  for (const path of components) {
    writeFileSync(
      join(repo, path),
      Array.from({ length: 80 }, (_, index) => `<section>After ${index}</section>\n`).join(''),
    )
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  for (const path of [imagePath, 'src/assets/homepage/cta/deliver.png']) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), png)
  }
}

test('mixed tracked and untracked changes follow review order in the tree', async ({
  page,
  app,
}) => {
  prepareMixedChanges(app.repo)
  await page.goto(app.url)
  const tree = page.locator('#gitna-unstaged-tree__tree')
  const imageRow = tree.getByRole('treeitem', { name: 'sunburst.png', exact: true })
  const componentRow = tree.getByRole('treeitem', { name: 'deliveredcta.astro', exact: true })
  await expect(imageRow).toBeVisible()
  await expect(componentRow).toBeVisible()
  await expect
    .poll(async () => (await imageRow.boundingBox())!.y < (await componentRow.boundingBox())!.y)
    .toBe(true)

  await imageRow.click()
  await expect(page.getByRole('img', { name: `Image preview for ${imagePath}` })).toBeVisible()
  const scroller = page.locator('.cv-scrollbar')
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(24)

  await componentRow.click()
  const header = page.getByRole('button', { name: `Stage file ${componentPath}`, exact: true })
  await expect(header).toBeVisible()
  await expect
    .poll(async () => Math.abs((await header.boundingBox())!.y - (await scroller.boundingBox())!.y))
    .toBeLessThan(48)
})

test('wheel scrolling over an image continues through the review', async ({ page, app }) => {
  prepareMixedChanges(app.repo)
  await page.goto(app.url)
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'sunburst.png', exact: true })
    .click()
  const image = page.getByRole('img', { name: `Image preview for ${imagePath}` })
  await expect(image).toBeVisible()
  const scroller = page.locator('.cv-scrollbar')
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(24)
  await image.hover()
  const before = await scroller.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 350)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before + 100)
})
