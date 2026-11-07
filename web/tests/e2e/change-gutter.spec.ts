import { execFileSync } from 'node:child_process'
import { expect, test } from './fixtures.js'

test('file gutters track the index, unsaved edits, undo, and staging', async ({ page, app }) => {
  await page.goto(app.url)
  const openFile = async (path: string) => {
    await page.getByRole('button', { name: 'Open command palette' }).click()
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox', { name: 'Search files and commands' }).fill(path)
    await palette
      .getByRole('option', { name: new RegExp(`^${path.replaceAll('.', '\\.')} `) })
      .click()
  }
  const marks = page.locator('[data-file] [data-gitna-change]')
  const row = (index: number) => page.locator(`[data-file] [data-line][data-line-index="${index}"]`)

  await openFile('two-hunk.txt')
  await expect(page.locator('[data-column-number="2"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  await row(10).click({ position: { x: 20, y: 8 } })
  await page.keyboard.press('Home')
  await page.keyboard.type('inserted')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-column-number="11"][data-gitna-change="added"]')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(marks).toHaveCount(1)
  await expect(page.locator('[data-column-number="2"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  const caretDiag = async (label: string) => {
    const info = await page.evaluate(() => {
      const host =
        document.querySelector('[data-file]')?.closest('diffs-container') ??
        document.querySelector('diffs-container')
      const root = (host as HTMLElement | null)?.shadowRoot ?? null
      const selection =
        (root as unknown as { getSelection?: () => Selection | null } | null)?.getSelection?.() ??
        document.getSelection()
      const anchor = selection?.anchorNode
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement
      const editable = (root ?? document).querySelector(
        '[contenteditable="true"]',
      ) as HTMLElement | null
      const active = document.activeElement
      return {
        caretLine: anchorElement?.closest('[data-line]')?.getAttribute('data-line') ?? null,
        caretOffset: selection?.anchorOffset,
        editableMarker: editable?.dataset.diagMarker ?? null,
        activeTag: active?.tagName,
        activeInShadow: root?.activeElement?.tagName ?? null,
        hasFocus: document.hasFocus(),
      }
    })
    console.log(`CDIAG ${label} ${JSON.stringify(info)}`)
  }
  await page.evaluate(() => {
    const host =
      document.querySelector('[data-file]')?.closest('diffs-container') ??
      document.querySelector('diffs-container')
    const root = (host as HTMLElement | null)?.shadowRoot ?? document
    const editable = root.querySelector('[contenteditable="true"]') as HTMLElement | null
    if (editable != null) editable.dataset.diagMarker = 'before-click'
  })
  await caretDiag('before-click')
  const target = await row(2).boundingBox()
  const hit = await page.evaluate(
    ([x, y]) => {
      const outer = document.elementFromPoint(x, y)
      const inner = (outer as HTMLElement | null)?.shadowRoot?.elementFromPoint(x, y) ?? outer
      return {
        outer: outer?.tagName,
        inner: inner?.tagName,
        innerLine: inner?.closest('[data-line]')?.getAttribute('data-line') ?? null,
        innerAttrs: inner == null ? null : [...inner.attributes].map((a) => a.name).join(','),
      }
    },
    [target!.x + 20, target!.y + 8],
  )
  console.log(`CDIAG hit ${JSON.stringify({ box: target, hit })}`)
  await row(2).click({ position: { x: 20, y: 8 } })
  await caretDiag('after-click')
  await page.waitForTimeout(150)
  await caretDiag('after-click+150ms')
  await page.waitForTimeout(500)
  await caretDiag('after-click+650ms')
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Backspace')
  await expect(page.locator('[data-column-number="2"][data-gitna-deletion="after"]')).toHaveCount(1)
  await page.keyboard.press('Control+z')
  await expect(page.locator('[data-gitna-deletion]')).toHaveCount(0)

  await row(2).hover()
  await page.mouse.wheel(0, 800)
  await expect(page.locator('[data-column-number="50"][data-gitna-change="modified"]')).toHaveCount(
    1,
  )

  execFileSync('git', ['add', '--', 'two-hunk.txt'], { cwd: app.repo })
  await expect(marks).toHaveCount(0)
  await openFile('staged.txt')
  await expect(marks).toHaveCount(0)
  await openFile('untracked.txt')
  await expect(page.locator('[data-column-number="1"][data-gitna-change="added"]')).toHaveCount(1)
})
