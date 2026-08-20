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
  const changes = page
    .locator('.section-header')
    .filter({ has: page.locator('.section-title', { hasText: /^Changes$/ }) })
  const staged = page
    .locator('.section-header')
    .filter({ has: page.locator('.section-title', { hasText: /^Staged Changes$/ }) })
  await expect(changes).toBeVisible()
  await expect(staged).toBeVisible()
  await expect(changes).toHaveAttribute('aria-expanded', 'true')
  await expect(staged).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.section-title', { hasText: /^Graph$/ })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: 'modified.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('treeitem', { name: 'staged.txt', exact: true })).toBeVisible()
  await expect(page.getByText('merge feature', { exact: true })).toBeVisible()
})

test('bounded review contract serves all scopes from the real repository', async ({
  request,
  app,
}) => {
  const unstaged = await readReview(request, new URL('api/v1/review?scope=unstaged', app.url).href)
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

  const staged = await readReview(request, new URL('api/v1/review?scope=staged', app.url).href)
  expect(staged.identity.scope).toBe('staged')
  expect(staged.patch).toContain('diff --git a/staged.txt b/staged.txt')
  expect(staged.patch).toContain('rename to rename-new.txt')
  expect(staged.patch).toContain('deleted file mode')

  const commit = await readReview(
    request,
    new URL(`api/v1/review?scope=commit&commit=${app.headOid}`, app.url).href,
  )
  expect(commit.identity.commit).toBe(app.headOid)
  expect(commit.patch).toContain('feature.txt')

  const compare = await readReview(
    request,
    new URL(`api/v1/review?scope=compare&from=${app.baseOid}&to=${app.headOid}`, app.url).href,
  )
  expect(compare.identity.from).toBe(app.baseOid)
  expect(compare.identity.to).toBe(app.headOid)
  expect(compare.patch).toContain('main.txt')
  expect(compare.patch).toContain('feature.txt')
  expect(
    new Set([unstaged.generation, staged.generation, commit.generation, compare.generation]).size,
  ).toBe(1)
})
