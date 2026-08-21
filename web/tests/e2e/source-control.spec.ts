import type { APIRequestContext } from '@playwright/test'
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

test('real binary renders repository source-control state', async ({ page, app }) => {
  const response = await page.goto(app.url)
  expect(response?.status()).toBe(200)
  await expect(page.getByPlaceholder('Commit message')).toBeVisible()
  const repository = page.locator('[data-section="repository"]')
  const workflow = page.locator('[data-section="workflow"]')
  const changes = page.locator('[data-section="changes"]')
  const staged = page.locator('[data-section="staged"]')
  await expect(repository).toBeVisible()
  await expect(repository).toContainText('repo')
  await expect(workflow).toBeVisible()
  await expect(workflow).toContainText('Source Control')
  await expect(changes).toBeVisible()
  await expect(staged).toBeVisible()
  await expect(changes).toHaveAttribute('aria-expanded', 'true')
  await expect(staged).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.section-title', { hasText: /^Graph$/ })).toBeVisible()
  await expect(
    page.locator('#gitna-unstaged-tree__tree').getByRole('treeitem', {
      name: 'modified.txt',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.locator('#gitna-staged-tree__tree').getByRole('treeitem', {
      name: 'staged.txt',
      exact: true,
    }),
  ).toBeVisible()
  const headCommit = page.getByRole('button', { name: /^merge feature/ })
  await expect(headCommit).toContainText('main')
  await expect(headCommit).not.toContainText('Gitna E2E')
  await expect(headCommit).not.toContainText(app.headOid.slice(0, 8))
  await expect(page.getByText('base fixture', { exact: true })).toBeVisible()
  await expect(page.locator('.workflow-scroll')).toHaveClass(/cv-mini-scrollbar/)
  await page.getByRole('button', { name: /^base fixture/ }).click()
  const graphTree = page.locator('[id^="gitna-graph-"][id$="__tree"]')
  await expect(
    graphTree.getByRole('treeitem', {
      name: 'modified.txt',
      exact: true,
    }),
  ).toBeVisible()
  expect(
    await graphTree.evaluate((tree) => tree.scrollHeight - tree.clientHeight),
  ).toBeLessThanOrEqual(1)
  if (process.env.GITNA_CAPTURE_GRAPH) {
    await graphTree.getByRole('treeitem').last().scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/gitna-graph-refined.png', fullPage: true })
  }
})

test('embedded binary serves the pinned DiffsHub React frontend', async ({ page, app }) => {
  const response = await page.goto(app.url)
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('img', { name: 'DiffsHub' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Collapse all files' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Theme settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Display settings' })).toBeVisible()
  await expect(page.locator('diffs-container').first()).toBeVisible({ timeout: 30_000 })
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
