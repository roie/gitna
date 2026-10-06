import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

test('workspace results stay bounded while keyboard navigation reaches unmounted rows', async ({
  page,
  app,
}) => {
  for (let index = 0; index < 80; index++) {
    writeFileSync(
      join(app.repo, `result-${String(index).padStart(3, '0')}.txt`),
      'VirtualSearchNeedle\n'.repeat(40),
    )
  }
  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Review' })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.keyboard.press('Control+Shift+f')
  const panel = page.getByRole('region', { name: 'Find in Files' })
  const query = panel.getByRole('textbox', { name: 'Search files', exact: true })
  await query.fill('VirtualSearchNeedle')
  await expect(panel.getByText('2000 results in 50 files', { exact: true })).toBeVisible()
  const matches = panel.getByRole('button', { name: /^Open result-/ })
  await expect.poll(() => matches.count()).toBeGreaterThan(0)
  await expect.poll(() => matches.count()).toBeLessThan(80)
  const firstFile = panel.getByRole('button', { name: 'result-000.txt 40', exact: true })
  await query.press('ArrowDown')
  await expect(firstFile).toBeFocused()
  await page.keyboard.press('End')
  await expect(
    panel.getByRole('button', { name: 'Open result-049.txt:40', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(
    panel.getByRole('button', { name: 'Open result-049.txt:39', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Home')
  await expect(firstFile).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(firstFile).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('ArrowDown')
  await expect(panel.getByRole('button', { name: 'result-001.txt 40', exact: true })).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(
    panel.getByRole('button', { name: 'Open result-000.txt:1', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(query).toBeFocused()
  // Re-entering the list after scrolling must reach the first logical row.
  await query.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.press('Escape')
  await query.press('ArrowDown')
  await expect(firstFile).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'result-000.txt', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'Collapse all results' }).click()
  await expect(matches).toHaveCount(0)
  await panel.getByRole('button', { name: 'Expand all results' }).click()
  await expect.poll(() => matches.count()).toBeGreaterThan(0)
  await expect.poll(() => matches.count()).toBeLessThan(80)
})

test('workspace searches large files and long lines and editor regex errors recover', async ({
  page,
  app,
}) => {
  writeFileSync(join(app.repo, 'needle.txt'), 'CaseWord café\nCaseWord\n')
  writeFileSync(
    join(app.repo, 'oversized.txt'),
    'ordinary text\n'.repeat(50000) + 'BeyondOldLimitNeedle\n',
  )
  writeFileSync(join(app.repo, 'longline.txt'), 'x'.repeat(70000) + ' BeyondOldLimitNeedle')
  await page.goto(app.url)
  await expect(page.getByRole('region', { name: 'Review' })).toHaveAttribute(
    'data-connection-state',
    'connected',
  )
  await page.keyboard.press('Control+Shift+f')
  const panel = page.getByRole('region', { name: 'Find in Files' })
  const query = panel.getByRole('textbox', { name: 'Search files', exact: true })
  await query.fill('DefinitelyAbsentNeedle')
  await expect(panel.getByText('No results found.', { exact: true })).toBeVisible()
  await query.fill('BeyondOldLimitNeedle')
  await expect(panel.getByText('2 results in 2 files', { exact: true })).toBeVisible()
  await expect(
    panel.getByRole('button', { name: 'Open oversized.txt:50001', exact: true }),
  ).toBeVisible()
  await panel.getByRole('button', { name: 'Open longline.txt:1', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'longline.txt', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'Toggle Search Details' }).click()
  await panel.getByRole('textbox', { name: 'Files to include' }).fill('needle.txt')
  await query.fill('DefinitelyAbsentNeedle')
  await expect(panel.getByText('No results found.', { exact: true })).toBeVisible()
  await query.fill('CaseWord')
  await panel.getByRole('button', { name: 'Open needle.txt:1', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'needle.txt', exact: true })
  await editor.press('Control+f')
  const find = page.locator('[data-search-panel] input[data-search]')
  const status = page.locator('[data-search-panel] [data-matches]')
  await find.fill('CaseWord')
  await expect(status).toContainText('2')
  await page.getByRole('button', { name: 'Regexp', exact: true }).click()
  await find.fill('[')
  await expect(status).toHaveText('Invalid regex')
  await expect(find).toHaveAttribute('aria-invalid', 'true')
  await expect(find).toHaveAttribute('aria-describedby', 'editor-search-status')
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  await find.fill('CaseWord|café')
  await expect(find).toHaveAttribute('aria-invalid', 'false')
  await expect(find).not.toHaveAttribute('aria-describedby')
  await expect(status).toContainText('3')
  await find.fill('[')
  await page.getByRole('button', { name: 'Regexp', exact: true }).click()
  await expect(find).toHaveAttribute('aria-invalid', 'false')
  await expect(status).toHaveText('No results')
})
