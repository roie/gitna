import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { APIRequestContext, Locator } from '@playwright/test'
import { test, expect } from './fixtures.js'

interface ReviewResponse {
  generation: number
  identity: { scope: string; commit?: string; from?: string; to?: string }
  patch: string
  supplements: Array<{ path: string; kind: string; diff: { binary: boolean; tooLarge: boolean } }>
  nextCursor?: string
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
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(app.url).origin,
  })
  const response = await page.goto(app.url)
  expect(response?.status()).toBe(200)
  const folders = await page.evaluate(async () => {
    const response = await fetch('api/v1/folders')
    if (!response.ok) throw new Error(`folders request failed: ${response.status}`)
    return (await response.json()) as {
      current: { path: string; repository: boolean }
      recent: Array<{ path: string }>
    }
  })
  expect(folders.current).toMatchObject({ path: app.repo, repository: true })
  expect(folders.recent[0]?.path).toBe(app.repo)
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
  expect(pageErrors).not.toContainEqual(expect.stringContaining('CodeView.addItem: duplicate id'))
  await repositoryTabs.getByRole('tab', { name: 'feature.txt' }).click()
  await expect(page.getByText('feature branch', { exact: true })).toBeVisible()
  await repositoryTabs.getByRole('tab', { name: 'feature.txt' }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Close Others' })).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCSS('box-shadow', 'none')
  await expect(page.getByRole('menuitem', { name: 'Close Left' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Close Right' })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Close Clean' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Close All' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
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
  await expect(sourcePaneBody).toHaveCSS('overflow-y', 'hidden')
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
  const openWorkingFile = page.getByRole('button', {
    name: 'Open modified.txt in Repository',
  })
  await expect(openWorkingFile).toBeVisible()
  await openWorkingFile.click()
  await expect(repositoryTabs.getByRole('tab', { name: 'modified.txt' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('textbox', { name: 'modified.txt' })).toContainText('unstaged change')
  await graphFile.click()
  await expect(repositoryTabs).toHaveCount(0)
  const missingWorkingFile = graphTree.getByRole('treeitem', {
    name: 'delete.txt',
    exact: true,
  })
  await missingWorkingFile.click()
  await expect(page.getByRole('button', { name: 'Open delete.txt in Repository' })).toHaveCount(0)
  await graphFile.click()
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
  await expect
    .poll(() =>
      sourcePaneBody.evaluate((body) => {
        const lastSection = body.lastElementChild
        if (!(lastSection instanceof HTMLElement)) return Number.POSITIVE_INFINITY
        return Math.round(
          body.getBoundingClientRect().bottom - lastSection.getBoundingClientRect().bottom,
        )
      }),
    )
    .toBeLessThanOrEqual(1)
  await graph.click()
  await expect(graph).toHaveAttribute('aria-expanded', 'false')
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
    await graph.click()
    await graphTree.getByRole('treeitem').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/gitna-graph-refined.png', fullPage: true })
  }
})

test('Graph virtualizes loaded history while preserving expansion, focus, portals, and anchors', async ({
  page,
  app,
}) => {
  test.setTimeout(120_000)
  const oid = (index: number) => index.toString(16).padStart(40, '0')
  const commits = Array.from({ length: 600 }, (_, index) => ({
    oid: oid(index + 1),
    parents: index === 599 ? [] : [oid(index + 2)],
    subject: `virtual commit ${index.toString().padStart(3, '0')}`,
    authorName: 'Gitna benchmark',
    authorTime: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 60_000).toISOString(),
    refs: index === 0 ? [{ name: 'main', kind: 'head' }] : [],
  }))
  let refreshAddsHead = false
  await page.route('**/api/v1/graph?skip=*', async (route) => {
    const url = new URL(route.request().url())
    const skip = Number(url.searchParams.get('skip') ?? 0)
    const available =
      refreshAddsHead && skip === 0
        ? [
            {
              ...commits[0]!,
              oid: 'f'.repeat(40),
              parents: [commits[0]!.oid],
              subject: 'new virtual head',
              refs: [{ name: 'main', kind: 'head' }],
            },
            ...commits,
          ]
        : commits
    const pageCommits = available.slice(skip, skip + 100)
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        commits: pageCommits,
        hasMore: skip + pageCommits.length < available.length,
      }),
    })
  })
  await page.route('**/api/v1/commit/*/files', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        files: Array.from({ length: 40 }, (_, index) => ({
          path: `src/virtual-${index.toString().padStart(2, '0')}.ts`,
          kind: 'modified',
        })),
        stats: { files: 40, additions: 40, deletions: 0, binaryFiles: 0 },
      }),
    })
  })

  await page.goto(app.url)
  await page.locator('[data-section="graph"]').click()
  const graph = page.locator('[data-pane="graph"]')
  const graphBody = graph.locator('[data-pane-body="graph"]')
  const virtualList = graph.getByRole('list', { name: 'Commits' })
  await expect(virtualList).toBeVisible()
  await expect.poll(() => graph.locator('.graph-row').count()).toBeGreaterThan(0)
  expect(await graph.locator('.graph-row').count()).toBeLessThanOrEqual(30)
  await expect(graph.locator('.graph-row').first()).toHaveAttribute('aria-setsize', '-1')

  const loadedCount = async () =>
    Number.parseInt(
      (await graph.locator('[data-section="graph"] .section-count').textContent())!,
      10,
    )
  const loadPage = async () => {
    const previous = await loadedCount()
    await page.getByRole('button', { name: 'Graph actions' }).click()
    await page.getByRole('menuitem', { name: 'Load more commits' }).click()
    await expect.poll(loadedCount).toBeGreaterThan(previous)
  }
  for (let pageIndex = 1; pageIndex < 5; pageIndex += 1) await loadPage()
  await expect.poll(loadedCount).toBe(500)
  await expect(page.getByRole('button', { name: 'Graph actions' })).toBeFocused()

  const firstDisclosure = graph.locator('[data-graph-disclosure]').first()
  await firstDisclosure.focus()
  await expect(firstDisclosure).toBeFocused()
  await page.keyboard.press('End')
  const focusedAtEnd = graph.locator('[data-graph-index="499"] [data-graph-disclosure]')
  await expect(focusedAtEnd).toBeFocused()
  const topVisibleOid = async () =>
    graphBody.evaluate((body) => {
      const bodyTop = body.getBoundingClientRect().top
      const rows = [...body.querySelectorAll<HTMLElement>('.graph-row')].sort(
        (left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top,
      )
      return (
        rows.find((row) => row.getBoundingClientRect().bottom > bodyTop)?.dataset.graphOid ?? null
      )
    })
  const topBeforeAppend = await topVisibleOid()
  await loadPage()
  await expect.poll(loadedCount).toBe(600)
  await expect.poll(topVisibleOid).toBe(topBeforeAppend)
  expect(await graph.locator('.graph-row').count()).toBeLessThanOrEqual(30)
  await expect(graph.locator('.graph-row').last()).toHaveAttribute('aria-setsize', '600')

  await focusedAtEnd.focus()
  await expect(focusedAtEnd).toBeFocused()
  await page.keyboard.press('Home')
  const headDisclosure = graph.locator('[data-graph-index="0"] [data-graph-disclosure]')
  await expect(headDisclosure).toBeFocused()
  await headDisclosure.click()
  const expandedRow = graph.locator('[data-graph-index="0"]')
  await expect(expandedRow.getByRole('tree')).toBeVisible()
  await expect.poll(async () => (await expandedRow.boundingBox())?.height ?? 0).toBeGreaterThan(28)
  const expandedHeight = (await expandedRow.boundingBox())!.height
  expect(await graph.locator('.graph-row').count()).toBeLessThanOrEqual(30)

  const secondActions = graph.locator('[data-graph-index="1"]').getByRole('button', {
    name: 'Actions for virtual commit 001',
  })
  await secondActions.click()
  await expect(page.getByRole('menuitem', { name: 'Cherry-pick' })).toBeVisible()
  await graphBody.evaluate((body) => {
    body.scrollTop = body.scrollHeight
  })
  await expect(graph.locator('[data-graph-index="1"]')).toHaveCount(1)
  await expect(page.getByRole('menuitem', { name: 'Cherry-pick' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(secondActions).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  const openSourceControl = page.getByRole('button', { name: 'Open Source Control' })
  if (await openSourceControl.isVisible()) await openSourceControl.click()
  const paneStack = page.locator('.pane-stack')
  await paneStack.evaluate((pane) => {
    pane.scrollTop = pane.scrollHeight
  })
  await expect.poll(() => graph.locator('.graph-row').count()).toBeLessThanOrEqual(35)
  await expect(graph.locator('[data-graph-index="599"]')).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 720 })
  await graphBody.evaluate(
    (body, offset) => {
      body.scrollTop = offset
    },
    expandedHeight + 50 * 28,
  )
  const anchorRow = graph.locator('[data-graph-index="50"]')
  await expect(anchorRow).toBeVisible()
  await anchorRow.locator('[data-graph-disclosure]').focus()
  const topBeforeRefresh = await topVisibleOid()
  refreshAddsHead = true
  await page.getByRole('button', { name: 'Refresh Graph' }).click()
  await expect.poll(loadedCount).toBe(100)
  await expect.poll(topVisibleOid).toBe(topBeforeRefresh)
  const anchoredDisclosure = graph
    .locator(`[data-graph-oid="${topBeforeRefresh}"]`)
    .locator('[data-graph-disclosure]')
  await anchoredDisclosure.focus()
  await page.keyboard.press('Home')
  await expect(graph.locator('[data-graph-index="0"]')).toHaveAttribute(
    'data-graph-oid',
    'f'.repeat(40),
  )

  const adjacentGutters = graph.locator(
    '[data-graph-index="2"] [data-graph-gutter], [data-graph-index="3"] [data-graph-gutter]',
  )
  await expect(adjacentGutters).toHaveCount(2)
  const laneGap = await adjacentGutters.evaluateAll((gutters) => {
    const boxes = gutters
      .map((gutter) => gutter.getBoundingClientRect())
      .sort((left, right) => left.top - right.top)
    return Math.abs(boxes[0]!.bottom - boxes[1]!.top)
  })
  expect(laneGap).toBeLessThanOrEqual(1)
})

test('Graph deletion does not open a re-added current file', async ({ page, app }) => {
  runGit(app.repo, 'reset', '--hard', 'HEAD')
  runGit(app.repo, 'clean', '-fd')
  writeFileSync(join(app.repo, 'readded.txt'), 'committed content\n')
  runGit(app.repo, 'add', '--', 'readded.txt')
  runGit(app.repo, 'commit', '-m', 'add readded fixture')
  runGit(app.repo, 'rm', '--', 'readded.txt')
  runGit(app.repo, 'commit', '-m', 'historical deletion fixture')
  writeFileSync(join(app.repo, 'readded.txt'), 'current replacement\n')
  runGit(app.repo, 'add', '--', 'readded.txt')
  runGit(app.repo, 'commit', '-m', 're-add current fixture')
  expect(readFileSync(join(app.repo, 'readded.txt'), 'utf8')).toBe('current replacement\n')

  await page.goto(app.url)
  await page.locator('[data-section="graph"]').click()
  const deletedRow = page.locator('.graph-row').filter({
    has: page.getByRole('button', { name: /^historical deletion fixture/ }),
  })
  await deletedRow.getByRole('button', { name: /^historical deletion fixture/ }).click()
  await deletedRow.getByRole('treeitem', { name: 'readded.txt', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open readded.txt in Repository' })).toHaveCount(0)
  if (process.env.GITNA_CAPTURE_REVIEW_FIXES) {
    await page.screenshot({ path: '/tmp/gitna-graph-deleted-current.png', fullPage: true })
  }
})

test('repository invalidations refresh the review without remounting it', async ({ page, app }) => {
  await page.goto(app.url)
  const viewer = page.locator('.code-view')
  await expect(viewer).toBeVisible()
  const mountedViewer = await viewer.elementHandle()
  expect(mountedViewer).not.toBeNull()

  writeFileSync(join(app.repo, 'modified.txt'), 'viewer refresh marker\n')

  await expect(
    page.locator('diffs-container').filter({ hasText: 'viewer refresh marker' }),
  ).toBeVisible()
  expect(await mountedViewer!.evaluate((element) => element.isConnected)).toBe(true)
})

test('scrolling near the review end appends pages without remounting CodeView', async ({
  page,
  app,
}) => {
  let releaseSecondPage!: () => void
  const secondPageReady = new Promise<void>((resolve) => {
    releaseSecondPage = resolve
  })
  const patch = (path: string, content: string) => `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+${content}
`
  await page.route('**/api/v1/review?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    if (cursor != null) await secondPageReady
    await route.fulfill({
      json: {
        generation: 7,
        identity: { scope: 'unstaged' },
        patch:
          cursor == null
            ? patch('page-one.txt', 'first review page')
            : patch('untracked.txt', 'second review page'),
        supplements: [],
        nextCursor: cursor == null ? 'next-page' : undefined,
      } satisfies ReviewResponse,
    })
  })

  await page.goto(app.url)
  const viewer = page.locator('.code-view')
  await expect(page.getByText('first review page', { exact: true })).toBeVisible()
  const mountedViewer = await viewer.elementHandle()
  expect(mountedViewer).not.toBeNull()
  await page.locator('.cv-scrollbar').evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
  })
  releaseSecondPage()
  await expect(page.getByText('second review page', { exact: true })).toBeVisible()
  expect(await mountedViewer!.evaluate((element) => element.isConnected)).toBe(true)
})

test('selecting a change beyond the first review page loads it immediately', async ({
  page,
  app,
}) => {
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(
      join(app.repo, `zz-page-${index.toString().padStart(2, '0')}.txt`),
      `page ${index}\n`,
    )
  }

  await page.goto(app.url)
  const viewer = page.locator('.code-view')
  await expect(viewer).toBeVisible()
  const mountedViewer = await viewer.elementHandle()
  expect(mountedViewer).not.toBeNull()

  const changesTree = page.locator('#gitna-unstaged-tree__tree')
  await changesTree.locator('[data-file-tree-virtualized-scroll="true"]').evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight
    scroller.dispatchEvent(new Event('scroll'))
  })
  await changesTree.getByRole('treeitem', { name: 'zz-page-29.txt', exact: true }).click()

  await expect(page.getByText('page 29', { exact: true })).toBeVisible()
  expect(await mountedViewer!.evaluate((element) => element.isConnected)).toBe(true)
})

test('working files and staged or unstaged diffs navigate as one file', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'staged.txt'), 'unstaged change after staging\n')
  mkdirSync(join(app.repo, 'nested'))
  writeFileSync(join(app.repo, 'nested/navigation.txt'), 'navigate from list view\n')

  await page.goto(app.url)
  const repositoryHeader = page.locator('[data-section="repository"]')
  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const changesTree = page.locator('#gitna-unstaged-tree__tree')
  const stagedTree = page.locator('#gitna-staged-tree__tree')

  await changesTree.getByRole('treeitem', { name: 'modified.txt', exact: true }).click()
  await page.getByRole('button', { name: 'Open modified.txt in Repository' }).click()
  await expect(repositoryHeader).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('textbox', { name: 'modified.txt' })).toBeVisible()
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'modified.txt', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByRole('textbox', { name: 'modified.txt' })).toBeVisible()

  await page.getByRole('button', { name: 'View changes for modified.txt' }).click()
  await expect(
    changesTree.getByRole('treeitem', { name: 'modified.txt', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Open modified.txt in Repository' })).toBeVisible()

  await repositoryTree.getByRole('treeitem', { name: 'staged.txt', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'staged.txt' })).toBeVisible()
  await page.getByRole('button', { name: 'Choose changes to view for staged.txt' }).click()
  await expect(page.getByRole('menuitem', { name: 'View Unstaged Changes' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'View Staged Changes' }).click()
  await expect(
    stagedTree.getByRole('treeitem', { name: 'staged.txt', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')

  const stagedChange = stagedTree.getByRole('treeitem', { name: 'staged.txt', exact: true })
  const stagedChangeBox = await stagedChange.boundingBox()
  expect(stagedChangeBox).not.toBeNull()
  await stagedChange.click({ button: 'right' })
  const stagedMenuBox = await page.getByRole('menu').boundingBox()
  expect(stagedMenuBox).not.toBeNull()
  expect(
    Math.abs(stagedMenuBox!.x - (stagedChangeBox!.x + stagedChangeBox!.width / 2)),
  ).toBeLessThan(8)
  expect(
    Math.abs(stagedMenuBox!.y - (stagedChangeBox!.y + stagedChangeBox!.height / 2)),
  ).toBeLessThan(8)
  await page.getByRole('menuitem', { name: 'Open in Explorer' }).click()
  await expect(page.getByRole('textbox', { name: 'staged.txt' })).toBeVisible()

  await repositoryTree
    .getByRole('treeitem', { name: 'staged.txt', exact: true })
    .click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'View Unstaged Changes' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'View Staged Changes' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Explorer actions' }).click()
  await page.getByRole('menuitem', { name: /Show as List/ }).click()
  await repositoryTree
    .getByRole('treeitem', { name: 'nested › navigation.txt', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'View Unstaged Changes' }).click()
  await expect(
    page.getByRole('button', { name: 'Open nested/navigation.txt in Repository' }),
  ).toBeVisible()
})

test('many repository tabs follow Zed-style horizontal scrolling', async ({ page, app }) => {
  await page.setViewportSize({ width: 900, height: 720 })
  await page.goto(app.url)
  await page.locator('[data-section="repository"]').click()

  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const paths = [
    'feature.txt',
    'main.txt',
    'modified.txt',
    'rename-new.txt',
    'staged.txt',
    'two-hunk.txt',
    'untracked.txt',
    'large-untracked.txt',
  ]
  for (const path of paths) {
    await repositoryTree.getByRole('treeitem', { name: path, exact: true }).click()
  }

  const repositoryTabs = page.getByRole('tablist', { name: 'Open repository files' })
  await expect(repositoryTabs).toHaveClass(/no-scrollbar/)
  await expect(repositoryTabs).toHaveCSS('scrollbar-width', 'none')
  await expect(repositoryTabs.getByRole('tab')).toHaveCount(paths.length)
  await expect
    .poll(() => repositoryTabs.evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth))
    .toBe(true)
  const activeTab = repositoryTabs.getByRole('tab', { name: 'large-untracked.txt', exact: true })
  await expect(activeTab).toHaveAttribute('aria-selected', 'true')
  await expect
    .poll(async () => {
      const [tabs, active] = await Promise.all([
        repositoryTabs.boundingBox(),
        activeTab.boundingBox(),
      ])
      return (
        tabs != null &&
        active != null &&
        active.x >= tabs.x &&
        active.x + active.width <= tabs.x + tabs.width
      )
    })
    .toBe(true)

  const initialScrollLeft = await repositoryTabs.evaluate((tabs) => tabs.scrollLeft)
  expect(initialScrollLeft).toBeGreaterThan(0)
  await repositoryTabs.hover()
  await page.mouse.wheel(0, -300)
  await expect
    .poll(() => repositoryTabs.evaluate((tabs) => tabs.scrollLeft))
    .toBeLessThan(initialScrollLeft)

  const middleClickTab = repositoryTabs.getByRole('tab', { name: 'feature.txt', exact: true })
  await middleClickTab.click({ button: 'middle' })
  await expect(middleClickTab).toHaveCount(0)

  let dirtyTab = repositoryTabs.getByRole('tab', { name: /^main\.txt/ })
  await dirtyTab.click()
  const dirtyEditor = page.getByRole('textbox', { name: 'main.txt' })
  await dirtyEditor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('unsaved tab draft')
  dirtyTab = repositoryTabs.getByRole('tab', { name: /main\.txt Unsaved changes/ })
  await expect(dirtyTab).toBeVisible()
  const survivingTab = repositoryTabs.getByRole('tab', { name: 'staged.txt', exact: true })
  await survivingTab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close Others' }).click()
  const bulkCloseConfirmation = page.getByRole('alertdialog', {
    name: 'Discard unsaved changes to main.txt?',
  })
  await expect(bulkCloseConfirmation).toBeVisible()
  await bulkCloseConfirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(repositoryTabs.getByRole('tab')).toHaveCount(paths.length - 1)
  await expect(dirtyTab).toBeVisible()

  await survivingTab.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close Others' }).click()
  await bulkCloseConfirmation.getByRole('button', { name: 'Discard changes' }).click()
  await expect(repositoryTabs.getByRole('tab')).toHaveCount(1)
  await expect(survivingTab).toBeVisible()
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
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'untracked-preview.png', exact: true })
    .click()
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

  const openCurrentImage = page.getByRole('button', {
    name: 'Open Image preview for preview.png in image viewer',
  })
  await openCurrentImage.focus()
  await page.keyboard.press('Enter')
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
  const textBackground = await page
    .getByRole('button', { name: 'Stage file modified.txt' })
    .locator('xpath=ancestor::diffs-container')
    .evaluate(
      (host) =>
        getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('pre')!).backgroundColor,
    )

  await page.locator('[data-section="repository"]').click()
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'preview.png', exact: true })
    .click()
  const repositoryImage = page.getByRole('img', { name: 'preview.png', exact: true })
  await expect(repositoryImage).toBeVisible()
  const imageContainer = repositoryImage.locator('xpath=ancestor::diffs-container')
  await expect(imageContainer.locator('[data-line-number-content]:visible')).toHaveCount(0)
  await expect(imageContainer.locator('pre:visible')).toHaveCount(0)
  const imageBackground = await imageContainer.evaluate(
    (host) =>
      getComputedStyle(host.shadowRoot!.querySelector<HTMLElement>('[data-custom-body]')!)
        .backgroundColor,
  )
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
  await expect(repositoryImage).toBeVisible()
  await expect(
    repositoryImage.locator('xpath=ancestor::diffs-container').locator('pre:visible'),
  ).toHaveCount(0)
})

test('folder path switches the live session and remains fully editable', async ({ page, app }) => {
  const nextRepo = join(dirname(app.repo), 'next-repository-with-a-long-location-name')
  mkdirSync(nextRepo)
  runGit(nextRepo, 'init', '-q', '-b', 'trunk')
  runGit(nextRepo, 'config', 'user.email', 'e2e@example.com')
  runGit(nextRepo, 'config', 'user.name', 'Gitna E2E')
  writeFileSync(join(nextRepo, 'next.txt'), 'next repository\n')
  runGit(nextRepo, 'add', '--', 'next.txt')
  runGit(nextRepo, 'commit', '-qm', 'next repository')

  await page.goto(app.url)
  await expect(page).toHaveTitle(`${basename(app.repo)} - Gitna`)
  const pathInput = page.getByRole('combobox', { name: 'Folder path' })
  await expect(pathInput).toHaveValue(app.repo)
  await pathInput.fill(nextRepo)
  const openFolder = page.getByRole('button', { name: 'Switch folder' })
  await expect(openFolder).toBeVisible()
  await openFolder.click()

  await expect(pathInput).toHaveValue(nextRepo)
  await expect(page).toHaveTitle(`${basename(nextRepo)} - Gitna`)
  await expect(openFolder).not.toBeVisible()
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
  const clearPath = page.getByRole('button', { name: 'Clear folder path' })
  await page.mouse.move(0, 0)
  await expect(clearPath).toHaveCSS('opacity', '0')
  await pathInput.hover()
  await expect(clearPath).toHaveCSS('opacity', '0.5')
  const inputBox = await pathInput.boundingBox()
  const clearBox = await clearPath.boundingBox()
  expect(inputBox).not.toBeNull()
  expect(clearBox).not.toBeNull()
  expect(clearBox!.x - (inputBox!.x + inputBox!.width)).toBe(4)
  await expect(page.getByRole('button', { name: 'Reveal folder in file manager' })).toBeVisible()

  await pathInput.focus()
  const recentFolders = page.getByRole('listbox', { name: 'Recent folders' })
  const previousFolder = recentFolders.getByRole('option', {
    name: new RegExp(basename(app.repo)),
  })
  await expect(recentFolders).toBeVisible()
  await expect(recentFolders).toHaveCSS('box-shadow', 'none')
  await previousFolder.hover()
  const openPreviousInNewTab = recentFolders.getByRole('button', {
    name: `Open ${basename(app.repo)} in new tab`,
  })
  const removePreviousFromRecent = recentFolders.getByRole('button', {
    name: `Remove ${basename(app.repo)} from recent folders`,
  })
  await expect(openPreviousInNewTab).toBeVisible()
  await expect(removePreviousFromRecent).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await openPreviousInNewTab.click()
  const previousPage = await popupPromise
  await expect(previousPage).toHaveTitle(`${basename(app.repo)} - Gitna`)
  await previousPage.close()
  await expect(page).toHaveTitle(`${basename(nextRepo)} - Gitna`)
  await page.keyboard.press('ArrowDown')
  await expect(previousFolder).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(pathInput).toHaveValue(app.repo)
  await expect(page).toHaveTitle(`${basename(app.repo)} - Gitna`)

  await pathInput.focus()
  const nextFolderOption = recentFolders.getByRole('option', {
    name: new RegExp(basename(nextRepo)),
  })
  await nextFolderOption.hover()
  await recentFolders
    .getByRole('button', {
      name: `Remove ${basename(nextRepo)} from recent folders`,
    })
    .click()
  await expect(nextFolderOption).toHaveCount(0)
})

test('same-tab folder switching shows and restores a branded transition', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${app.url}?trace-startup=1`)
  await expect(page).toHaveTitle(`${basename(app.repo)} - Gitna`)
  await page.getByRole('button', { name: 'Theme settings' }).click()
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.keyboard.press('Escape')
  const originalTitle = await page.title()
  const pathInput = page.getByRole('combobox', { name: 'Folder path' })
  const longName = `folder-${'long-name-'.repeat(20)}`
  const target = join(dirname(app.repo), longName)
  let releaseRequest!: () => void
  const release = new Promise<void>((resolve) => {
    releaseRequest = resolve
  })
  let transitionVisibleAtRequest = false
  let startupRecordedBeforeRequest = false
  await page.route('**/api/v1/folder', async (route) => {
    transitionVisibleAtRequest = (await page.locator('[data-folder-loading]').count()) === 1
    startupRecordedBeforeRequest = await page.evaluate(() => {
      const raw = sessionStorage.getItem('gitna:switch-start')
      if (raw == null) return false
      const marker = JSON.parse(raw) as { startedAt?: unknown }
      return typeof marker.startedAt === 'number' && marker.startedAt <= Date.now()
    })
    await release
    await route
      .fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'folder is unavailable' }),
      })
      .catch(() => undefined)
  })

  await pathInput.fill(target)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  const transition = page.locator('[data-folder-loading]')
  await expect(transition).toBeVisible()
  await expect(transition).toHaveAttribute('aria-busy', 'true')
  await expect(transition.getByText('Gitna', { exact: true })).toBeVisible()
  await expect(transition.locator('img[src="./gitna-logo-dark.png"]')).toBeVisible()
  const heading = transition.getByRole('heading', { name: `Opening ${longName}` })
  await expect(heading).toBeVisible()
  await expect(heading).toHaveCSS('text-overflow', 'ellipsis')
  await expect(transition.getByRole('status')).toHaveText('Preparing your folder…')
  await expect(transition.locator('.animate-spin')).toHaveCSS('animation-name', 'none')
  await expect(page).toHaveTitle(`Opening ${longName} - Gitna`)
  await expect.poll(() => transitionVisibleAtRequest).toBe(true)
  await expect.poll(() => startupRecordedBeforeRequest).toBe(true)

  // A newer programmatic switch aborts the stale request and owns restoration.
  // Programmatic submission is intentional here because the old workbench is
  // correctly inert to user input while the transition is visible.
  const replacementName = 'replacement-folder'
  const replacementTarget = join(dirname(app.repo), replacementName)
  await page.evaluate((path) => {
    const input = document.querySelector<HTMLInputElement>('[aria-label="Folder path"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, path)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, replacementTarget)
  await page.waitForTimeout(0)
  await page.evaluate(() =>
    document.querySelector<HTMLInputElement>('[aria-label="Folder path"]')?.form?.requestSubmit(),
  )
  await expect(
    transition.getByRole('heading', { name: `Opening ${replacementName}`, exact: true }),
  ).toBeVisible()

  releaseRequest()
  await expect(transition).toHaveCount(0)
  await expect(page).toHaveTitle(originalTitle)
  await expect(page.getByRole('button', { name: 'Switch folder' })).toBeFocused()
  await expect(page.getByRole('alert')).toContainText(
    `Could not open ${replacementName}: folder is unavailable`,
  )
  await expect(pathInput).toHaveValue(replacementTarget)
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('gitna:switch-start')))
    .toBeNull()

  await expect
    .poll(() =>
      page.evaluate(() => performance.getEntriesByType('mark').map((entry) => entry.name)),
    )
    .toEqual(
      expect.arrayContaining([
        'gitna:mount',
        'gitna:destination-response',
        'gitna:snapshot-ready',
        'gitna:source-control-ready',
        'gitna:explorer-ready',
        'gitna:graph-ready',
        'gitna:sse-ready',
      ]),
    )
})

test('startup diagnostics are disabled without explicit opt-in', async ({ page, app }) => {
  await page.goto(app.url)
  await expect(page.getByRole('button', { name: 'Gitna Home' })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        performance
          .getEntriesByType('mark')
          .map((entry) => entry.name)
          .filter((name) => name.startsWith('gitna:')),
      ),
    )
    .toEqual([])
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('gitna:switch-start')))
    .toBeNull()
})

test('stable folder routes isolate parallel browser pages', async ({ page, app }) => {
  const nextRepo = join(dirname(app.repo), 'parallel-folder')
  mkdirSync(nextRepo)
  runGit(nextRepo, 'init', '-q', '-b', 'parallel')
  runGit(nextRepo, 'config', 'user.email', 'e2e@example.com')
  runGit(nextRepo, 'config', 'user.name', 'Gitna E2E')
  writeFileSync(join(nextRepo, 'parallel.txt'), 'parallel folder\n')
  runGit(nextRepo, 'add', '--', 'parallel.txt')
  runGit(nextRepo, 'commit', '-qm', 'parallel folder')

  await page.goto(app.url)
  const initialUrl = page.url()
  expect(new URL(initialUrl).pathname).toMatch(/\/g\/[^/]+\/repo\/$/)
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.fill(nextRepo)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  await expect(page).toHaveTitle(`${basename(nextRepo)} - Gitna`)
  const nextUrl = page.url()
  expect(nextUrl).not.toBe(initialUrl)
  expect(new URL(nextUrl).pathname).toMatch(/\/parallel-folder\/$/)

  const originalPage = await page.context().newPage()
  try {
    await originalPage.goto(initialUrl)
    await expect(originalPage).toHaveTitle(`${basename(app.repo)} - Gitna`)
    const [nextRoot, originalRoot] = await Promise.all([
      page.evaluate(
        async () => ((await (await fetch('api/v1/snapshot')).json()) as { root: string }).root,
      ),
      originalPage.evaluate(
        async () => ((await (await fetch('api/v1/snapshot')).json()) as { root: string }).root,
      ),
    ])
    expect(nextRoot).toBe(nextRepo)
    expect(originalRoot).toBe(app.repo)

    await Promise.all([page.reload(), originalPage.reload()])
    await expect(page).toHaveTitle(`${basename(nextRepo)} - Gitna`)
    await expect(originalPage).toHaveTitle(`${basename(app.repo)} - Gitna`)
  } finally {
    await originalPage.close()
  }
})

test('header folder switcher keeps keyboard navigation visible', async ({ page, app }) => {
  const recent = Array.from({ length: 20 }, (_, index) => ({
    path: `/tmp/recent-parent-${index.toString().padStart(2, '0')}/folder-${index.toString().padStart(2, '0')}`,
    name: `folder-${index.toString().padStart(2, '0')}`,
    repository: index % 2 === 0,
    lastOpened: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }))
  await page.route('**/api/v1/folders', async (route) => {
    await route.fulfill({
      json: {
        current: {
          path: app.repo,
          name: basename(app.repo),
          repository: true,
          lastOpened: new Date(Date.UTC(2026, 0, 21)).toISOString(),
        },
        recent,
      },
    })
  })

  await page.goto(app.url)
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.focus()
  const listbox = page.getByRole('listbox', { name: 'Recent folders' })
  await expect(listbox).toBeVisible()
  for (let index = 0; index < 15; index += 1) await page.keyboard.press('ArrowDown')

  const activeOption = listbox.getByRole('option').nth(14)
  await expect(activeOption).toHaveAttribute('aria-selected', 'true')
  const [listboxBounds, optionBounds] = await Promise.all([
    listbox.boundingBox(),
    activeOption.boundingBox(),
  ])
  expect(listboxBounds).not.toBeNull()
  expect(optionBounds).not.toBeNull()
  expect(optionBounds!.y).toBeGreaterThanOrEqual(listboxBounds!.y)
  expect(optionBounds!.y + optionBounds!.height).toBeLessThanOrEqual(
    listboxBounds!.y + listboxBounds!.height + 1,
  )
})

test('command palette searches complete paths and runs workbench commands', async ({
  page,
  app,
}) => {
  mkdirSync(join(app.repo, 'client'), { recursive: true })
  mkdirSync(join(app.repo, 'server', 'palette-token'), { recursive: true })
  mkdirSync(join(app.repo, 'space dir'), { recursive: true })
  writeFileSync(join(app.repo, 'client/index.ts'), 'client\n')
  writeFileSync(join(app.repo, 'server/palette-token/index.ts'), 'server\n')
  writeFileSync(join(app.repo, 'space dir/file name.ts'), 'space\n')

  await page.goto(app.url)
  const paletteTrigger = page.getByRole('button', { name: 'Open command palette' })
  await expect(paletteTrigger).toBeVisible()
  await paletteTrigger.click()

  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search files and commands' })
  const paletteResults = palette.getByRole('listbox', { name: 'Files' })
  await expect(palette).toBeVisible()
  await expect(palette).toHaveCSS('box-shadow', 'none')
  await expect(paletteResults).toHaveClass(/cv-mini-scrollbar/)
  await expect(search).toBeFocused()
  await search.fill('file name')
  const spacedFile = palette.getByRole('option', { name: /file name\.ts/ })
  await expect(spacedFile).toBeVisible()
  await expect(spacedFile.locator('[data-palette-file-icon]')).toHaveAttribute(
    'data-icon-token',
    /.+/,
  )
  if (process.env.GITNA_CAPTURE_REVIEW_FIXES) {
    await page.screenshot({ path: '/tmp/gitna-palette-file-icons.png', fullPage: true })
  }
  const activeDescendant = await search.getAttribute('aria-activedescendant')
  expect(activeDescendant).not.toMatch(/\s/)
  await expect(spacedFile).toHaveAttribute('id', activeDescendant!)

  await search.fill('palette-token index')
  const serverFile = palette.getByRole('option', {
    name: /index\.ts server\/palette-token/,
  })
  await expect(serverFile).toBeVisible()
  await expect(serverFile).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(page.getByRole('textbox', { name: 'server/palette-token/index.ts' })).toBeVisible()

  const editor = page.getByRole('textbox', { name: 'server/palette-token/index.ts' })
  await editor.focus()
  await page.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await expect(search).toBeFocused()
  await page.keyboard.press('Control+k')
  await expect(palette).toHaveCount(0)

  await paletteTrigger.focus()
  await page.keyboard.press('Control+Shift+k')
  await expect(palette).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await search.fill('>toggle diff layout')
  const toggleLayout = palette.getByRole('option', { name: /Toggle Diff Layout/ })
  await expect(toggleLayout).toBeVisible()
  await expect(
    toggleLayout.locator('[data-palette-command-icon="toggle-diff-layout"] svg'),
  ).toHaveCount(1)
  await search.fill('>')
  const openFolderCommand = palette.getByRole('option', { name: /^Open Folder/ })
  const homeCommand = palette.getByRole('option', { name: /^Gitna Home/ })
  await expect(
    openFolderCommand.locator('[data-palette-command-icon="open-folder"] svg'),
  ).toHaveCount(1)
  await expect(homeCommand.locator('[data-palette-command-icon="home"] svg')).toHaveCount(1)
  if (process.env.GITNA_CAPTURE_REVIEW_FIXES) {
    await page.screenshot({ path: '/tmp/gitna-palette-command-icons.png', fullPage: true })
  }
  expect(
    await openFolderCommand
      .locator('[data-palette-command-icon] svg')
      .evaluate((icon) => icon.innerHTML),
  ).not.toBe(
    await homeCommand.locator('[data-palette-command-icon] svg').evaluate((icon) => icon.innerHTML),
  )
  await search.fill('>toggle diff layout')
  await search.press('End')
  await search.press('Home')
  await expect(toggleLayout).toHaveAttribute('aria-selected', 'true')
  await search.press('Enter')
  await expect(page.getByRole('button', { name: 'Switch to split view' })).toBeVisible()
})

test('command palette omits mutations while a repository operation is busy', async ({
  page,
  app,
}) => {
  let releaseStage!: () => void
  let markStageStarted!: () => void
  const stageStarted = new Promise<void>((resolve) => {
    markStageStarted = resolve
  })
  const stageReleased = new Promise<void>((resolve) => {
    releaseStage = resolve
  })
  await page.route('**/api/v1/operations?op=stage', async (route) => {
    markStageStarted()
    await stageReleased
    await route.continue()
  })

  await page.goto(app.url)
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'modified.txt', exact: true })
    .click()
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/api/v1/operations?op=stage'),
  )
  await page.getByRole('button', { name: 'Stage file modified.txt' }).click()
  await stageStarted

  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search files and commands' })
  await search.fill('>stage current file')
  await expect(palette.getByRole('option', { name: /Stage Current File/ })).toHaveCount(0)

  releaseStage()
  await response
})

test('mobile command palette describes the active Source Control overlay', async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(app.url)
  const paletteTrigger = page.getByRole('button', { name: 'Open command palette' })
  await paletteTrigger.click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = palette.getByRole('combobox', { name: 'Search files and commands' })
  await search.fill('>toggle sidebar')
  await expect(
    palette.getByRole('option', { name: /Toggle Sidebar Show Source Control/ }),
  ).toBeVisible()
  await search.press('Enter')

  await expect(page.getByRole('complementary', { name: 'Source Control' })).toBeVisible()
  await page.keyboard.press('Control+k')
  await search.fill('>toggle sidebar')
  await expect(
    palette.getByRole('option', { name: /Toggle Sidebar Hide Source Control/ }),
  ).toBeVisible()
})

test('repository files can be edited, created in folders, and renamed', async ({ page, app }) => {
  const nextRepo = join(dirname(app.repo), 'repository-editor-switch-target')
  mkdirSync(nextRepo)
  runGit(nextRepo, 'init', '-q', '-b', 'trunk')
  runGit(nextRepo, 'config', 'user.email', 'e2e@example.com')
  runGit(nextRepo, 'config', 'user.name', 'Gitna E2E')
  writeFileSync(join(nextRepo, 'other.txt'), 'other repository\n')
  runGit(nextRepo, 'add', '--', 'other.txt')
  runGit(nextRepo, 'commit', '-qm', 'other repository')
  mkdirSync(join(app.repo, 'archive'))
  writeFileSync(join(app.repo, 'archive/keep.txt'), 'archive\n')

  await page.goto(app.url)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          document.documentElement.dataset.copiedPath = value
          return Promise.resolve()
        },
      },
    })
  })
  await page.locator('[data-section="repository"]').click()

  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const mainTreeItem = repositoryTree.getByRole('treeitem', { name: 'main.txt', exact: true })
  await mainTreeItem.click({ button: 'right' })
  const copyRelativePath = page.getByRole('menuitem', { name: 'Copy Relative Path' })
  await expect(copyRelativePath).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCSS('box-shadow', 'none')
  await copyRelativePath.click()
  await expect(page.locator('html')).toHaveAttribute('data-copied-path', 'main.txt')

  await repositoryTree
    .getByRole('treeitem', { name: 'feature.txt', exact: true })
    .dragTo(repositoryTree.getByRole('treeitem', { name: 'archive', exact: true }))
  await expect.poll(() => existsSync(join(app.repo, 'archive/feature.txt'))).toBe(true)
  expect(existsSync(join(app.repo, 'feature.txt'))).toBe(false)
  await expect(page.getByRole('button', { name: 'Close archive/feature.txt' })).toBeVisible()

  await mainTreeItem.click()
  const mainEditor = page.getByRole('textbox', { name: 'main.txt' })
  await expect(async () => {
    await mainEditor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('\nedited in Gitna')
    await expect(page.getByRole('tab', { name: /main\.txt Unsaved changes/ })).toBeVisible({
      timeout: 1_000,
    })
  }).toPass()
  await page.getByRole('button', { name: 'Close main.txt' }).click()
  const discardDraft = page.getByRole('alertdialog', {
    name: 'Discard unsaved changes to main.txt?',
  })
  await expect(discardDraft).toBeVisible()
  await discardDraft.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('tab', { name: /main\.txt Unsaved changes/ })).toBeVisible()
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeEnabled()
  let releaseSave!: () => void
  let saveStarted!: () => void
  const started = new Promise<void>((resolve) => {
    saveStarted = resolve
  })
  let delayNextSave = true
  await page.route('**/api/v1/worktree/file', async (route) => {
    if (route.request().method() !== 'PUT' || !delayNextSave) {
      await route.continue()
      return
    }
    delayNextSave = false
    saveStarted()
    await new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    await route.continue()
  })
  await save.click()
  await started
  const firstSaveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/v1/worktree/file'),
  )
  await mainEditor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' while saving')
  releaseSave()
  const firstResponse = await firstSaveResponse
  expect(firstResponse.status(), await firstResponse.text()).toBe(200)
  await expect(save).toBeEnabled()
  const secondSaveResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url().endsWith('/api/v1/worktree/file'),
  )
  await save.click()
  const secondResponse = await secondSaveResponse
  expect(secondResponse.status(), await secondResponse.text()).toBe(200)
  await expect
    .poll(() => readFileSync(join(app.repo, 'main.txt'), 'utf8'))
    .toContain('edited in Gitna while saving')
  const savedStatus = page.getByRole('status').filter({ hasText: 'Saved' })
  await expect(savedStatus).toBeVisible()
  await expect(savedStatus).not.toBeVisible({ timeout: 3_000 })

  const repositoryActions = page.getByRole('button', { name: 'Explorer actions' })
  await repositoryActions.click()
  await page.getByRole('menuitem', { name: 'New Folder' }).click()
  let pathInput = page.getByRole('textbox', { name: 'Repository-relative path' })
  await pathInput.fill('notes')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(page.getByRole('dialog', { name: 'New file' })).toBeVisible()
  pathInput = page.getByRole('textbox', { name: 'Repository-relative path' })
  await expect(pathInput).toHaveValue('notes/')
  await pathInput.fill('notes/new.txt')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  const newEditor = page.getByRole('textbox', { name: 'notes/new.txt' })
  await expect(async () => {
    await newEditor.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('new file from Gitna')
    await expect(page.getByRole('tab', { name: /new\.txt Unsaved changes/ })).toBeVisible({
      timeout: 1_000,
    })
  }).toPass()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'notes/new.txt'), 'utf8'))
    .toBe('new file from Gitna')

  await repositoryActions.click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  pathInput = page.getByRole('textbox', { name: 'Repository-relative path' })
  await pathInput.fill('notes/renamed.txt')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect.poll(() => existsSync(join(app.repo, 'notes/renamed.txt'))).toBe(true)
  expect(existsSync(join(app.repo, 'notes/new.txt'))).toBe(false)
  await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toBeVisible()

  const renamedEditor = page.getByRole('textbox', { name: 'notes/renamed.txt' })
  await expect(async () => {
    await renamedEditor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(' unsaved')
    await expect(page.getByRole('tab', { name: /renamed\.txt Unsaved changes/ })).toBeVisible({
      timeout: 1_000,
    })
  }).toPass()
  const unsavedContents = (await renamedEditor.textContent()) ?? ''
  expect(unsavedContents).toContain('unsaved')
  const repositoryPath = page.getByRole('combobox', { name: 'Folder path' })
  await repositoryPath.fill(join(app.repo, 'missing-repository'))
  await page.getByRole('button', { name: 'Switch folder' }).click()
  const switchConfirmation = page.getByRole('alertdialog', {
    name: 'Discard unsaved changes and switch folder?',
  })
  await expect(switchConfirmation).toBeVisible()
  await switchConfirmation.getByRole('button', { name: 'Discard and switch' }).click()
  await expect(page.getByRole('tab', { name: /renamed\.txt Unsaved changes/ })).toBeVisible()
  await expect(renamedEditor).toHaveText(unsavedContents)

  await repositoryPath.fill(nextRepo)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  await expect(switchConfirmation).toBeVisible()
  await switchConfirmation.getByRole('button', { name: 'Discard and switch' }).click()
  await expect(repositoryPath).toHaveValue(nextRepo)
  await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toHaveCount(0)
})

test('dirty repository tabs survive external file removal', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'external-draft.txt'), 'before external removal\n')
  await page.goto(app.url)
  await page.locator('[data-section="repository"]').click()
  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  await repositoryTree.getByRole('treeitem', { name: 'external-draft.txt', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'external-draft.txt' })
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('draft remains available')
  await expect(page.getByRole('tab', { name: /external-draft\.txt Unsaved changes/ })).toBeVisible()
  const mountedEditor = await editor.elementHandle()
  expect(mountedEditor).not.toBeNull()
  unlinkSync(join(app.repo, 'external-draft.txt'))
  await expect(
    repositoryTree.getByRole('treeitem', { name: 'external-draft.txt', exact: true }),
  ).toHaveCount(0)
  const draftTab = page.getByRole('tab', { name: /external-draft\.txt Unsaved changes/ })
  await expect(draftTab).toBeVisible()
  expect(await mountedEditor!.evaluate((element) => element.isConnected)).toBe(true)
  await repositoryTree.getByRole('treeitem', { name: 'main.txt', exact: true }).click()
  await draftTab.click()
  await expect(editor).toHaveText('draft remains available')
})

test('ordinary folders open in Explorer and switch back to Git', async ({ page, app }) => {
  test.setTimeout(120_000)
  const folder = join(dirname(app.repo), 'ordinary-folder')
  mkdirSync(folder)
  mkdirSync(join(folder, 'empty'))
  mkdirSync(join(folder, 'nested'))
  mkdirSync(join(folder, 'drop-target'))
  writeFileSync(join(folder, 'nested', 'child.txt'), 'nested child\n')
  writeFileSync(join(folder, 'drop-target', 'existing.txt'), 'existing\n')
  writeFileSync(join(folder, 'move-me.txt'), 'move me\n')
  writeFileSync(join(folder, 'large.bin'), Buffer.alloc(2_100_000))
  writeFileSync(join(folder, 'notes.txt'), 'folder note\n')

  await page.goto(app.url)
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.fill(folder)
  await page.getByRole('button', { name: 'Switch folder' }).click()

  await expect(folderPath).toHaveValue(folder)
  await expect(page.locator('[data-section="repository"]').locator('..')).toHaveCSS(
    'border-top-width',
    '0px',
  )
  await expect(page.getByText('Select a file from Explorer')).toBeVisible()
  await expect(page.getByPlaceholder('Commit message')).toHaveCount(0)
  await expect(page.locator('[data-section="graph"]')).toHaveCount(0)
  const explorer = page.locator('#gitna-repository-tree__tree')
  await expect(explorer.getByRole('treeitem')).toHaveCount(6)
  const nested = explorer.getByRole('treeitem', { name: 'nested', exact: true })
  await expect(nested).toHaveAttribute('aria-expanded', 'false')
  await nested.focus()
  await page.keyboard.press('ArrowRight')
  await expect(nested).toHaveAttribute('aria-expanded', 'true')
  await expect(explorer.getByRole('treeitem', { name: 'child.txt', exact: true })).toBeVisible()
  await expect(nested).toMatchAriaSnapshot('- treeitem "nested" [expanded]')
  const empty = explorer.getByRole('treeitem', { name: 'empty', exact: true })
  await empty.click()
  await expect(empty).not.toHaveAttribute('aria-expanded')

  const moveSource = explorer.getByRole('treeitem', { name: 'move-me.txt', exact: true })
  const dropTarget = explorer.getByRole('treeitem', { name: 'drop-target', exact: true })
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const targetBox = await dropTarget.boundingBox()
  expect(targetBox).not.toBeNull()
  const dragPoint = {
    clientX: targetBox!.x + targetBox!.width / 2,
    clientY: targetBox!.y + targetBox!.height / 2,
    dataTransfer,
  }
  await moveSource.dispatchEvent('dragstart', { dataTransfer })
  await dropTarget.dispatchEvent('dragenter', dragPoint)
  await dropTarget.dispatchEvent('dragover', dragPoint)
  await expect(dropTarget).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 })
  await expect(explorer.getByRole('treeitem', { name: 'existing.txt', exact: true })).toBeVisible()
  await moveSource.dispatchEvent('dragend', { dataTransfer })
  expect(existsSync(join(folder, 'move-me.txt'))).toBe(true)
  const closeMoveSource = page.getByRole('button', { name: 'Close move-me.txt' })
  if ((await closeMoveSource.count()) > 0) await closeMoveSource.click()

  await explorer.getByRole('treeitem', { name: 'large.bin', exact: true }).click()
  const fileError = page.getByRole('alert')
  await expect(fileError).toContainText('Couldn’t open file')
  await expect(fileError).toContainText('This file is too large to open in Gitna.')

  await expect(explorer.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const ordinaryPalette = page.getByRole('dialog', { name: 'Command palette' })
  await ordinaryPalette
    .getByRole('combobox', { name: 'Search files and commands' })
    .fill('child.txt')
  await ordinaryPalette.getByRole('option', { name: /child\.txt/ }).click()
  await expect(page.getByRole('textbox', { name: 'child.txt' })).toBeVisible()

  await page.getByRole('button', { name: 'Open command palette' }).click()
  await ordinaryPalette
    .getByRole('combobox', { name: 'Search files and commands' })
    .fill('notes.txt')
  await ordinaryPalette.getByRole('option', { name: /notes\.txt/ }).click()
  const editor = page.getByRole('textbox', { name: 'notes.txt' })
  await editor.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('updated folder note')
  await page.keyboard.press('Control+s')
  await expect
    .poll(() => readFileSync(join(folder, 'notes.txt'), 'utf8'))
    .toBe('updated folder note')

  await page.getByRole('button', { name: 'Close nested/child.txt' }).click()
  rmSync(join(folder, 'nested'), { recursive: true })
  await page.getByRole('button', { name: 'Refresh Explorer' }).click()
  await expect(nested).toHaveCount(0)
  await expect(explorer.getByRole('treeitem', { name: 'child.txt', exact: true })).toHaveCount(0)
  await expect(page.getByText(/directory no longer exists/i)).toHaveCount(0)
  await page.getByRole('button', { name: 'Open command palette' }).click()
  await ordinaryPalette
    .getByRole('combobox', { name: 'Search files and commands' })
    .fill('child.txt')
  await expect(ordinaryPalette.getByRole('option', { name: /child\.txt/ })).toHaveCount(0)
  await expect(ordinaryPalette.getByText('No files match.')).toBeVisible()
  await page.keyboard.press('Escape')

  await folderPath.fill(app.repo)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  await expect(page.locator('[data-section="graph"]')).toBeVisible()
})

test('wide ordinary folders page near the Explorer end with an accessible fallback', async ({
  page,
  app,
}) => {
  test.setTimeout(120_000)
  const folder = join(dirname(app.repo), 'wide-ordinary-folder')
  mkdirSync(folder)
  for (let index = 0; index < 4_105; index += 1) {
    writeFileSync(join(folder, `file-${index.toString().padStart(4, '0')}.txt`), 'content\n')
  }

  await page.goto(app.url)
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.fill(folder)
  await page.getByRole('button', { name: 'Switch folder' }).click()

  const explorer = page.locator('#gitna-repository-tree__tree')
  const loadMore = page.getByRole('button', { name: 'Load more files in wide-ordinary-folder' })
  await expect(loadMore).toBeVisible()
  expect(await explorer.getByRole('treeitem').count()).toBeLessThan(100)
  await loadMore.click()
  await expect(loadMore).toBeVisible()
  expect(await explorer.getByRole('treeitem').count()).toBeLessThan(100)
  const scroller = explorer.locator('[data-file-tree-virtualized-scroll="true"]')
  await scroller.hover()
  await page.mouse.wheel(0, 100_000)
  await expect(loadMore).toHaveCount(0)
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect(explorer.getByRole('treeitem', { name: 'file-4104.txt', exact: true })).toBeVisible()
  expect(await explorer.getByRole('treeitem').count()).toBeLessThan(100)
})

test('Gitna Home searches recent folders and protects dirty drafts', async ({ page, app }) => {
  const folder = join(dirname(app.repo), 'home-folder')
  const otherFolder = join(dirname(app.repo), 'search-parent-token', 'home-other-folder')
  mkdirSync(folder)
  mkdirSync(otherFolder, { recursive: true })
  writeFileSync(join(folder, 'notes.txt'), 'folder note\n')
  writeFileSync(join(otherFolder, 'other.txt'), 'other folder note\n')

  await page.goto(app.url)
  const capabilityUrl = page.url()
  const folderPath = page.getByRole('combobox', { name: 'Folder path' })
  await folderPath.fill(folder)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  await expect(page).toHaveTitle(`${basename(folder)} - Gitna`)
  await folderPath.fill(otherFolder)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  await expect(page).toHaveTitle(`${basename(otherFolder)} - Gitna`)
  await folderPath.fill(app.repo)
  await page.getByRole('button', { name: 'Switch folder' }).click()
  await expect(page).toHaveTitle(`${basename(app.repo)} - Gitna`)

  const repositoryHeader = page.locator('[data-section="repository"]')
  if ((await repositoryHeader.getAttribute('aria-expanded')) === 'false') {
    await repositoryHeader.click()
  }
  await page
    .locator('#gitna-repository-tree__tree')
    .getByRole('treeitem', { name: 'main.txt', exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: 'main.txt' })
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('dirty Home draft')

  await page.getByRole('button', { name: 'Open Gitna Home' }).click()
  await expect(page).toHaveURL(capabilityUrl)
  const homeTitle = page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true })
  const homeLogo = page.getByRole('img', { name: 'Gitna' })
  await expect(homeTitle).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await expect(homeTitle).toBeVisible()
  const [homeTitleBox, homeLogoBox] = await Promise.all([
    homeTitle.boundingBox(),
    homeLogo.boundingBox(),
  ])
  expect(homeTitleBox).not.toBeNull()
  expect(homeLogoBox).not.toBeNull()
  expect(
    Math.abs(homeTitleBox!.x + homeTitleBox!.width / 2 - (homeLogoBox!.x + homeLogoBox!.width / 2)),
  ).toBeLessThanOrEqual(1)
  expect(homeLogoBox!.y + homeLogoBox!.height).toBeLessThan(homeTitleBox!.y)
  expect(homeLogoBox!.width).toBeGreaterThanOrEqual(80)
  const visibleHomeLogo = homeLogo.locator('img:visible')
  await expect(visibleHomeLogo).toHaveAttribute('src', './gitna-logo-light.png')
  await expect
    .poll(() => visibleHomeLogo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(64)
  if (process.env.GITNA_CAPTURE_REVIEW_FIXES) {
    await page.screenshot({ path: '/tmp/gitna-home-logo-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '/tmp/gitna-home-logo-mobile.png', fullPage: true })
    await page.setViewportSize({ width: 1280, height: 720 })
  }
  await expect(page.getByRole('textbox', { name: 'Folder path' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Switch folder' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Display settings' })).toHaveCount(0)
  const recentFolder = page.getByRole('button').filter({ hasText: basename(folder) })
  const recentOtherFolder = page.getByRole('button').filter({ hasText: basename(otherFolder) })
  await expect(recentFolder).toContainText(folder)
  await expect(recentOtherFolder).toContainText(otherFolder)
  const recentSearch = page.getByRole('searchbox', { name: 'Search recent folders' })
  await recentSearch.fill(basename(folder))
  await expect(recentFolder).toBeVisible()
  await expect(recentOtherFolder).toHaveCount(0)
  await recentSearch.fill('search-parent-token')
  await expect(recentFolder).toHaveCount(0)
  await expect(recentOtherFolder).toBeVisible()

  const openOtherInNewTab = page.getByRole('button', {
    name: `Open ${basename(otherFolder)} in new tab`,
  })
  const removeOtherFromRecent = page.getByRole('button', {
    name: `Remove ${basename(otherFolder)} from recent folders`,
  })
  await openOtherInNewTab.focus()
  await expect(openOtherInNewTab).toBeVisible()
  await removeOtherFromRecent.focus()
  await expect(removeOtherFromRecent).toBeVisible()
  await recentOtherFolder.hover()
  await expect(openOtherInNewTab.locator('svg')).toHaveCount(1)
  await expect(removeOtherFromRecent.locator('svg')).toHaveCount(1)
  await openOtherInNewTab.hover()
  const openTooltip = page.getByRole('tooltip', { name: 'Open in New Tab' })
  await expect(openTooltip).toBeVisible()
  expect(
    await openTooltip.evaluate((element) => {
      const shadow = getComputedStyle(element).boxShadow
      if (shadow === 'none') return true
      return [...shadow.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].every(
        (match) => Number(match[1]) === 0,
      )
    }),
  ).toBe(true)

  await page.route(
    '**/api/v1/folder',
    async (route) => {
      await route.fulfill({ status: 400, json: { error: 'test route failure' } })
    },
    { times: 1 },
  )
  const failedPopupPromise = page.waitForEvent('popup')
  await openOtherInNewTab.click()
  const failedPopup = await failedPopupPromise
  await expect(page.getByRole('alert')).toContainText('test route failure')
  await expect.poll(() => failedPopup.isClosed()).toBe(true)

  let releaseFolderOpen!: () => void
  const folderOpenGate = new Promise<void>((resolve) => {
    releaseFolderOpen = resolve
  })
  await page.route(
    '**/api/v1/folder',
    async (route) => {
      await folderOpenGate
      await route.continue()
    },
    { times: 1 },
  )
  const popupPromise = page.waitForEvent('popup')
  await openOtherInNewTab.click()
  const otherPage = await popupPromise
  try {
    const loadingLogo = otherPage.locator('.brand img')
    await expect(loadingLogo).toBeVisible()
    await expect(otherPage.locator('.brand')).toHaveText('Gitna')
    await expect
      .poll(() => loadingLogo.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(64)
    await expect(
      otherPage.getByRole('heading', { name: `Opening ${basename(otherFolder)}`, exact: true }),
    ).toBeVisible()
    await expect(otherPage.getByRole('status')).toHaveText('Preparing your folder…')
    await expect(otherPage).toHaveTitle(`Opening ${basename(otherFolder)} - Gitna`)
    if (process.env.GITNA_CAPTURE_REVIEW_FIXES) {
      await otherPage.screenshot({ path: '/tmp/gitna-folder-loading-title.png', fullPage: true })
    }
  } finally {
    releaseFolderOpen()
  }
  await expect(otherPage).toHaveTitle(`${basename(otherFolder)} - Gitna`)
  await expect(otherPage).toHaveURL(/\/home-other-folder\/$/)
  await expect(
    page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true }),
  ).toBeVisible()
  await expect(page).toHaveURL(capabilityUrl)

  await page.route(
    '**/api/v1/folders/recent',
    async (route) => {
      await route.fulfill({ status: 500, json: { error: 'test removal failure' } })
    },
    { times: 1 },
  )
  await recentOtherFolder.hover()
  await removeOtherFromRecent.click()
  await expect(page.getByRole('alert')).toContainText('test removal failure')
  await expect(recentOtherFolder).toBeVisible()

  await recentOtherFolder.hover()
  await removeOtherFromRecent.click()
  await expect(recentOtherFolder).toHaveCount(0)
  await expect(recentSearch).toBeFocused()
  await otherPage.reload()
  await expect(otherPage).toHaveTitle(`${basename(otherFolder)} - Gitna`)

  await page.evaluate(async (path) => {
    const response = await fetch('api/v1/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    if (!response.ok) throw new Error(await response.text())
  }, otherFolder)
  await page.getByRole('button', { name: 'Refresh recent folders' }).click()
  await expect(recentOtherFolder).toBeVisible()
  await otherPage.close()

  const homeTrigger = page.getByRole('button', { name: 'Open Gitna Home' })
  await page.getByRole('button', { name: `Back to ${basename(app.repo)}` }).click()
  await expect(homeTrigger).toBeFocused()
  await expect(editor).toContainText('dirty Home draft')
  await homeTrigger.click()
  await recentSearch.fill(basename(folder))
  await recentSearch.press('ArrowDown')
  await expect(recentFolder).toBeFocused()
  await page.keyboard.press('Enter')
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Discard unsaved changes and switch folder?')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(
    page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true }),
  ).toBeVisible()
  await recentFolder.click()
  await confirm.getByRole('button', { name: 'Discard and switch' }).click()

  await expect(
    page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true }),
  ).toHaveCount(0)
  await expect(page).toHaveTitle(`${basename(folder)} - Gitna`)
  await expect(page.getByText('Select a file from Explorer')).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Open repository files' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Open Gitna Home' }).click()
  const recentRepository = page.getByRole('button').filter({ hasText: basename(app.repo) })
  await expect(recentRepository).toContainText(app.repo)
  await recentRepository.click()
  await expect(
    page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true }),
  ).toHaveCount(0)
  await expect(page).toHaveTitle(`${basename(app.repo)} - Gitna`)

  await page.getByRole('button', { name: 'Open Gitna Home' }).click()
  const openPath = page.getByPlaceholder('/path/to/folder')
  const missing = join(dirname(app.repo), 'missing-home-folder')
  await openPath.fill(missing)
  await page.getByRole('button', { name: 'Open Folder' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(openPath).toHaveValue(missing)
  await expect(
    page.getByRole('heading', { name: 'Welcome back to Gitna', exact: true }),
  ).toBeVisible()
  await expect(page).toHaveTitle(`${basename(app.repo)} - Gitna`)
})

test('repository explorer shows and independently hides hidden and ignored files', async ({
  page,
  app,
}) => {
  const ignored = join(app.repo, 'ignored')
  mkdirSync(ignored)
  writeFileSync(join(app.repo, '.visible-hidden'), 'hidden\n')
  writeFileSync(join(app.repo, '.ignored-hidden'), 'ignored hidden\n')
  writeFileSync(join(ignored, 'generated.js'), 'generated\n')
  writeFileSync(join(app.repo, '.git', 'info', 'exclude'), '.ignored-hidden\nignored/\n')

  await page.goto(app.url)
  await page.locator('[data-section="repository"]').click()
  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const visibleHidden = repositoryTree.getByRole('treeitem', {
    name: '.visible-hidden',
    exact: true,
  })
  const ignoredFolder = repositoryTree.getByRole('treeitem', { name: 'ignored', exact: true })

  await expect(visibleHidden).toBeVisible()
  await expect(ignoredFolder).toBeVisible()

  await page.getByRole('button', { name: 'Explorer actions' }).click()
  const showHidden = page.getByRole('menuitemcheckbox', { name: 'Show hidden files' })
  const showIgnored = page.getByRole('menuitemcheckbox', { name: 'Show ignored files' })
  await expect(showHidden).toBeChecked()
  await expect(showIgnored).toBeChecked()

  await showHidden.click()
  await expect(showHidden).not.toBeChecked()
  await expect(showIgnored).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(visibleHidden).toHaveCount(0)
  await expect(ignoredFolder).toBeVisible()

  await page.getByRole('button', { name: 'Explorer actions' }).click()
  await showIgnored.click()
  await expect(showIgnored).not.toBeChecked()
  await page.keyboard.press('Escape')
  await expect(ignoredFolder).toHaveCount(0)

  await page.getByRole('button', { name: 'Explorer actions' }).click()
  await showHidden.click()
  await showIgnored.click()
  await page.keyboard.press('Escape')
  await expect(visibleHidden).toBeVisible()
  await expect(ignoredFolder).toBeVisible()
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

  await page.getByRole('button', { name: 'Explorer actions' }).click()
  await page.getByRole('menuitem', { name: 'Collapse all folders' }).click()
  await expect(
    page.locator('#gitna-repository-tree__tree').getByRole('treeitem', {
      name: 'clean.txt',
      exact: true,
    }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Explorer actions' }).click()
  await page.getByRole('menuitem', { name: 'Expand all folders' }).click()

  await page.getByRole('button', { name: 'Explorer actions' }).click()
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

  const changesTree = page.locator('#gitna-unstaged-tree__tree')
  const changesVirtualScroll = changesTree.locator('[data-file-tree-virtualized-scroll="true"]')
  await expect(changesVirtualScroll).toBeVisible()
  await expect.poll(() => changesTree.getByRole('treeitem').count()).toBeLessThan(200)
  expect(
    await changesVirtualScroll.evaluate((element) => element.scrollHeight / element.clientHeight),
  ).toBeGreaterThan(10)
  const stagedSection = page
    .locator('[data-section="staged"]')
    .locator('xpath=ancestor::section[1]')
  const stagedBox = await stagedSection.boundingBox()
  expect(stagedBox).not.toBeNull()
  expect(stagedBox!.height).toBeLessThan(160)

  const repositoryBody = page.locator('[data-pane-body="repository"]')
  const repositoryTree = page.locator('#gitna-repository-tree__tree')
  const repositoryVirtualScroll = repositoryTree.locator(
    '[data-file-tree-virtualized-scroll="true"]',
  )
  await expect(repositoryBody).toHaveCSS('overflow-y', 'hidden')
  await expect(repositoryVirtualScroll).toBeVisible()
  const virtualizedFolder = repositoryTree.getByRole('treeitem', {
    name: 'virtualized-files',
    exact: true,
  })
  await virtualizedFolder.click()
  await expect(virtualizedFolder).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => repositoryTree.getByRole('treeitem').count()).toBeLessThan(200)
  expect(
    await repositoryVirtualScroll.evaluate(
      (element) => element.scrollHeight / element.clientHeight,
    ),
  ).toBeGreaterThan(10)

  await page.locator('[data-section="staged"]').click()
  await page.locator('[data-section="changes"]').click()
  await expect
    .poll(
      async () => (await page.locator('[data-pane="source-control"]').boundingBox())?.height ?? 0,
    )
    .toBeLessThan(300)
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
  await expect(page.getByRole('menu')).toHaveCSS('box-shadow', 'none')
  await expect(page.getByText('Backgrounds', { exact: true })).toBeVisible()
  await expect(page.getByText('Line numbers', { exact: true })).toBeVisible()
  await expect(page.getByText('Local browser-based Git workbench', { exact: true })).toHaveCount(0)
  const appVersion = await page.evaluate(async () => {
    const response = await fetch('api/v1/snapshot')
    if (!response.ok) throw new Error(`snapshot request failed: ${response.status}`)
    return ((await response.json()) as { appVersion: string }).appVersion
  })
  await expect(page.locator('[data-gitna-version]')).toHaveText(
    appVersion === 'dev' ? 'dev' : `v${appVersion}`,
  )
  await expect(page.getByRole('link', { name: 'GitHub repository' })).toHaveAttribute(
    'href',
    'https://github.com/roie/gitna',
  )
  const npmPackageLink = page.getByRole('link', { name: 'npm package' })
  await expect(npmPackageLink).toHaveAttribute('href', 'https://www.npmjs.com/package/gitna')
  await expect(npmPackageLink.locator('svg path')).toHaveCount(1)
  await expect(npmPackageLink.locator('svg path')).toHaveAttribute('fill', 'currentColor')
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
  expect(unstaged.supplements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'modified.txt' }),
      expect.objectContaining({ path: 'two-hunk.txt' }),
      expect.objectContaining({ path: 'untracked.txt', kind: 'untracked' }),
      expect.objectContaining({
        path: 'large-untracked.txt',
        diff: expect.objectContaining({ tooLarge: true }),
      }),
    ]),
  )

  expect(staged.identity.scope).toBe('staged')
  expect(staged.supplements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'staged.txt' }),
      expect.objectContaining({ path: 'rename-new.txt', kind: 'renamed' }),
      expect.objectContaining({ path: 'delete.txt', kind: 'deleted' }),
    ]),
  )

  expect(commit.identity.commit).toBe(app.headOid)
  expect(commit.supplements).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'feature.txt' })]),
  )

  expect(compare.identity.from).toBe(app.baseOid)
  expect(compare.identity.to).toBe(app.headOid)
  expect(compare.supplements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'main.txt' }),
      expect.objectContaining({ path: 'feature.txt' }),
    ]),
  )
  expect(
    new Set([unstaged.generation, staged.generation, commit.generation, compare.generation]).size,
  ).toBe(1)
})
