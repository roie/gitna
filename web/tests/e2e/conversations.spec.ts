import { execFileSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test, type GitnaFixture } from './fixtures.js'

interface StoredConversation {
  id: string
  status: string
  anchor: Record<string, unknown>
  messages: { body: string; author: { id: string } }[]
}

async function stored(page: Page, app: Pick<GitnaFixture, 'url'>): Promise<StoredConversation[]> {
  const response = await page.request.get(new URL('api/v1/conversations', app.url).href)
  return ((await response.json()) as { conversations: StoredConversation[] }).conversations
}

function gitnaCLI(app: Pick<GitnaFixture, 'repo'>, ...args: string[]): string {
  const config = join(dirname(app.repo), 'config')
  return execFileSync(
    process.env.GITNA_E2E_BINARY!,
    ['conversations', ...args, '--repo', app.repo],
    { encoding: 'utf8', env: { ...process.env, APPDATA: config, XDG_CONFIG_HOME: config } },
  )
}

const agentIDs = new Map<string, string>()

/** Runs a command as the test's agent, joining once per repository. */
function agent(app: Pick<GitnaFixture, 'repo'>, ...args: string[]): string {
  let id = agentIDs.get(app.repo)
  if (id == null) {
    id = (JSON.parse(gitnaCLI(app, 'join', '--as', 'e2e-agent')) as { participant: { id: string } })
      .participant.id
    agentIDs.set(app.repo, id)
  }
  return gitnaCLI(app, ...args, '--participant', id)
}

async function openFile(page: Page, path: string) {
  await page.getByRole('button', { name: 'Open command palette' }).click()
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
  await palette
    .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
    .click()
}

/** Starts a conversation from the gutter button, dragging to `last` for a range. */
async function comment(page: Page, first: Locator, last: Locator | null, body: string) {
  await first.hover()
  const button = page.locator('[data-utility-button]')
  await button.hover()
  await page.mouse.down()
  if (last != null) {
    const box = (await last.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  }
  await page.mouse.up()
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  await draft.fill(body)
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
}

test('conversations on a file persist, take replies from an agent, and survive a restart', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await expect(number(5)).toBeVisible()

  await comment(page, number(5), null, 'Why line five?')
  await comment(page, number(7), number(9), 'These three belong together')

  const anchors = (await stored(page, app)).map(({ anchor }) => anchor)
  expect(anchors).toMatchObject([
    {
      path: 'two-hunk.txt',
      view: 'file',
      source: 'worktree',
      revision: app.headOid,
      startLine: 5,
      endLine: 5,
      code: 'line 5',
      before: 'TWO\nline 3\nline 4',
      after: 'line 6\nline 7\nline 8',
    },
    { startLine: 7, endLine: 9, code: 'line 7\nline 8\nline 9' },
  ])

  const thread = page.getByRole('article').filter({ hasText: 'Why line five?' })
  await thread.getByRole('textbox', { name: 'Reply…' }).fill('Second message')
  await thread.getByRole('textbox', { name: 'Reply…' }).press('Control+Enter')
  await expect(thread.getByText('Second message')).toBeVisible()

  // The agent reads its inbox and answers in the same conversation, live.
  const pending = JSON.parse(agent(app, 'pending')) as {
    pending: { conversation: { id: string }; message: { seq: number; body: string } }[]
  }
  expect(pending.pending.map(({ message }) => message.body)).toEqual([
    'Why line five?',
    'These three belong together',
    'Second message',
  ])
  const id = pending.pending[0].conversation.id
  agent(app, 'reply', id, '--id', 'm-agent-answer', '--body', 'Agent answer\nwith two lines')
  await expect(thread.getByText('Agent answer')).toBeVisible()
  await expect(thread.getByText('e2e-agent')).toBeVisible()
  // No donor demo identity is ever shown.
  await expect(page.locator('img[src*="diffshub-avatars"]')).toHaveCount(0)

  // The thread header collapses it to a one-line summary and back.
  await thread.getByRole('button', { expanded: true }).click()
  const summary = page.getByRole('button', { expanded: false, name: /Why line five\?/ })
  await expect(summary).toBeVisible()
  await expect(thread).toHaveCount(0)
  await summary.click()
  await expect(thread.getByText('Agent answer')).toBeVisible()
  // No status or kind labels are shown.
  await expect(thread.getByText(/^(Open|Resolved|agent)$/)).toHaveCount(0)

  // Unacknowledged messages stay in the agent's inbox across a Gitna restart.
  const restarted = await app.restart()
  expect(
    (JSON.parse(agent(app, 'pending')) as typeof pending).pending.map(({ message }) => message.seq),
  ).toEqual(pending.pending.map(({ message }) => message.seq))

  await page.goto(restarted.url)
  await openFile(page, 'two-hunk.txt')
  await expect(page.getByRole('article').filter({ hasText: 'Why line five?' })).toContainText(
    'Agent answer',
  )
  await expect(
    page.getByRole('article').filter({ hasText: 'These three belong together' }),
  ).toBeVisible()
  const [first] = await stored(page, restarted)
  expect(first).toMatchObject({ id, status: 'open' })
  expect(first.messages.map(({ author }) => author.id)).toEqual([
    'human:local',
    'human:local',
    agentIDs.get(app.repo),
  ])
})

test('diff conversations anchor to the content on the commented side', async ({ page, app }) => {
  await page.goto(app.url)
  const item = (text: string) => page.locator('diffs-container', { hasText: text })
  const number = (text: string, line: number, side: 'first' | 'last') =>
    item(text).locator(`[data-column-number="${line}"]`)[side]()

  // Unstaged diff: old side is the index, new side is the worktree.
  await expect(number('unstaged change', 1, 'last')).toBeVisible()
  await comment(page, number('unstaged change', 1, 'last'), null, 'worktree side')
  await comment(page, number('unstaged change', 1, 'first'), null, 'index side')

  // Staged diff: old side is HEAD, new side is the index.
  await page
    .getByRole('region', { name: 'Source Control workflow' })
    .getByRole('treeitem', { name: 'staged.txt' })
    .first()
    .click()
  await expect(number('staged change', 1, 'last')).toBeVisible()
  await comment(page, number('staged change', 1, 'last'), null, 'staged side')
  await comment(page, number('staged change', 1, 'first'), null, 'head side')

  expect(
    (await stored(page, app)).map(({ anchor, messages }) => [messages[0].body, anchor]),
  ).toMatchObject([
    [
      'worktree side',
      { view: 'worktree', source: 'worktree', side: 'additions', code: 'unstaged change' },
    ],
    ['index side', { view: 'worktree', source: 'index', side: 'deletions', code: 'base' }],
    ['staged side', { view: 'index', source: 'index', side: 'additions', code: 'staged change' }],
    [
      'head side',
      { view: 'index', source: 'commit', revision: app.headOid, side: 'deletions', code: 'base' },
    ],
  ])

  // A worktree conversation shows wherever that file's worktree content does.
  await openFile(page, 'modified.txt')
  await expect(page.getByRole('article').filter({ hasText: 'worktree side' })).toBeVisible()
  await expect(page.getByRole('article').filter({ hasText: 'index side' })).toHaveCount(0)
})

test('the repository pane lists conversations; resolve hides them and delete can be undone', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const item = (text: string) => page.locator('diffs-container', { hasText: text })
  const line = item('unstaged change').locator('[data-column-number="1"]').last()
  await expect(line).toBeVisible()
  await comment(page, line, null, 'resolve me')
  const thread = page.getByRole('article').filter({ hasText: 'resolve me' })
  await expect(thread).toBeVisible()

  // Resolving hides the thread from the code; the Resolved filter can reopen it.
  await thread.hover()
  await thread.getByRole('button', { name: 'Resolve conversation' }).click()
  await expect(thread).toHaveCount(0)

  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  await pane.getByRole('button', { name: 'Conversations', exact: true }).click()
  const list = (text: string) => pane.getByRole('button', { name: new RegExp(text) })
  await expect(list('resolve me')).toHaveCount(0)
  await pane.getByRole('button', { name: 'Filter conversations' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Resolved' }).click()
  await page.keyboard.press('Escape')
  await expect(list('resolve me')).toBeVisible()
  await list('resolve me').hover()
  await pane.getByRole('button', { name: 'Reopen conversation' }).click()
  await expect(thread).toBeVisible()

  // Deleting removes it everywhere until Undo restores it.
  await thread.hover()
  await thread.getByRole('button', { name: 'Delete conversation' }).click()
  await expect(thread).toHaveCount(0)
  expect(await stored(page, app)).toEqual([])
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(thread).toBeVisible()
  expect((await stored(page, app)).map(({ messages }) => messages[0].body)).toEqual(['resolve me'])

  await thread.hover()
  await thread.getByRole('button', { name: 'Delete conversation' }).click()
  await expect(thread).toHaveCount(0)
  // The agent still receives the message, flagged, so a later restore loses nothing.
  const pending = JSON.parse(agent(app, 'pending')) as {
    pending: { conversation: { deleted?: boolean } }[]
  }
  expect(pending.pending.map(({ conversation }) => conversation.deleted)).toEqual([true])
})

test('clean files, commits, ref comparisons and file comparisons anchor to their content', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const lineIn = (text: string, side: 'first' | 'last') =>
    page.locator('diffs-container', { hasText: text }).locator('[data-column-number="1"]')[side]()

  // A clean file is the worktree content at HEAD.
  await openFile(page, 'feature.txt')
  await expect(lineIn('feature branch', 'last')).toBeVisible()
  await comment(page, lineIn('feature branch', 'last'), null, 'clean file')

  // A commit diff: both sides are commits.
  await page.locator('[data-section="graph"]').click()
  const row = page.locator('.graph-row').filter({
    has: page.getByRole('button', { name: /^main change/ }),
  })
  await row.locator('[data-graph-disclosure]').click()
  await row.getByRole('treeitem', { name: 'main.txt', exact: true }).click()
  await expect(lineIn('main branch', 'last')).toBeVisible()
  await comment(page, lineIn('main branch', 'last'), null, 'commit new')
  await comment(page, lineIn('main branch', 'first'), null, 'commit old')

  // A ref comparison.
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Compare refs…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare references', exact: true })
  await dialog.getByRole('combobox', { name: 'Compare to', exact: true }).selectOption('feature')
  await dialog.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(dialog.getByText(/changed files loaded/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await expect(lineIn('main branch', 'last')).toBeVisible()
  await comment(page, lineIn('main branch', 'first'), null, 'compare left')
  await comment(page, lineIn('main branch', 'last'), null, 'compare right')

  // An Explorer file-to-file comparison.
  const tree = page.locator('#gitna-repository-tree__tree')
  if (!(await tree.isVisible())) await page.locator('[data-section="repository"]').click()
  await tree.getByRole('treeitem', { name: 'main.txt', exact: true }).click()
  await tree
    .getByRole('treeitem', { name: 'feature.txt', exact: true })
    .click({ modifiers: ['Control'] })
  await tree.getByRole('treeitem', { name: 'main.txt', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Compare Selected', exact: true }).click()
  await expect(page.locator('[data-comparison-tab="true"]')).toBeVisible()
  await comment(page, lineIn('feature branch', 'first'), null, 'files left')
  await comment(page, lineIn('feature branch', 'last'), null, 'files right')

  expect(
    (await stored(page, app)).map(({ anchor, messages }) => [messages[0].body, anchor]),
  ).toMatchObject([
    [
      'clean file',
      { path: 'feature.txt', view: 'file', source: 'worktree', code: 'feature branch' },
    ],
    [
      'commit new',
      {
        path: 'main.txt',
        view: 'commit',
        source: 'commit',
        side: 'additions',
        code: 'main branch',
      },
    ],
    [
      'commit old',
      { path: 'main.txt', view: 'commit', source: 'commit', side: 'deletions', code: 'main base' },
    ],
    [
      'compare left',
      {
        view: 'comparison',
        source: 'commit',
        revision: app.headOid,
        side: 'deletions',
        code: 'main branch',
      },
    ],
    [
      'compare right',
      { view: 'comparison', source: 'commit', side: 'additions', code: 'main base' },
    ],
    [
      'files left',
      {
        path: 'main.txt',
        view: 'file',
        source: 'worktree',
        side: 'deletions',
        code: 'main branch',
      },
    ],
    [
      'files right',
      {
        path: 'feature.txt',
        view: 'file',
        source: 'worktree',
        side: 'additions',
        code: 'feature branch',
      },
    ],
  ])

  // After a reload, the pane reopens each conversation where it was made.
  await page.reload()
  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  await pane.getByRole('button', { name: 'Conversations', exact: true }).click()
  for (const body of ['commit new', 'compare right', 'clean file']) {
    await pane.getByRole('button', { name: new RegExp(body) }).click()
    await expect(page.getByRole('article').filter({ hasText: body })).toBeVisible()
  }
})

test('selections across diff sides and unsaved code are refused with a visible reason', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await page.getByRole('button', { name: 'Switch to unified view' }).click()
  const hunk = page.locator('diffs-container', { hasText: 'FIFTY' })
  // Unified view lists line 2's deletion, then its addition.
  const deleted = hunk.locator('[data-column-number="2"][data-line-type="change-deletion"]').first()
  const added = hunk.locator('[data-column-number="2"][data-line-type="change-addition"]').first()
  await expect(deleted).toBeVisible()
  await deleted.hover()
  await page.locator('[data-utility-button]').hover()
  await page.mouse.down()
  const box = (await added.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(
    page.getByText('Select lines on one side of the diff to start a conversation.'),
  ).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Add a comment…' })).toHaveCount(0)

  // Code the reader has not saved would be outdated the moment it was posted.
  await openFile(page, 'main.txt')
  const editor = page.getByRole('textbox', { name: 'main.txt', exact: true })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('unsaved line')
  const number = page.locator('[data-file] [data-column-number="2"]')
  await number.hover()
  await page.locator('[data-utility-button]').click()
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  await draft.fill('about the new line')
  await draft.press('Control+Enter')
  await expect(page.getByText('Save main.txt before starting a conversation on it.')).toBeVisible()
  expect(await stored(page, app)).toEqual([])

  await editor.press('Control+s')
  await expect
    .poll(() => readFileSync(join(app.repo, 'main.txt'), 'utf8'))
    .toContain('unsaved line')
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  const [conversation] = await stored(page, app)
  expect(conversation.anchor).toMatchObject({ startLine: 2, code: 'unsaved line' })
  expect((conversation as { location?: { status: string } }).location?.status).toBe('current')
})

test('conversations follow edited, moved and deleted code and keep the original when it changes', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await openFile(page, 'two-hunk.txt')
  await expect(number(5)).toBeVisible()
  await comment(page, number(5), null, 'follow me')
  await openFile(page, 'main.txt')
  await expect(number(1)).toBeVisible()
  await comment(page, number(1), null, 'renamed without git')
  await openFile(page, 'feature.txt')
  await expect(number(1)).toBeVisible()
  await comment(page, number(1), null, 'deleted file')

  const twoHunk = join(app.repo, 'two-hunk.txt')
  writeFileSync(twoHunk, 'new 1\nnew 2\nnew 3\n' + readFileSync(twoHunk, 'utf8'))
  renameSync(join(app.repo, 'main.txt'), join(app.repo, 'main-moved.txt'))
  rmSync(join(app.repo, 'feature.txt'))
  const locations = async () =>
    Object.fromEntries(
      (await stored(page, app)).map((conversation) => [
        conversation.messages[0].body,
        (conversation as { location?: unknown }).location,
      ]),
    )
  expect(await locations()).toMatchObject({
    'follow me': { path: 'two-hunk.txt', startLine: 8, status: 'moved' },
    'renamed without git': { path: 'main-moved.txt', startLine: 1, status: 'current' },
    'deleted file': { path: 'feature.txt', status: 'missing' },
  })

  await page.reload()
  await openFile(page, 'main-moved.txt')
  await expect(page.getByRole('article').filter({ hasText: 'renamed without git' })).toBeVisible()
  await openFile(page, 'two-hunk.txt')
  const followed = page.getByRole('article').filter({ hasText: 'follow me' })
  await expect(followed).toBeVisible()
  await expect(followed.locator('pre')).toHaveCount(0)

  // Once the line itself changes, the thread keeps the code it was about.
  writeFileSync(twoHunk, readFileSync(twoHunk, 'utf8').replace('line 5\n', 'line five\n'))
  expect(await locations()).toMatchObject({ 'follow me': { status: 'outdated' } })
  await page.reload()
  await openFile(page, 'two-hunk.txt')
  await expect(followed.locator('pre')).toHaveText('line 5')

  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  await pane.getByRole('button', { name: 'Conversations', exact: true }).click()
  await expect(pane.getByRole('button', { name: /deleted file/ })).toBeVisible()
})

test('unread replies are marked until read and live updates keep the reading position', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await openFile(page, 'two-hunk.txt')
  await expect(number(3)).toBeVisible()
  await comment(page, number(3), null, 'above the fold')
  const [first] = await stored(page, app)

  // Collapsed threads and the pane button show unread replies.
  const thread = page.getByRole('article').filter({ hasText: 'above the fold' })
  await thread.getByRole('button', { expanded: true }).click()
  agent(app, 'reply', first.id, '--id', 'm-agent-reply', '--body', 'Agent reply')
  const summary = page.getByRole('button', { expanded: false, name: /above the fold/ })
  await expect(summary.getByRole('img', { name: 'Unread' })).toBeVisible()
  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  const toggle = pane.getByRole('button', { name: 'Conversations', exact: true })
  await expect(toggle.getByRole('img', { name: 'Unread' })).toBeVisible()
  await summary.click()
  await expect(thread.getByText('Agent reply')).toBeVisible()
  await expect(toggle.getByRole('img', { name: 'Unread' })).toHaveCount(0)

  // A reply growing a thread above the viewport does not move what is being read.
  await page.locator('[data-file]').first().hover()
  while (!(await number(40).isVisible())) await page.mouse.wheel(0, 200)
  await page.mouse.wheel(0, 200)
  const reading = page.locator('[data-file] [data-line]', { hasText: /^line 40$/ })
  const before = (await reading.boundingBox())!.y
  agent(
    app,
    'reply',
    first.id,
    '--id',
    'm-agent-longer',
    '--body',
    'A longer agent reply\nthat adds\nseveral lines\nabove',
  )
  await expect(thread.getByText('several lines')).toBeAttached()
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  expect(Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(2)
})
