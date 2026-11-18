import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { expect, startGitna, stopGitna, test, type GitnaFixture } from './fixtures.js'

test.beforeEach(async ({ page, app }, info) => {
  if (info.title === 'conversations are off until enabled') return
  const response = await page.request.put(new URL('api/v1/preferences', app.url).href, {
    headers: { Origin: app.origin },
    data: { key: 'gitna:conversations', value: 'true' },
  })
  expect(response.status()).toBe(204)
})

test('conversations are off until enabled', async ({ page, app }) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (/\/conversations(?:\?|\/events|$)/.test(new URL(request.url()).pathname))
      requests.push(request.url())
  })
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await page.getByRole('button', { name: 'Display settings' }).click()
  await expect(page.getByRole('switch', { name: 'Conversations' })).not.toBeChecked()
  expect(requests).toEqual([])
  await page.getByRole('switch', { name: 'Conversations' }).click()
  await page.keyboard.press('Escape')
  await expect.poll(() => requests.length).toBeGreaterThan(0)
})

interface StoredConversation {
  id: string
  status: string
  anchor: Record<string, unknown>
  messages: { body: string; author: { id: string } }[]
  runs?: { state: string; participantId: string }[]
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
    { encoding: 'utf8', env: { ...process.env, GITNA_HOME: config } },
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

test('the first conversation reaches another Gitna process without a reload', async ({
  page,
  app,
  context,
}) => {
  const second = await startGitna(process.env.GITNA_E2E_BINARY!, app.repo)
  try {
    const other = await context.newPage()
    await page.goto(app.url)
    await other.goto(second.url)
    await openFile(page, 'two-hunk.txt')
    await openFile(other, 'two-hunk.txt')
    const base = join(dirname(app.repo), 'config', 'conversations', 'v2')
    expect(readdirSync(base)).toEqual([])
    const line = page.locator('[data-file] [data-column-number="5"]')
    await expect(line).toBeVisible()
    await comment(page, line, null, 'First event from another process')
    await expect(
      other.getByRole('article').filter({ hasText: 'First event from another process' }),
    ).toBeVisible()
    expect(
      readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory()),
    ).toHaveLength(1)
    await other.close()
  } finally {
    await stopGitna(second.child)
  }
})

test('conversations on a file persist, take replies from an agent, and survive a restart', async ({
  page,
  app,
}) => {
  agent(app, 'session')
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await expect(number(5)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'To' })).toHaveCount(0)

  await comment(page, number(5), null, '@e2e-agent Why line five?')
  await comment(page, number(7), number(9), '@e2e-agent These three belong together')

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
  await thread.getByRole('textbox', { name: 'Reply…' }).fill('@e2e-agent Second message')
  await thread.getByRole('textbox', { name: 'Reply…' }).press('Control+Enter')
  await expect(thread.getByRole('textbox', { name: 'Reply…' })).toHaveValue('@e2e-agent ')
  await expect(thread.getByText('@e2e-agent Second message')).toBeVisible()

  // The agent reads its inbox and answers in the same conversation, live.
  const pending = JSON.parse(agent(app, 'pending')) as {
    pending: { conversation: { id: string }; message: { seq: number; body: string } }[]
  }
  expect(pending.pending.map(({ message }) => message.body)).toEqual([
    '@e2e-agent Why line five?',
    '@e2e-agent These three belong together',
    '@e2e-agent Second message',
  ])
  const id = pending.pending[0].conversation.id
  agent(app, 'reply', id, '--id', 'm-agent-answer', '--body', 'Agent **answer**\n\n- with a list')
  await expect(thread.getByText('Agent answer')).toBeVisible()
  await expect(thread.locator('strong', { hasText: 'answer' })).toBeVisible()
  await expect(thread.getByRole('listitem')).toHaveText('with a list')
  await expect(thread.locator('strong', { hasText: /^e2e-agent$/ })).toBeVisible()
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
  const item = (text: string) =>
    page.locator('diffs-container').filter({ has: page.getByText(text, { exact: true }) })
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

  // Once the unstaged change is discarded there is no diff for the index
  // side; the conversation opens on the file, which shows the same code.
  execFileSync('git', ['-C', app.repo, 'checkout', '--', 'modified.txt'])
  await page.reload()
  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  await pane.getByRole('button', { name: 'Conversations', exact: true }).click()
  await pane.getByRole('button', { name: /index side/ }).click()
  await expect(page.getByRole('article').filter({ hasText: 'index side' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'modified.txt' })).toBeVisible()
  // Navigation found it; the conversation still belongs to the index.
  const indexSide = (await stored(page, app)).find(
    ({ messages }) => messages[0].body === 'index side',
  )
  expect(indexSide).toMatchObject({ anchor: { view: 'worktree', source: 'index' } })
  expect((indexSide as { location?: { source?: string } }).location?.source).toBeUndefined()
})

test('the repository pane lists conversations; resolve hides them and delete can be undone', async ({
  page,
  app,
}) => {
  agent(app, 'session')
  await page.goto(app.url)
  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  // The toggle appears with the first conversation; its count shows only open ones.
  const toggle = pane.getByRole('button', { name: 'Conversations', exact: true })
  await expect(pane.locator('[data-section="repository"]')).toBeVisible()
  await expect(toggle).toHaveCount(0)
  const item = (text: string) => page.locator('diffs-container', { hasText: text })
  const line = item('unstaged change').locator('[data-column-number="1"]').last()
  await expect(line).toBeVisible()
  await comment(page, line, null, '@e2e-agent resolve me')
  await expect(toggle).toHaveText('1')
  const thread = page.getByRole('article').filter({ hasText: 'resolve me' })
  await expect(thread).toBeVisible()

  // Resolving hides the thread from the code; the Resolved filter can reopen it.
  await thread.hover()
  await thread.getByRole('button', { name: 'Resolve conversation' }).click()
  await expect(thread).toHaveCount(0)
  await expect(toggle).toHaveText('')

  await toggle.click()
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
  await expect(toggle).toHaveCount(0)
  expect(await stored(page, app)).toEqual([])
  const pending = () =>
    (JSON.parse(agent(app, 'pending')) as { pending: { message: { body: string } }[] }).pending.map(
      ({ message }) => message.body,
    )
  expect(pending()).toEqual([])
  // An acknowledgment while it is deleted does not discard the message.
  agent(app, 'ack', '1000')
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(thread).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect((await stored(page, app)).map(({ messages }) => messages[0].body)).toEqual([
    '@e2e-agent resolve me',
  ])
  expect(pending()).toEqual(['@e2e-agent resolve me'])
})

test('a draft shows its caret and moves to another line from the gutter', async ({ page, app }) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await expect(number(12)).toBeVisible()

  await number(12).hover()
  await page.locator('[data-utility-button]').click()
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  await expect(draft).toBeFocused()
  // The editable code view hides the native caret; the draft must not inherit that.
  expect(await draft.evaluate((element) => getComputedStyle(element).caretColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  )

  await number(15).hover()
  const utility = page.locator('[data-utility-button]')
  await expect(number(15).locator('[data-utility-button]')).toHaveCount(1)
  await utility.click()
  await expect(draft).toHaveCount(1)
  await draft.fill('moved here')
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  expect((await stored(page, app)).map(({ anchor }) => anchor.startLine)).toEqual([15])
})

test('a draft closes from its corner button, asking only when it has text', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  const number = page.locator('[data-file] [data-column-number="12"]')
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  const discard = page.getByRole('button', { name: 'Discard comment' })
  let prompts = 0
  page.on('dialog', (dialog) => {
    prompts++
    void dialog.accept()
  })

  await number.hover()
  await page.locator('[data-utility-button]').click()
  await expect(discard).toBeVisible()
  await discard.click()
  await expect(draft).toHaveCount(0)
  expect(prompts).toBe(0)

  await number.hover()
  await page.locator('[data-utility-button]').click()
  await draft.fill('not sending this')
  await discard.click()
  await expect(draft).toHaveCount(0)
  expect(prompts).toBe(1)
  expect(await stored(page, app)).toEqual([])
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
  await expect(
    page.locator('[data-line-type="change-deletion"]').filter({ hasText: 'main branch' }).last(),
  ).toBeVisible()
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
  await expect(page.getByRole('tab', { name: /main\.txt Unsaved changes/ })).toHaveCount(0)
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  const [conversation] = await stored(page, app)
  expect(conversation.anchor).toMatchObject({ startLine: 2, code: 'unsaved line' })
  expect((conversation as { location?: { status: string } }).location?.status).toBe('current')
})

test('conversations follow edited, moved and deleted code, and hide code Git never had', async ({
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
  await openFile(page, 'untracked.txt')
  await expect(number(1)).toBeVisible()
  await comment(page, number(1), null, 'untracked note')

  const twoHunk = join(app.repo, 'two-hunk.txt')
  writeFileSync(twoHunk, 'new 1\nnew 2\nnew 3\n' + readFileSync(twoHunk, 'utf8'))
  renameSync(join(app.repo, 'main.txt'), join(app.repo, 'main-moved.txt'))
  rmSync(join(app.repo, 'feature.txt'))
  const untracked = join(app.repo, 'untracked.txt')
  rmSync(untracked)
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
    // Git still has the deleted file's code in the index; never-tracked code is gone.
    'deleted file': { path: 'feature.txt', status: 'current', source: 'index' },
    'untracked note': { path: 'untracked.txt', status: 'missing' },
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
  await expect(pane.getByRole('button', { name: /untracked note/ })).toHaveCount(0)
  // The deleted file's conversation opens on the deletion Git can still show.
  await pane.getByRole('button', { name: /deleted file/ }).click()
  await expect(page.getByRole('article').filter({ hasText: 'deleted file' })).toBeVisible()

  // A replacement at the same path is not the file the note was about.
  writeFileSync(untracked, 'something else entirely\n')
  expect(await locations()).toMatchObject({ 'untracked note': { status: 'missing' } })
  writeFileSync(untracked, 'untracked content\n')
  expect(await locations()).toMatchObject({ 'untracked note': { status: 'current' } })
  await page.reload()
  await pane.getByRole('button', { name: 'Conversations', exact: true }).click()
  await expect(pane.getByRole('button', { name: /untracked note/ })).toBeVisible()
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
  const updated = page.waitForResponse(
    async (response) =>
      new URL(response.url()).pathname.endsWith('/api/v1/conversations') &&
      response.request().method() === 'GET' &&
      (await response.text()).includes('A longer agent reply'),
  )
  agent(
    app,
    'reply',
    first.id,
    '--id',
    'm-agent-longer',
    '--body',
    'A longer agent reply\nthat adds\nseveral lines\nabove',
  )
  await updated
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  expect(Math.abs((await reading.boundingBox())!.y - before)).toBeLessThan(2)
  await page.locator('.code-view').evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(thread.getByText('several lines')).toBeVisible()
})

test('display settings turn conversations off and on, and explain them', async ({ page, app }) => {
  writeFileSync(join(app.repo, 'notes.md'), '# Notes\n\nfirst\n')
  execFileSync('git', ['add', 'notes.md'], { cwd: app.repo })
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'notes', '--', 'notes.md'],
    {
      cwd: app.repo,
    },
  )
  const created = await page.request.post(new URL('api/v1/conversations', app.url).href, {
    headers: { Origin: new URL(app.url).origin },
    data: { id: 'c-keep', anchor: { path: 'notes.md', startLine: 3, endLine: 3 }, body: 'keep me' },
  })
  expect(created.ok()).toBe(true)

  const setting = async (on: boolean) => {
    await page.getByRole('button', { name: 'Display settings' }).click()
    const menu = page.getByRole('menu')
    if (!on) {
      await menu.getByRole('img', { name: 'About conversations' }).hover()
      await expect(page.getByRole('tooltip')).toContainText('discuss them with coding agents')
    }
    const control = menu.getByRole('switch', { name: 'Conversations' })
    await expect(control).toHaveAttribute('aria-checked', String(!on))
    await control.click()
    await expect(control).toHaveAttribute('aria-checked', String(on))
    await page.keyboard.press('Escape')
  }
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  const thread = page.getByRole('article').filter({ hasText: 'keep me' })
  const pane = page.getByRole('region', { name: 'Source Control workflow' })
  const toggle = pane.getByRole('button', { name: 'Conversations', exact: true })

  await page.goto(app.url)
  await openFile(page, 'notes.md')
  await expect(thread).toBeVisible()
  await expect(toggle).toBeVisible()

  await setting(false)
  await expect(thread).toHaveCount(0)
  await expect(toggle).toHaveCount(0)
  await number(2).hover()
  await expect(page.locator('[data-utility-button]')).toHaveCount(0)
  await page.reload()
  await openFile(page, 'notes.md')
  await expect(number(3)).toBeVisible()
  await expect(thread).toHaveCount(0)

  await setting(true)
  await expect(thread).toBeVisible()
  await expect(toggle).toBeVisible()
  expect((await stored(page, app)).map(({ messages }) => messages[0].body)).toEqual(['keep me'])
})

test('hiding conversations preserves a draft and releases its review after canceling', async ({
  page,
  app,
}) => {
  for (const name of ['Builder', 'Reviewer']) gitnaCLI(app, 'join', '--as', name)
  await page.goto(app.url)
  const modified = page.locator('diffs-container', { hasText: 'unstaged change' })
  const line = modified.locator('[data-column-number="1"]').last()
  await expect(line).toBeVisible()
  await line.hover()
  await page.locator('[data-utility-button]').click()
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  await draft.fill('@Reviewer Not sent yet')
  const setVisible = async (visible: boolean) => {
    await page.getByRole('button', { name: 'Display settings' }).click()
    const control = page.getByRole('switch', { name: 'Conversations' })
    await control.click()
    await expect(control).toHaveAttribute('aria-checked', String(visible))
    await page.keyboard.press('Escape')
  }
  await setVisible(false)
  await expect(draft).not.toBeVisible()
  expect(await stored(page, app)).toEqual([])
  await setVisible(true)
  await expect(draft).toBeVisible()
  await expect(draft).toHaveValue('@Reviewer Not sent yet')
  await expect(page.getByRole('button', { name: 'Remove Reviewer' })).toBeVisible()
  await setVisible(false)
  writeFileSync(join(app.repo, 'modified.txt'), 'base\n')
  await setVisible(true)
  await expect(draft).toHaveValue('@Reviewer Not sent yet')
  await expect(page.getByRole('button', { name: 'Remove Reviewer' })).toBeVisible()
  await expect(page.locator('div:has(> form [aria-label="Add a comment…"]) > pre')).toHaveText(
    'unstaged change',
  )
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  expect((await stored(page, app))[0].anchor).toMatchObject({
    path: 'modified.txt',
    source: 'worktree',
    startLine: 1,
    endLine: 1,
    code: 'unstaged change',
  })

  execFileSync('git', ['-C', app.repo, 'checkout', '-q', '--', '.'])
  execFileSync('git', ['-C', app.repo, 'clean', '-fdq'])
  await expect(page.locator('diffs-container', { hasText: 'FIFTY' })).toHaveCount(0)
  const staged = page.locator('diffs-container', { hasText: 'staged change' })
  await expect(staged).toBeVisible()
  await staged.locator('[data-column-number="1"]').last().hover()
  await page.locator('[data-utility-button]').click()
  await draft.fill('Cancel this draft')
  await setVisible(false)
  await setVisible(true)
  await expect(draft).toHaveValue('Cancel this draft')
  page.once('dialog', (dialog) => dialog.accept())
  await draft.press('Escape')
  await expect(draft).toHaveCount(0)
  execFileSync('git', ['-C', app.repo, 'reset', '-q', 'HEAD', '--', '.'])
  execFileSync('git', ['-C', app.repo, 'checkout', '-q', '--', '.'])
  await expect(staged).toHaveCount(0)
})

test('mentions address agents, with keyboard choices and editable reply prefill', async ({
  page,
  app,
}) => {
  const join = (name: string) =>
    (JSON.parse(gitnaCLI(app, 'join', '--as', name)) as { participant: { id: string } }).participant
      .id
  const first = join('Builder')
  const second = join('Reviewer')
  const pending = (id: string) =>
    (
      JSON.parse(gitnaCLI(app, 'pending', '--participant', id)) as {
        pending: { message: { body: string } }[]
      }
    ).pending.map(({ message }) => message.body)

  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await expect(number(5)).toBeVisible()

  // Unaddressed, a new conversation is readable but notifies nobody.
  await comment(page, number(5), null, 'Anyone?')
  expect(pending(first)).toEqual([])
  expect(pending(second)).toEqual([])

  await number(8).hover()
  await page.locator('[data-utility-button]').click()
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  await draft.fill('@')
  const choices = page.getByRole('listbox', { name: 'Mention an agent' })
  await expect(choices.getByRole('option')).toHaveText(['@all', '@Builder', '@Reviewer'])
  await draft.press('ArrowDown')
  await draft.press('ArrowDown')
  await draft.press('Enter')
  await expect(draft).toHaveValue('@Reviewer ')
  await draft.press('End')
  await draft.pressSequentially('Please review')
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  expect(pending(first)).toEqual([])
  expect(pending(second)).toEqual(['@Reviewer Please review'])

  const thread = page.getByRole('article').filter({ hasText: 'Please review' })
  const reply = thread.getByRole('textbox', { name: 'Reply…' })
  await expect(reply).toHaveValue('@Reviewer ')
  await reply.fill('@B')
  await reply.press('Escape')
  await expect(choices).toHaveCount(0)
  await expect(reply).toHaveValue('@B')
  await reply.fill('@Re')
  await reply.press('Tab')
  await expect(reply).toHaveValue('@Reviewer ')
  await reply.press('End')
  await reply.pressSequentially('And the tests')
  await reply.press('Control+Enter')
  await expect(thread.getByRole('paragraph').filter({ hasText: 'And the tests' })).toBeVisible()
  expect(pending(second)).toEqual(['@Reviewer Please review', '@Reviewer And the tests'])
  expect(pending(first)).toEqual([])

  // Recipients show as chips that edit the mentions in the reply.
  const recipients = thread.getByRole('group', { name: 'Recipients' })
  await expect(reply).toHaveValue('@Reviewer ')
  await recipients.getByRole('button', { name: 'Remove Reviewer' }).click()
  await expect(reply).toHaveValue('')
  await expect(recipients).toContainText('No agents')
  await recipients.getByRole('button', { name: 'Add recipient' }).click()
  await page.getByRole('menuitem', { name: '@Builder' }).click()
  await expect(reply).toHaveValue('@Builder ')
  await expect(recipients.getByRole('button', { name: 'Remove Builder' })).toBeVisible()
  await reply.press('End')
  await reply.pressSequentially('Over to you')
  await reply.press('Control+Enter')
  await expect.poll(() => pending(first)).toEqual(['@Builder Over to you'])
})

test('an unsent draft survives refreshes, follows its code, and never moves onto other code', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const modified = page.locator('diffs-container', { hasText: 'unstaged change' })
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  const startDraft = async (line: number, body: string) => {
    await modified.locator(`[data-column-number="${line}"]`).last().hover()
    await page.locator('[data-utility-button]').click()
    await draft.fill(body)
  }
  const disk = async (contents: string, shown: string) => {
    writeFileSync(join(app.repo, 'modified.txt'), contents)
    await expect(modified).toContainText(shown)
  }
  const anchor = async (body: string) =>
    (await stored(page, app)).find(({ messages }) => messages[0].body === body)?.anchor

  await expect(modified.locator('[data-column-number="1"]').last()).toBeVisible()
  await startDraft(1, 'follows')
  await disk('inserted\nunstaged change\n', 'inserted')
  await expect(draft).toHaveValue('follows')
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  expect(await anchor('follows')).toMatchObject({ startLine: 2, code: 'unstaged change' })

  await startDraft(2, 'outdated')
  await disk('inserted\nrewritten\n', 'rewritten')
  await expect(draft).toHaveValue('outdated')
  await expect(page.locator('div:has(> form [aria-label="Add a comment…"]) > pre')).toHaveText(
    'unstaged change',
  )
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  expect(await anchor('outdated')).toMatchObject({ startLine: 2, code: 'unstaged change' })
})

test('an unsent draft stays outdated after its diff and its whole scope are gone', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  const modified = page.locator('diffs-container', { hasText: 'unstaged change' })
  const draft = page.getByRole('textbox', { name: 'Add a comment…' })
  const saved = page.locator('div:has(> form [aria-label="Add a comment…"]) > pre')
  await modified.locator('[data-column-number="1"]').last().hover()
  await page.locator('[data-utility-button]').click()
  await draft.fill('kept')

  writeFileSync(join(app.repo, 'modified.txt'), 'base\n')
  await expect(saved).toHaveText('unstaged change')
  await expect(draft).toHaveValue('kept')

  execFileSync('git', ['-C', app.repo, 'checkout', '-q', '--', '.'])
  execFileSync('git', ['-C', app.repo, 'clean', '-fdq'])
  await expect(page.locator('diffs-container', { hasText: 'FIFTY' })).toHaveCount(0)
  await expect(draft).toHaveValue('kept')
  await draft.press('Control+Enter')
  await expect(draft).toHaveCount(0)
  const sent = (await stored(page, app)).find(({ messages }) => messages[0].body === 'kept')
  expect(sent?.anchor).toMatchObject({ startLine: 1, code: 'unstaged change' })
  await expect(page.locator('diffs-container', { hasText: 'staged change' })).toBeVisible()
  await expect(modified).toHaveCount(0)
})

test('one comment can be deleted from its menu, keeping the conversation, and undone', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  const number = (line: number) => page.locator(`[data-file] [data-column-number="${line}"]`)
  await expect(number(5)).toBeVisible()
  await comment(page, number(5), null, 'Keep this')
  const thread = page.getByRole('article').filter({ hasText: 'Keep this' })
  const menus = thread.getByRole('button', { name: /^More actions for .*'s comment$/ })
  // A lone comment is deleted with its conversation.
  await expect(thread.getByRole('button', { name: 'Delete conversation' })).toHaveCount(1)
  await expect(menus).toHaveCount(0)
  await thread.getByRole('textbox', { name: 'Reply…' }).fill('Drop this')
  await thread.getByRole('textbox', { name: 'Reply…' }).press('Control+Enter')
  await expect(thread.getByRole('textbox', { name: 'Reply…' })).toHaveValue('')
  await expect(thread.getByText('Drop this')).toBeVisible()

  await expect(menus.last()).toHaveCSS('opacity', '0')
  await expect(async () => {
    await thread.getByText('Drop this').hover()
    await expect(menus.last()).toHaveCSS('opacity', '1', { timeout: 1000 })
  }).toPass()
  await menus.last().click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(thread.getByText('Drop this')).toHaveCount(0)
  await expect(thread.getByText('Keep this')).toBeVisible()
  await expect(menus).toHaveCount(0)
  expect((await stored(page, app))[0].messages.map(({ body }) => body)).toEqual(['Keep this'])

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(thread.getByText('Drop this')).toBeVisible()
  expect((await stored(page, app))[0].messages.map(({ body }) => body)).toEqual([
    'Keep this',
    'Drop this',
  ])
})

async function addNative(page: Page, name: string, mode: string) {
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add custom agent…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add custom agent' })
  await expect(dialog.getByText(/can read and change anything you can/)).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
  const script = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
  await dialog
    .getByRole('textbox', { name: 'Command', exact: true })
    .fill(`"${process.execPath}" "${script}" ${mode}`)
  await dialog.getByRole('button', { name: 'Add agent', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText(`Added ${name}`)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

test('agents connect after one confirmation, stay remembered in other repositories, and run only when named', async ({
  page,
  app,
}) => {
  const bin = join(dirname(app.repo), 'bin')
  const ran = join(dirname(app.repo), 'ran')
  const script = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
  mkdirSync(bin)
  const program = (name: string, mode: string) =>
    process.platform === 'win32'
      ? writeFileSync(
          join(bin, `${name}.cmd`),
          `@echo ${name}>> "${ran}"\r\n@"${process.execPath}" "${script}" ${mode} %*\r\n`,
        )
      : writeFileSync(
          join(bin, name),
          `#!/bin/sh\necho ${name} >> '${ran}'\nexec '${process.execPath}' '${script}' ${mode} "$@"\n`,
          { mode: 0o700 },
        )
  program('opencode', 'reply')
  program('goose', 'auth')
  program('claude', 'reply')
  const runs = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split(/\s+/).filter(Boolean) : [])
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const second = await startGitna(process.env.GITNA_E2E_BINARY!, app.repo, {
    ...process.env,
    [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`,
  })
  try {
    await page.goto(second.url)
    await openFile(page, 'two-hunk.txt')
    const agents = page.getByRole('button', { name: 'Agents', exact: true })
    const row = (name: string) => page.getByRole('menuitem', { name: new RegExp(`^${name}`) })
    await agents.click()
    await expect(row('OpenCode')).toBeVisible()
    await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0)
    expect(runs()).toEqual([])

    await row('OpenCode').click()
    const confirm = page.getByRole('dialog', { name: 'Connect OpenCode' })
    await expect(confirm).toContainText('opencode acp')
    await expect(confirm).toContainText('can read and change anything you can')
    expect(runs()).toEqual([])
    await confirm.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    expect(runs()).toEqual(['opencode'])

    await agents.click()
    await expect(row('OpenCode')).toContainText('Connected')
    await row('OpenCode').click()
    await page.getByRole('menuitem', { name: 'Disconnect OpenCode', exact: true }).click()
    await expect(row('OpenCode')).not.toContainText('Connected')
    await row('OpenCode').click()
    await expect(row('OpenCode')).toContainText('Connected')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(runs()).toEqual(['opencode'])

    await row('goose').click()
    await page
      .getByRole('dialog', { name: 'Connect goose' })
      .getByRole('button', { name: 'Connect', exact: true })
      .click()
    const signIn = page.getByRole('dialog', { name: 'Sign in to goose' })
    await signIn.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(signIn).toHaveCount(0)
    await agents.click()
    await expect(row('goose')).toContainText('Connected')

    await row('Claude').click()
    const download = page.getByRole('dialog', { name: 'Connect Claude' })
    await expect(download).toContainText('/claude-agent-acp/releases/download/v0.108.0/')
    await expect(download).toContainText('0.108.0')
    await expect(download).toContainText(/\d+ MB/)
    await expect(download).toContainText(join('config', 'adapters', 'claude-agent-acp', '0.108.0'))
    await expect(download.getByRole('button', { name: 'Download and connect' })).toBeVisible()
    expect(runs()).not.toContain('claude')
    await page.keyboard.press('Escape')
  } finally {
    await stopGitna(second.child)
  }

  const other = join(dirname(app.repo), 'other')
  execFileSync('git', ['clone', '-q', app.repo, other])
  writeFileSync(join(other, 'two-hunk.txt'), readFileSync(join(app.repo, 'two-hunk.txt')))
  const stores = join(dirname(app.repo), 'config', 'conversations', 'v2')
  const before = readdirSync(stores).length
  const third = await startGitna(process.env.GITNA_E2E_BINARY!, other, {
    ...process.env,
    [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`,
  })
  try {
    await page.goto(third.url)
    await openFile(page, 'two-hunk.txt')
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: /^OpenCode/ })).toContainText('Connected')
    await page.keyboard.press('Escape')
    expect(readdirSync(stores)).toHaveLength(before)
    expect(runs()).toEqual(['opencode', 'goose', 'goose'])
    const thread = await nativeThread(page, '@OpenCode Explain this')
    await expect(thread.getByText('Reply from reply', { exact: true })).toBeVisible()
    expect(runs().filter((r) => r === 'opencode')).toHaveLength(2)

    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('menuitem', { name: /^goose/ }).click()
    await page.getByRole('menuitem', { name: 'Disconnect goose' }).click()
    await expect(page.getByRole('menuitem', { name: /^goose/ })).not.toContainText('Connected')
    await page.keyboard.press('Escape')
  } finally {
    await stopGitna(third.child)
  }

  const first = await startGitna(process.env.GITNA_E2E_BINARY!, app.repo, {
    ...process.env,
    [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}`,
  })
  try {
    await page.goto(first.url)
    await openFile(page, 'two-hunk.txt')
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: /^goose/ })).toContainText('Connected')
    await page.getByRole('menuitem', { name: /^goose/ }).click()
    await page.getByRole('menuitem', { name: 'More actions for goose' }).click()
    await page.getByRole('menuitem', { name: 'Forget goose' }).click()
    const forget = page.getByRole('dialog', { name: 'Forget goose' })
    await expect(forget).toContainText('Its conversations stay.')
    await forget.getByRole('button', { name: 'Forget agent' }).click()
    await expect(forget).toHaveCount(0)
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: /^goose/ })).not.toContainText('Connected')
    await expect(page.getByRole('menuitem', { name: 'Forget goose' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally {
    await stopGitna(first.child)
  }
})

test('a downloaded adapter connects like any agent and Remove adapter deletes it', async ({
  page,
  app,
}) => {
  test.skip(process.platform === 'win32', 'the fake adapter is a shell script')
  const script = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url))
  const folder = join(dirname(app.repo), 'config', 'adapters', 'claude-agent-acp')
  mkdirSync(join(folder, '0.108.0'), { recursive: true })
  const adapter = join(folder, '0.108.0', 'claude-agent-acp')
  writeFileSync(adapter, `#!/bin/sh\nexec '${process.execPath}' '${script}' reply "$@"\n`, {
    mode: 0o700,
  })
  const gitna = await startGitna(process.env.GITNA_E2E_BINARY!, app.repo)
  try {
    await page.goto(gitna.url)
    await openFile(page, 'two-hunk.txt')
    const agents = page.getByRole('button', { name: 'Agents', exact: true })
    const claude = page.getByRole('menuitem', { name: /^Claude/ })
    await agents.click()
    await claude.click()
    const confirm = page.getByRole('dialog', { name: 'Connect Claude' })
    await expect(confirm).toContainText(adapter)
    await confirm.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(confirm).toHaveCount(0)
    await agents.click()
    await page.getByRole('menuitem', { name: 'Add custom agent…' }).click()
    const custom = page.getByRole('dialog', { name: 'Add custom agent' })
    await custom.getByRole('textbox', { name: 'Name', exact: true }).fill('Second Claude')
    await custom.getByRole('textbox', { name: 'Command', exact: true }).fill(`"${adapter}"`)
    await custom.getByRole('button', { name: 'Add agent', exact: true }).click()
    await custom.getByRole('button', { name: 'Done', exact: true }).click()

    await agents.click()
    await expect(claude).toContainText('Connected')
    await claude.click()
    await page.getByRole('menuitem', { name: 'More actions for Claude' }).click()
    await page.getByRole('menuitem', { name: 'Remove Claude adapter' }).click()
    const remove = page.getByRole('dialog', { name: 'Remove Claude adapter' })
    await expect(remove).toContainText('forgets Claude in every repository')
    await expect(remove.getByRole('alert')).toContainText('Second Claude also uses this adapter')
    await remove.getByRole('button', { name: 'Remove adapter' }).click()
    await expect(remove).toHaveCount(0)
    expect(existsSync(folder)).toBe(false)
    await agents.click()
    await expect(page.getByRole('menuitem', { name: 'Claude Connected' })).toHaveCount(0)
  } finally {
    await stopGitna(gitna.child)
  }
})

async function nativeThread(page: Page, body: string) {
  await comment(page, page.locator('[data-file] [data-column-number="5"]'), null, body)
  return page.getByRole('article').filter({ hasText: body })
}

test('native mentions run only the named agents, sequentially, and preserve CLI participation', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Agent A', 'reply')
  await addNative(page, 'Agent B', 'second')
  await nativeThread(page, 'No recipient')
  expect((await stored(page, app))[0].runs ?? []).toEqual([])
  const first = await nativeThread(page, '@Agent A Explain this')
  await expect(first.getByText('Reply from reply', { exact: true })).toBeVisible()
  expect((await stored(page, app))[1].runs).toHaveLength(1)
  await expect(first.getByRole('textbox', { name: 'Reply…' })).toHaveValue('@Agent A ')
  await first.getByRole('textbox', { name: 'Reply…' }).fill('@Agent A Follow up')
  await first.getByRole('textbox', { name: 'Reply…' }).press('Control+Enter')
  await expect(first.getByText('Reply from reply', { exact: true })).toHaveCount(2)
  const all = await nativeThread(page, '@all Both of you')
  await expect(all.getByRole('status').filter({ hasText: 'Agent B: Waiting' })).toBeVisible()
  await expect(all.getByText('Reply from second', { exact: true })).toBeVisible()
  expect(
    readFileSync(join(app.repo, '.git', 'native-runs'), 'utf8')
      .trim()
      .split('\n'),
  ).toEqual(['reply', 'reply', 'reply', 'second'])
  await addNative(page, 'Late agent', 'late')
  expect((await stored(page, app)).flatMap((conversation) => conversation.runs ?? [])).toHaveLength(
    4,
  )
  agent(app, 'session')
  const thread = (await stored(page, app))[1]
  agent(app, 'reply', thread.id, '--id', 'm-cli-native', '--body', 'CLI joined this thread')
  await expect(first.getByText('CLI joined this thread', { exact: true })).toBeVisible()
})

test('native edits appear in changes, and permissions can be denied', async ({ page, app }) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Editor', 'edit')
  const thread = await nativeThread(page, '@Editor Change the file')
  await expect(thread.getByText(/Edited modified.txt:/)).toBeVisible()
  expect(readFileSync(join(app.repo, 'modified.txt'), 'utf8')).toContain('agent edit')
  await page
    .locator('#gitna-unstaged-tree__tree')
    .getByRole('treeitem', { name: 'modified.txt', exact: true })
    .click()
  await expect(page.locator('[data-line]').filter({ hasText: 'agent edit' }).first()).toBeVisible()
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Permission agent', 'permission')
  const permission = await nativeThread(page, '@Permission agent Ask first')
  await permission.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(permission.getByText('Permission: no', { exact: true })).toBeVisible()
})

test('native runs survive a closed page, cancel, and become interrupted after a crash', async ({
  page,
  app,
  context,
}) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Slow agent', 'reply')
  await nativeThread(page, '@Slow agent Finish after the page closes')
  await page.close()
  const other = await context.newPage()
  await other.goto(app.url)
  await openFile(other, 'two-hunk.txt')
  await expect(other.getByText('Reply from reply', { exact: true })).toBeVisible()
  await addNative(other, 'Hanging agent', 'hang')
  const hanging = await nativeThread(other, '@Hanging agent Cancel me')
  await hanging.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(hanging.getByRole('status')).toContainText('Cancelled')
  await nativeThread(other, '@Hanging agent Interrupt me')
  await expect(
    other
      .getByRole('article')
      .filter({ hasText: 'Interrupt me' })
      .getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeVisible()
  const restarted = await app.restart(true)
  await other.goto(restarted.url)
  await openFile(other, 'two-hunk.txt')
  const interrupted = other.getByRole('article').filter({ hasText: 'Interrupt me' })
  await expect(interrupted.getByRole('status')).toContainText('Interrupted')
  await expect(interrupted.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  const conversations = await stored(other, restarted)
  expect(conversations[2].messages).toHaveLength(1)
  expect(conversations[2].runs).toHaveLength(1)
  await other.getByRole('button', { name: 'Display settings' }).click()
  await expect(other.getByRole('switch', { name: 'Conversations' })).toBeChecked()
})

test('turning conversations off interrupts queued runs without stopping the active run', async ({
  page,
  app,
}) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Active agent', 'hang')
  await addNative(page, 'Queued agent', 'reply')
  const thread = await nativeThread(page, '@all Pause the queue')
  await expect(
    thread.getByRole('status').filter({ hasText: 'Queued agent: Waiting' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Display settings' }).click()
  await page.getByRole('switch', { name: 'Conversations' }).click()
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => (await stored(page, app))[0].runs?.map((run) => run.state))
    .toEqual(['running', 'interrupted'])
  await page.getByRole('button', { name: 'Display settings' }).click()
  await page.getByRole('switch', { name: 'Conversations' }).click()
  await page.keyboard.press('Escape')
  await expect(
    thread.getByRole('status').filter({ hasText: 'Conversations was turned off' }),
  ).toBeVisible()
  await thread.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect
    .poll(async () => (await stored(page, app))[0].runs?.map((run) => run.state))
    .toEqual(['cancelled', 'interrupted'])
  expect((await stored(page, app))[0].messages).toHaveLength(1)
})

test('a connected agent runs with the model chosen for it', async ({ page, app }) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Modeler', 'model')
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Modeler/ }).click()
  const trigger = page.getByRole('menuitem', { name: 'Model for Modeler' })
  await expect(trigger).toContainText('Default')
  await trigger.click()
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveText(
    'Agent default (Small)',
  )
  await page.getByRole('menuitemradio', { name: 'Large' }).click()
  await expect(trigger).toContainText('Large')
  await page.keyboard.press('Escape')

  // The offered models are saved, so names show without starting the agent.
  await page.reload()
  await openFile(page, 'two-hunk.txt')
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Modeler/ }).click()
  await expect(trigger).toContainText('Large')
  await trigger.click()
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveText('Large')
  await page.keyboard.press('Escape')
  const thread = await nativeThread(page, '@Modeler Which model?')
  await expect(thread.getByText('Reply from large', { exact: true })).toBeVisible()

  // Renaming reaches past replies; an empty name restores the default.
  const rename = async (from: string, to: string) => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('menuitem', { name: new RegExp(`^${from}`) }).click()
    const more = page.getByRole('menuitem', { name: `More actions for ${from}` })
    await more.hover()
    await expect(page.getByRole('menuitem', { name: `Rename ${from}` })).toHaveCount(0)
    await more.click()
    await page.getByRole('menuitem', { name: `Rename ${from}` }).click()
    const dialog = page.getByRole('dialog', { name: `Rename ${from}` })
    await dialog.getByRole('textbox', { name: 'Name' }).fill(to)
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(dialog).toHaveCount(0)
  }
  await rename('Modeler', 'Reviewer')
  await expect(thread.getByText('Reviewer', { exact: true })).toBeVisible()
  const fallback = basename(process.execPath).replace(/\.exe$/i, '')
  await rename('Reviewer', '')
  await expect(thread.getByText(fallback, { exact: true })).toBeVisible()
})

test('a retried run replaces the one it retried', async ({ page, app }) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Flaky', 'fail-once')
  const thread = await nativeThread(page, '@Flaky Try twice')
  await expect(thread.getByRole('status')).toContainText('Failed')
  await thread.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(thread.getByText('Reply from fail-once', { exact: true })).toBeVisible()
  await expect(thread.getByRole('status')).toHaveCount(0)
  await expect(thread.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0)

  await addNative(page, 'Stuck', 'hang')
  const stuck = await nativeThread(page, '@Stuck Cancel me twice')
  await stuck.getByRole('button', { name: 'Cancel', exact: true }).click()
  await stuck.getByRole('button', { name: 'Retry', exact: true }).click()
  await stuck.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(stuck.getByRole('status')).toHaveCount(1)
  await expect(stuck.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(1)
})

test('a running agent shows its own reply bubble with the text so far', async ({ page, app }) => {
  await page.goto(app.url)
  await openFile(page, 'two-hunk.txt')
  await addNative(page, 'Streamer', 'stream')
  const thread = await nativeThread(page, '@Streamer Go ahead')
  await expect(thread.locator('strong', { hasText: /^Streamer$/ })).toBeVisible()
  await expect(thread.locator('strong', { hasText: /^it$/ })).toBeVisible()
  await expect(thread.getByRole('status')).toHaveText('Writing a reply')
  await thread.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(thread.locator('strong', { hasText: /^it$/ })).toHaveCount(0)
  await expect(thread.getByRole('status')).toContainText('Streamer: Cancelled')
  await expect(thread.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
})
