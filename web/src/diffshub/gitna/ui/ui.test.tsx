import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vite-plus/test'

import { Count } from './Count'
import { Header } from './Header'
import { Pane } from './Pane'
import { Row } from './Row'

vi.mock('@pierre/icons', () => ({
  IconChevronSm: () => <svg data-icon="chevron" />,
}))

function Icon({ className }: { className?: string }) {
  return <svg data-icon="pane" className={className} />
}

const render = (node: ReactElement) => renderToStaticMarkup(node)

describe('Pane', () => {
  it('uses the list scrollbar by default and the code scrollbar for code', () => {
    const list = render(<Pane />)
    expect(list).toContain('list-scrollbar')
    expect(list).toContain('overflow-y-auto')
    expect(list).toContain('overscroll-contain')
    const code = render(<Pane variant="code" />)
    expect(code).toContain('cv-scrollbar')
    expect(code).not.toContain('list-scrollbar')
  })
})

describe('Count', () => {
  it('renders muted tabular extra-small text', () => {
    expect(render(<Count>4</Count>)).toBe(
      '<span class="section-count shrink-0 text-xs tabular-nums text-muted-foreground">4</span>',
    )
  })
})

describe('Header', () => {
  it('renders a pane header with a toggle, count and actions', () => {
    const markup = render(
      <Header
        level="pane"
        icon={Icon}
        title="Graph"
        count={2}
        open
        onOpenChange={() => {}}
        actions={<button type="button">Refresh</button>}
      />,
    )
    expect(markup).toMatch(/^<div class="[^"]*\bborder-t\b[^"]*\btext-sm\b/)
    expect(markup).toMatch(
      /<button[^>]*class="section-header[^"]*focus-visible:outline-ring[^"]*"[^>]*aria-expanded="true"/,
    )
    expect(markup).toContain('<svg data-icon="pane" class="size-3 shrink-0 opacity-50">')
    expect(markup).not.toContain('data-icon="chevron"')
    expect(markup).toMatch(/class="section-title[^"]*"[^>]*>Graph</)
    expect(markup).toMatch(/class="section-count[^"]*">2</)
    expect(markup).toContain('>Refresh</button>')
  })

  it('renders a section header with a chevron, hover actions and the count last', () => {
    const markup = render(
      <Header
        level="section"
        icon={Icon}
        title="Changes"
        count={5}
        open={false}
        onOpenChange={() => {}}
        actions={<button type="button">Stage all</button>}
      />,
    )
    expect(markup).toMatch(/^<div class="[^"]*\bh-8\b[^"]*\bhover:bg-accent\b/)
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).toContain('data-icon="chevron"')
    expect(markup).toMatch(/class="section-title[^"]*font-medium[^"]*"/)
    expect(markup).toMatch(/group-hover\/header:opacity-100[^>]*><button type="button">Stage all/)
    expect(markup).toMatch(/class="section-count[^"]*">5<\/span><\/div>$/)
  })

  it('renders a static title without a toggle', () => {
    const markup = render(<Header level="pane" icon={Icon} title="Search" />)
    expect(markup).not.toContain('<button')
    expect(markup).toMatch(/<div class="section-header[^"]*">/)
    expect(markup).toMatch(/<h2 class="section-title[^"]*"[^>]*>Search<\/h2>/)
  })
})

describe('Row', () => {
  it('renders a small row with its slots and selection', () => {
    const markup = render(
      <Row
        selected
        icon={<i data-slot="icon" />}
        label="main.txt"
        detail="src"
        status={<b data-slot="status" />}
        actions={<button type="button">Close</button>}
      />,
    )
    expect(markup).toMatch(
      /^<div class="[^"]*\bh-7\b[^"]*\bbg-accent text-accent-foreground\b[^"]*" data-selected="true">/,
    )
    expect(markup).toMatch(
      /<button type="button" class="[^"]*focus-visible:outline-ring[^"]*"><i data-slot="icon"><\/i><span[^>]*>main\.txt<\/span><span[^>]*>src<\/span><span class="ms-auto[^"]*"><b data-slot="status"><\/b><\/span><\/button><button type="button">Close<\/button><\/div>$/,
    )
  })

  it('stacks label and detail in a large row', () => {
    const markup = render(<Row size="lg" label="Open folder" detail="Choose a repository" />)
    expect(markup).toMatch(/^<div class="[^"]*\bmin-h-10\b[^"]*">/)
    expect(markup).not.toContain('data-selected')
    expect(markup).toContain(
      '<span class="block truncate">Open folder</span><span class="mt-0.5 block truncate text-xs text-muted-foreground">Choose a repository</span>',
    )
  })
})
