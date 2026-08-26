import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { APIRequestContext, Locator } from '@playwright/test'
import { test, expect } from './fixtures.js'

interface ReviewResponse {
  generation: number
  identity: { scope: string; commit?: string; from?: string; to?: string }
  patch: string
  supplements: Array<{ path: string; kind: string; diff: { binary: boolean; tooLarge: boolean } }>
}

async function readReview(request: APIRequestContext, url: string): Promise<ReviewResponse> {
  const response = await request.get(url)
  expect(response.status()).toBe(200)
  return (await response.json()) as ReviewResponse
}

async function visibleTreeEndGap(tree: Locator): Promise<number> {
  return tree.evaluate((element) => {
    const rows = element.querySelectorAll<HTMLElement>('[role="treeitem"]')
    const last = rows.item(rows.length - 1)
    if (last == null) return Number.POSITIVE_INFINITY
    return Math.round(element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom)
  })
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

test('real binary renders repository source-control state', async ({ page, app }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(app.url).origin,
  })
  const response = await page.goto(app.url)
  expect(response?.status()).toBe(200)
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  const repository = page.locator('[data-section="repository"]')
  const graph = page.locator('[data-section="graph"]')
  const workflow = page.locator('[data-section="workflow"]')
  const changes = page.locator('[data-section="changes"]')
  const staged = page.locator('[data-section="staged"]')
  await expect(repository).toBeVisible()
  await expect(repository).toContainText('repo')
  await expect(repository).toHaveAttribute('aria-expanded', 'false')
  await expect(graph).toHaveAttribute('aria-expanded', 'false')
  await repository.click()
  await graph.click()
  await expect(workflow).toBeVisible()
  await expect(workflow.locator('.section-title')).toHaveText('main')
  await expect(changes).toBeVisible()
  await expect(staged).toBeVisible()
  await expect(changes).toHaveAttribute('aria-expanded', 'true')
  await expect(staged).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('switch', { name: 'Amend' })).toBeEnabled()
  await expect(workflow.locator('.section-count')).toHaveAttribute('title', /changed files?/)
  const switchBranch = page.getByRole('button', { name: 'Switch branch · main' })
  await switchBranch.click()
  await expect(page.getByRole('menuitem', { name: /main.*origin\/main/ })).toBeVisible()
  await expect(page.getByText('Select a remote branch to check it out locally.')).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Checkout origin/feature as feature' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.section-title', { hasText: /^Graph$/ })).toBeVisible()
  await expect(
    page.locator('#gitna-unstaged-tree__tree').getByRole('treeitem', {
      name: 'modified.txt',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page
      .locator('#gitna-unstaged-tree__tree')
      .getByRole('treeitem', { name: 'untracked.txt', exact: true })
      .getByTitle('Git status: untracked'),
  ).toBeVisible()
  await expect(
    page.locator('#gitna-staged-tree__tree').getByRole('treeitem', {
      name: 'staged.txt',
      exact: true,
    }),
  ).toBeVisible()
  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const changesTree = page.locator('#gitna-unstaged-tree__tree')
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'feature.txt', exact: true }),
  ).toBeVisible()
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'main.txt', exact: true }),
  ).toBeVisible()
  await repositoryTree.getByRole('treeitem', { name: 'feature.txt', exact: true }).click()
  await expect(page.locator('diffs-container').filter({ hasText: 'feature.txt' })).toBeVisible()
  await expect(page.getByText('feature branch', { exact: true })).toBeVisible()
  const repositoryTabs = page.getByRole('tablist', { name: 'Open repository files' })
  const featureTab = repositoryTabs.getByRole('tab', { name: 'feature.txt' })
  await expect(featureTab).toHaveAttribute('aria-selected', 'true')
  await expect(featureTab.locator('svg use')).toHaveAttribute('href', /^#file-tree-/)
  const featureIconHref = await featureTab.locator('svg use').getAttribute('href')
  expect(featureIconHref).toBe(
    await repositoryTree
      .getByRole('treeitem', { name: 'feature.txt', exact: true })
      .locator('svg use')
      .getAttribute('href'),
  )
  await expect.poll(() => page.locator(`symbol${featureIconHref}`).count()).toBeGreaterThan(0)
  await repositoryTree.getByRole('treeitem', { name: 'main.txt', exact: true }).click()
  await expect(repositoryTabs.getByRole('tab')).toHaveCount(2)
  await expect(repositoryTabs.getByRole('tab', { name: 'main.txt' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await repositoryTabs.getByRole('tab', { name: 'feature.txt' }).click()
  await expect(page.getByText('feature branch', { exact: true })).toBeVisible()
  await repositoryTabs.getByRole('button', { name: 'Close feature.txt' }).click()
  await expect(repositoryTabs.getByRole('tab', { name: 'feature.txt' })).toHaveCount(0)
  await expect(repositoryTabs.getByRole('tab', { name: 'main.txt' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByText('main branch', { exact: true })).toBeVisible()
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'delete.txt', exact: true }),
  ).toHaveCount(0)
  const repositoryFiles = await page.evaluate(async () => {
    const response = await fetch('api/v1/files')
    if (!response.ok) throw new Error(`files request failed: ${response.status}`)
    return (await response.json()) as { paths: string[]; truncated: boolean }
  })
  expect(repositoryFiles.paths).toContain('feature.txt')
  expect(repositoryFiles.paths.some((path) => path === '.git' || path.startsWith('.git/'))).toBe(
    false,
  )
  expect(repositoryFiles.truncated).toBe(false)
  await expect.poll(() => visibleTreeEndGap(repositoryTree)).toBeLessThanOrEqual(1)
  await expect.poll(() => visibleTreeEndGap(changesTree)).toBeLessThanOrEqual(1)

  const headCommit = page.getByRole('button', { name: /^merge feature/ })
  await expect(headCommit).toContainText('main')
  await expect(headCommit).not.toContainText('Gitna E2E')
  await expect(headCommit).not.toContainText(app.headOid.slice(0, 8))
  await expect(headCommit).toHaveCSS('cursor', 'pointer')
  await expect(page.locator('[data-section="graph"]')).toHaveCSS('cursor', 'pointer')
  await headCommit.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('Gitna E2E')
  const copyCommitId = tooltip.getByTitle('Copy full commit ID')
  await expect(copyCommitId).toHaveAccessibleName(`Copy commit ID ${app.headOid.slice(0, 8)}`)
  await expect(copyCommitId).toHaveText(app.headOid.slice(0, 8))
  await copyCommitId.hover()
  await copyCommitId.click()
  await expect(copyCommitId).toHaveText('Copied!')
  await expect(copyCommitId).toHaveAccessibleName(`Copied commit ID ${app.headOid.slice(0, 8)}`)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(app.headOid)
  if (process.env.GITNA_CAPTURE_GRAPH) {
    await page.screenshot({ path: '/tmp/gitna-graph-tooltip.png', fullPage: true })
  }
  await page.keyboard.press('Escape')
  await expect(tooltip).toBeHidden()
  await headCommit.focus()
  await expect(tooltip).toBeVisible()
  await expect(headCommit).toHaveAttribute('aria-describedby', /radix/)
  await page.keyboard.press('Escape')

  const nodeColumns = await page
    .locator('[data-graph-node]')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute('cx'))))
  expect(new Set(nodeColumns).size).toBeGreaterThan(1)
  await expect(page.getByText('base fixture', { exact: true })).toBeVisible()
  const sourcePaneBody = page.locator('[data-pane-body="source-control"]')
  const sourcePaneHeader = page.locator('[data-section="workflow"]')
  await expect(sourcePaneBody).toHaveClass(/cv-mini-scrollbar/)
  await expect(sourcePaneBody).toHaveCSS('overflow-y', 'auto')
  expect(
    await sourcePaneBody.evaluate(
      (body) => !body.contains(document.querySelector('[data-section="workflow"]')),
    ),
  ).toBe(true)
  await expect(sourcePaneHeader).toHaveCSS('font-size', '14px')
  await expect(sourcePaneHeader).toHaveCSS('text-transform', 'none')
  await expect(sourcePaneHeader.locator('svg')).toHaveCount(0)
  await expect(page.locator('[data-section="repository"] svg')).toHaveCount(0)
  await expect(page.locator('[data-section="graph"] svg')).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize sidebar panes' })).toHaveCount(2)
  await page.getByRole('button', { name: /^base fixture/ }).click()
  const graphTree = page.locator('[id^="gitna-graph-"][id$="__tree"]')
  const graphFile = graphTree.getByRole('treeitem', {
    name: 'modified.txt',
    exact: true,
  })
  await expect(graphFile).toBeVisible()
  await graphFile.click()
  await expect(repositoryTabs).toHaveCount(0)
  expect(
    await graphTree.evaluate((tree) => tree.scrollHeight - tree.clientHeight),
  ).toBeLessThanOrEqual(1)
  await expect.poll(() => visibleTreeEndGap(graphTree)).toBeLessThanOrEqual(1)
  const baseCommit = page.getByRole('button', { name: /^base fixture/ })
  const [nodeBox, filesBox] = await Promise.all([
    baseCommit.locator('[data-graph-node]').boundingBox(),
    page.locator('[data-graph-files]').boundingBox(),
  ])
  expect(nodeBox).not.toBeNull()
  expect(filesBox).not.toBeNull()
  expect(Math.abs(nodeBox!.x + nodeBox!.width / 2 - (filesBox!.x + 1))).toBeLessThanOrEqual(1)
  await expect(page.locator('[data-graph-segment]').first()).toHaveAttribute('stroke-width', '2')
  await expect(page.locator('[data-graph-files]')).toHaveCSS('border-left-width', '2px')

  const sourcePane = page.locator('[data-pane="source-control"]')
  const repositoryPane = page.locator('[data-pane="repository"]')
  const resizeHandle = page.getByRole('separator', { name: 'Resize sidebar panes' }).first()
  const [sourceBefore, repositoryBefore] = await Promise.all([
    sourcePane.boundingBox(),
    repositoryPane.boundingBox(),
  ])
  expect(sourceBefore).not.toBeNull()
  expect(repositoryBefore).not.toBeNull()
  await resizeHandle.focus()
  await page.keyboard.press('ArrowDown')
  await expect
    .poll(async () => (await sourcePane.boundingBox())?.height ?? 0)
    .toBeGreaterThan(sourceBefore!.height)
  await expect
    .poll(async () => (await repositoryPane.boundingBox())?.height ?? Number.POSITIVE_INFINITY)
    .toBeLessThan(repositoryBefore!.height)

  const repositoryResizedHeight = (await repositoryPane.boundingBox())!.height
  const sourceHeaderHeight = (await sourcePaneHeader.locator('..').boundingBox())!.height
  await sourcePaneHeader.click()
  await expect
    .poll(async () => (await sourcePane.boundingBox())?.height ?? 0)
    .toBeCloseTo(sourceHeaderHeight, 0)
  await expect(sourcePaneBody).toHaveCount(0)
  await expect
    .poll(async () => (await repositoryPane.boundingBox())?.height ?? 0)
    .toBeGreaterThan(repositoryResizedHeight)
  await sourcePaneHeader.click()
  await expect(sourcePaneBody).toHaveCount(1)

  if (process.env.GITNA_CAPTURE_GRAPH) {
    await graphTree.getByRole('treeitem').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/gitna-graph-refined.png', fullPage: true })
  }
})

test('sync status exposes outgoing review', async ({ page, app }) => {
  runGit(app.repo, 'commit', '-qm', 'outgoing fixture')

  await page.goto(app.url)
  await expect(page.locator('[data-section="workflow"] .section-title')).toHaveText('main')
  const syncStatus = page.getByRole('button', { name: '1 outgoing commit · origin/main' })
  await expect(syncStatus).toHaveText('↑1')
  await syncStatus.hover()
  await expect(page.getByRole('tooltip')).toHaveText('1 outgoing commit · origin/main')

  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Review outgoing (1)' }).click()
  await expect(page.getByText('staged change', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stage file staged.txt' })).toHaveCount(0)
})

test('raster images replace the code body', async ({ page, app }) => {
  const imagePath = join(app.repo, 'preview.png')
  const before = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  writeFileSync(imagePath, before)
  runGit(app.repo, 'add', 'preview.png')
  runGit(app.repo, 'commit', '-qm', 'add preview image')
  writeFileSync(imagePath, Buffer.concat([before, Buffer.from('changed')]))
  writeFileSync(join(app.repo, 'untracked-preview.png'), before)

  await page.goto(app.url)
  await expect(
    page.getByRole('img', { name: 'Image preview for untracked-preview.png' }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.locator('.cv-scrollbar').evaluate((viewer) => viewer.scrollHeight - viewer.clientHeight),
    )
    .toBeGreaterThan(0)
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'preview.png', exact: true })
    .click()

  const previous = page.getByRole('img', { name: 'Previous image for preview.png' })
  const current = page.getByRole('img', { name: 'Image preview for preview.png' })
  await expect(previous).toBeVisible()
  await expect(current).toBeVisible()
  await expect(previous).toHaveCSS('object-fit', 'contain')
  await expect(current).toHaveCSS('object-fit', 'contain')
  const previousFrameLocator = previous.locator('../..')
  const currentFrameLocator = current.locator('../..')
  const previousPane = previous.locator('../../..')
  const currentPane = current.locator('../../..')
  await expect(previousPane).toHaveCSS('border-right-width', '1px')
  await expect(currentPane).toHaveCSS('border-left-width', '1px')
  await expect(previousFrameLocator).toHaveCSS('padding', '24px')
  await expect(currentFrameLocator).toHaveCSS('padding', '24px')
  const [previousBox, currentBox, previousFrame, currentFrame] = await Promise.all([
    previous.boundingBox(),
    current.boundingBox(),
    previousFrameLocator.boundingBox(),
    currentFrameLocator.boundingBox(),
  ])
  expect(previousBox).not.toBeNull()
  expect(currentBox).not.toBeNull()
  expect(previousFrame).not.toBeNull()
  expect(currentFrame).not.toBeNull()
  expect(previousBox!.width).toBeCloseTo(currentBox!.width, 0)
  expect(previousBox!.height).toBeCloseTo(currentBox!.height, 0)
  expect(previousFrame!.width).toBeCloseTo(currentFrame!.width, 0)
  expect(previousFrame!.height).toBeCloseTo(currentFrame!.height, 0)
  expect(previousBox!.x - previousFrame!.x).toBeGreaterThanOrEqual(23)
  expect(previousBox!.y - previousFrame!.y).toBeGreaterThanOrEqual(23)
  expect(
    previousFrame!.x + previousFrame!.width - previousBox!.x - previousBox!.width,
  ).toBeGreaterThanOrEqual(23)
  expect(
    previousFrame!.y + previousFrame!.height - previousBox!.y - previousBox!.height,
  ).toBeGreaterThanOrEqual(23)
  expect(previousFrame!.height).toBeGreaterThan((page.viewportSize()?.height ?? 0) * 0.8)
  await expect(page.getByText(/^(Before|After)$/)).toHaveCount(0)

  await page
    .getByRole('button', { name: 'Open Image preview for preview.png in image viewer' })
    .click()
  const imageViewer = page.getByRole('dialog', {
    name: 'Image viewer: Image preview for preview.png',
  })
  await expect(imageViewer).toBeVisible()
  await expect(imageViewer).toHaveText('')
  const lightboxImage = imageViewer.getByRole('img', {
    name: 'Image preview for preview.png',
  })
  await expect(lightboxImage).toBeVisible()
  await expect(lightboxImage).not.toHaveClass(/shadow/)
  await expect(imageViewer).toHaveClass(/bg-black\/85/)
  await page.keyboard.press('Escape')
  await expect(imageViewer).not.toBeVisible()

  const imageHeader = page
    .getByRole('button', { name: 'Stage file preview.png' })
    .locator('xpath=ancestor::diffs-container')
  await imageHeader.getByRole('button', { name: 'Collapse diff' }).click()
  await expect(previous).not.toBeVisible()
  await expect(current).not.toBeVisible()
  await imageHeader.getByRole('button', { name: 'Expand diff' }).click()
  await expect(current).toBeVisible()

  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'preview.png', exact: true })
    .click()
  await expect(current).toBeVisible()
  const imageContainer = current.locator('xpath=ancestor::diffs-container')
  await expect(imageContainer.locator('[data-line-number-content]')).toHaveCount(0)
  await expect(imageContainer.locator('pre:visible')).toHaveCount(0)
  const [imageBackground, textBackground] = await Promise.all([
    imageContainer.evaluate(
      (host) =>
        getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('[data-custom-body]')!)
          .backgroundColor,
    ),
    page
      .getByRole('button', { name: 'Stage file modified.txt' })
      .locator('xpath=ancestor::diffs-container')
      .evaluate(
        (host) =>
          getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('pre')!).backgroundColor,
      ),
  ])
  expect(imageBackground).toBe(textBackground)

  await page.locator('[data-section="graph"]').click()
  await page.getByRole('button', { name: /^add preview image/ }).click()
  await page
    .locator('[id^="gitna-graph-"][id$="__tree"]')
    .getByRole('treeitem', { name: 'preview.png', exact: true })
    .click()
  await expect(current).toBeVisible()

  await page.reload()
  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'preview.png', exact: true })
    .click()
  await expect(current).toBeVisible()
  await expect(
    current.locator('xpath=ancestor::diffs-container').locator('pre:visible'),
  ).toHaveCount(0)
})

test('repository path switches the live session and remains fully editable', async ({
  page,
  app,
}) => {
  const nextRepo = join(dirname(app.repo), 'next-repository-with-a-long-location-name')
  mkdirSync(nextRepo)
  runGit(nextRepo, 'init', '-q', '-b', 'trunk')
  runGit(nextRepo, 'config', 'user.email', 'e2e@example.com')
  runGit(nextRepo, 'config', 'user.name', 'Gitna E2E')
  writeFileSync(join(nextRepo, 'next.txt'), 'next repository\n')
  runGit(nextRepo, 'add', '--', 'next.txt')
  runGit(nextRepo, 'commit', '-qm', 'next repository')

  await page.goto(app.url)
  const pathInput = page.getByRole('textbox', { name: 'Repository path' })
  await expect(pathInput).toHaveValue(app.repo)
  await pathInput.fill(nextRepo)
  const switchRepository = page.getByRole('button', { name: 'Switch repository' })
  await expect(switchRepository).toBeVisible()
  await switchRepository.click()

  await expect(pathInput).toHaveValue(nextRepo)
  await expect(switchRepository).not.toBeVisible()
  await expect(page.locator('[data-section="workflow"]')).toContainText('trunk')
  await expect(page.locator('[data-section="workflow"] .section-count')).toHaveCount(0)
  await expect(page.getByRole('switch', { name: 'Amend' })).toBeDisabled()
  await expect(
    page.getByRole('region', { name: 'Source Control workflow' }).getByText('Working tree clean'),
  ).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('Working tree clean')
  await expect(page.locator('[data-section="repository"]')).toContainText(
    'next-repository-with-a-long-location-name',
  )
  const clearPath = page.getByRole('button', { name: 'Clear repository path' })
  await page.mouse.move(0, 0)
  await expect(clearPath).toHaveCSS('opacity', '0')
  await pathInput.hover()
  await expect(clearPath).toHaveCSS('opacity', '0.5')
  const inputBox = await pathInput.boundingBox()
  const clearBox = await clearPath.boundingBox()
  expect(inputBox).not.toBeNull()
  expect(clearBox).not.toBeNull()
  expect(clearBox!.x - (inputBox!.x + inputBox!.width)).toBe(4)
  await expect(
    page.getByRole('button', { name: 'Reveal repository in file manager' }),
  ).toBeVisible()
})

test('branch picker, repository filters, list view, and graph stats use direct pane controls', async ({
  page,
  app,
}) => {
  const nested = join(app.repo, 'nested')
  mkdirSync(nested)
  writeFileSync(join(nested, 'clean.txt'), 'nested file\n')

  await page.goto(app.url)
  await page.locator('[data-section="repository"]').click()
  await page.locator('[data-section="graph"]').click()
  await expect(page.getByRole('button', { name: 'Search Repository' })).toHaveAttribute(
    'title',
    'Search Repository',
  )
  await expect(page.locator('[data-section="repository"] .section-count')).toHaveAttribute(
    'title',
    /files in Repository/,
  )
  await expect(page.locator('[data-section="graph"] .section-count')).toHaveAttribute(
    'title',
    /commits in Graph/,
  )
  await expect(
    page
      .locator('#gitna-repository-tree__tree')
      .getByRole('treeitem', { name: 'nested', exact: true })
      .getByTitle('Contains git status items'),
  ).toBeVisible()
  const sourceControlActions = [
    page.getByRole('button', { name: /^Switch branch · main$/ }),
    page.getByRole('button', { name: 'Fetch' }),
    page.getByRole('button', { name: 'More actions' }),
  ]
  const actionBoxes = await Promise.all(sourceControlActions.map((action) => action.boundingBox()))
  for (let index = 1; index < actionBoxes.length; index += 1) {
    const previous = actionBoxes[index - 1]
    const current = actionBoxes[index]
    expect(previous).not.toBeNull()
    expect(current).not.toBeNull()
    expect(current!.x - (previous!.x + previous!.width)).toBe(12)
    expect(current!.width).toBe(16)
  }
  await sourceControlActions[0].click()
  const branchInput = page.getByRole('textbox', { name: 'Search or create branch' })
  await branchInput.fill('topic')
  await page.getByRole('button', { name: 'New' }).click()
  await expect(page.locator('[data-section="workflow"] .section-title')).toHaveText('topic')
  await expect(page.locator('button[aria-label="Publish branch"]')).toBeVisible()

  const repositoryFilter = page.getByRole('button', { name: 'Filter by Git status' })
  await expect(repositoryFilter).toHaveAttribute('aria-pressed', 'false')
  await repositoryFilter.click()
  await expect(page.getByText('Filter by Git status')).toBeVisible()
  await expect(page.getByText('Alt-click to show only one status')).toBeVisible()
  const statusFilters = Object.fromEntries(
    ['Modified', 'Untracked', 'Renamed', 'Deleted'].map((status) => [
      status,
      page.getByRole('menuitemcheckbox', { name: status }),
    ]),
  )
  for (const status of Object.values(statusFilters)) await expect(status).toBeVisible()
  const clearFilter = page.getByRole('menuitem', { name: 'Clear filter' })
  await expect(clearFilter).toBeDisabled()
  await statusFilters.Modified.click()
  await statusFilters.Untracked.click()
  await expect(statusFilters.Modified).toBeChecked()
  await expect(statusFilters.Untracked).toBeChecked()
  await statusFilters.Deleted.click({ modifiers: ['Alt'] })
  await expect(statusFilters.Deleted).toBeChecked()
  await expect(statusFilters.Modified).not.toBeChecked()
  await expect(statusFilters.Untracked).not.toBeChecked()
  await expect(page.locator('[data-section="repository"] .section-count')).toContainText('/')
  await expect(
    page
      .locator('#gitna-repository-tree__tree')
      .getByRole('treeitem', { name: 'main.txt', exact: true }),
  ).toHaveCount(0)

  await clearFilter.click()
  await expect(repositoryFilter).toHaveAttribute('aria-pressed', 'false')

  await page.getByRole('button', { name: 'Repository actions' }).click()
  await page.getByRole('menuitem', { name: 'Collapse all folders' }).click()
  await expect(
    page.locator('#gitna-repository-tree__tree').getByRole('treeitem', {
      name: 'clean.txt',
      exact: true,
    }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Repository actions' }).click()
  await page.getByRole('menuitem', { name: 'Expand all folders' }).click()

  await page.getByRole('button', { name: 'Repository actions' }).click()
  await page.getByRole('menuitem', { name: /Show as List/ }).click()
  await expect(
    page.locator('#gitna-repository-tree__tree').getByRole('treeitem', {
      name: 'nested › clean.txt',
      exact: true,
    }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Graph actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Show as Tree' })).toHaveAttribute(
    'data-selected',
    'true',
  )
  await page.getByRole('menuitem', { name: 'Show as List' }).click()
  await page.getByRole('button', { name: 'Graph actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Show as List' })).toHaveAttribute(
    'data-selected',
    'true',
  )
  await expect(page.getByRole('menuitem', { name: 'Reload history' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const mergeCommit = page.getByRole('button', { name: /^merge feature/ }).first()
  await mergeCommit.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toContainText(/\d+ files?/)
  await expect(tooltip).toContainText(/\+\d+/)
  await expect(tooltip).toContainText(/−\d+/)
})

test('repository tree keeps a bounded virtualized viewport for thousands of files', async ({
  page,
  app,
}) => {
  test.setTimeout(120_000)
  const directory = join(app.repo, 'virtualized-files')
  mkdirSync(directory)
  for (let index = 0; index < 2_500; index++) {
    writeFileSync(join(directory, `file-${index.toString().padStart(4, '0')}.txt`), 'content\n')
  }

  await page.goto(app.url)
  const repositoryHeader = page.locator('[data-section="repository"]')
  await repositoryHeader.click()
  await expect
    .poll(
      async () => {
        const count = await repositoryHeader.locator('.section-count').textContent()
        return Number.parseInt(count?.replace(/\D/g, '') ?? '0', 10)
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(2_000)

  const repositoryBody = page.locator('[data-pane-body="repository"]')
  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const virtualScroll = repositoryTree.locator('[data-file-tree-virtualized-scroll="true"]')
  await expect(repositoryBody).toHaveCSS('overflow-y', 'hidden')
  await expect(virtualScroll).toBeVisible()
  await expect.poll(() => repositoryTree.getByRole('treeitem').count()).toBeLessThan(200)
  expect(
    await virtualScroll.evaluate((element) => element.scrollHeight / element.clientHeight),
  ).toBeGreaterThan(10)
})

test('embedded binary serves the branded React frontend', async ({ page, app }) => {
  const response = await page.goto(app.url)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('img', { name: 'Gitna' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Collapse all files' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Theme settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Display settings' })).toBeVisible()
  await expect(page.locator('diffs-container').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Stage file modified.txt' })).toHaveCSS(
    'cursor',
    'pointer',
  )
  await expect(page.locator('aside[aria-label="Source Control"]')).toBeVisible()
  await expect(page.locator('[data-section="repository"]')).toBeVisible()
  await expect(page.locator('[data-section="workflow"]')).toBeVisible()
  await expect(page.locator('[data-section="graph"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Comments', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Display settings' }).click()
  await expect(page.getByText('Backgrounds', { exact: true })).toBeVisible()
  await expect(page.getByText('Line numbers', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('bounded review contract serves all scopes from the real repository', async ({
  request,
  app,
}) => {
  const [unstaged, staged, commit, compare] = await Promise.all([
    readReview(request, new URL('api/v1/review?scope=unstaged', app.url).href),
    readReview(request, new URL('api/v1/review?scope=staged', app.url).href),
    readReview(request, new URL(`api/v1/review?scope=commit&commit=${app.headOid}`, app.url).href),
    readReview(
      request,
      new URL(`api/v1/review?scope=compare&from=${app.baseOid}&to=${app.headOid}`, app.url).href,
    ),
  ])

  expect(unstaged.identity.scope).toBe('unstaged')
  expect(unstaged.patch).toContain('diff --git a/modified.txt b/modified.txt')
  expect(unstaged.patch).toContain('diff --git a/two-hunk.txt b/two-hunk.txt')
  expect(unstaged.supplements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'untracked.txt', kind: 'untracked' }),
      expect.objectContaining({
        path: 'large-untracked.txt',
        diff: expect.objectContaining({ tooLarge: true }),
      }),
    ]),
  )

  expect(staged.identity.scope).toBe('staged')
  expect(staged.patch).toContain('diff --git a/staged.txt b/staged.txt')
  expect(staged.patch).toContain('rename to rename-new.txt')
  expect(staged.patch).toContain('deleted file mode')

  expect(commit.identity.commit).toBe(app.headOid)
  expect(commit.patch).toContain('feature.txt')

  expect(compare.identity.from).toBe(app.baseOid)
  expect(compare.identity.to).toBe(app.headOid)
  expect(compare.patch).toContain('main.txt')
  expect(compare.patch).toContain('feature.txt')
  expect(
    new Set([unstaged.generation, staged.generation, commit.generation, compare.generation]).size,
  ).toBe(1)
})
