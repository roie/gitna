# Third-Party Notices

This file records the provenance of any source code copied or substantially
adapted from upstream projects, as required by the reuse policy in
`docs/superpowers/specs/2026-08-15-local-git-workbench-design.md` section 14.

| Upstream repo | Upstream version | Source path | License | Local destination | Modification summary |
|---|---|---|---|---|---|
| [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre) | `@pierre/diffs@1.3.5`, `@pierre/theming@1.0.1`, `@pierre/theme@2.0.0` | `apps/diffshub/lib/theme/deriveChromeTokens.ts`, `apps/diffshub/lib/theme/diffshubChromeMapping.ts` | Apache-2.0 | `web/src/lib/chrome-theme.ts` | Ported `deriveChromeTokens()` and `diffshubChromeMapping()` to plain TypeScript (removed React/Next.js deps). Adapted to set CSS custom properties on `document.documentElement`. |
| pierrecomputer/pierre | `@pierre/diffs@1.3.5` | `apps/diffshub/components/Button.tsx` | Apache-2.0 | `web/src/components/Button.svelte` | Ported 9 variants × 9 sizes from Tailwind + CVA to plain CSS using DiffsHub's CSS custom-property vocabulary. Removed Radix/React dependencies. |
| pierrecomputer/pierre | `@pierre/diffs@1.3.5` | `apps/diffshub/components/Input.tsx` | Apache-2.0 | `web/src/components/Input.svelte` | Ported 3 sizes from Tailwind to plain CSS. |
| pierrecomputer/pierre | `@pierre/diffs@1.3.5` | `apps/diffshub/components/Switch.tsx` | Apache-2.0 | `web/src/components/Switch.svelte` | Ported toggle to pure Svelte (no Radix dependency). |
| pierrecomputer/pierre | `@pierre/diffs@1.3.5` | `apps/diffshub/app/globals.css` | Apache-2.0 | `web/src/app.css` | Adopted DiffsHub's CSS custom-property vocabulary (`--foreground`, `--primary`, `--accent`, `--muted-foreground`, `--border`, etc.) as fallback values. Adapted dark/light mode to system `prefers-color-scheme` + `.dark` class. |
