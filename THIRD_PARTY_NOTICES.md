# Third-Party Notices

Gitna itself is licensed under Apache-2.0 as stated in `LICENSE`. This file
records notices and provenance for third-party material incorporated into or
distributed with Gitna. Source copies/adaptations and packaged dependencies
are listed separately because they have different provenance requirements.

## Pierre DiffsHub React source

Gitna's DiffsHub donor is pinned to:

- Repository: [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre)
- Tag: `diffs-v1.3.5`
- Commit: `59ec35ffac97abccef4c69f8d58d3747cbfbc6cb`
- License: Apache-2.0, Copyright 2025 Pierre Computer Company
- Verbatim license: `LICENSES/Apache-2.0.txt`
- Donor app license copy: `web/src/diffshub/LICENSE.md`

Relevant React components, CSS and frontend helpers from
`apps/diffshub` are incorporated under `web/src/diffshub`. Most files remain
byte-identical. Modified donor files carry a prominent explanation and are
limited to standalone Vite, local-repository, strict-CSP and VS Code Source
Control integration boundaries.

| Exact upstream responsibility | Local destination | Current disposition |
| --- | --- | --- |
| Header, display/theme controls and URL form | `web/src/diffshub/components/DiffsHubHeader.tsx`, `DiffUrlForm.tsx`; Gitna branding at `web/src/diffshub/gitna/GitnaLogo.tsx` | Header/form retain donor structure with capability-safe Vite links and truthful local repository identity; the donor logo is replaced by Gitna's theme-aware product mark. |
| Sidebar, file tree, comments, stats and worker monitor | corresponding files under `web/src/diffshub/components` | Donor source retained. Gitna's sidebar removes the inapplicable Files/Comments tabs, Diff Stats and System Monitor while preserving the themed responsive drawer. The file-tree boundary adds unique IDs and external selection so Repository, Staged Changes, Changes and expanded Graph commits all use Pierre Trees; closed narrow overlays add `aria-hidden`/`inert`. |
| Continuous CodeView and themed wrappers | `DiffsHubViewer.tsx`, `ThemedCodeView.tsx`, themed hooks/helpers | Donor viewer retained with Gitna file/hunk actions added through its header metadata slot. |
| Worker pool and preload | `WorkerPoolContext.tsx`, `PreloadHighlighter.tsx` | Vite `?worker` replaces the Next worker URL and Shiki JS preserves the strict CSP without `wasm-unsafe-eval`. |
| Status panel | `DiffsHubStatusPanel.tsx` | Donor states/layout retained with local-repository loading copy. |
| Theme system, annotations, accumulators and frontend helpers | matching paths under `web/src/diffshub` | Verbatim except the documented lint-normalized `gitPatchMetadata.ts` conditional. |
| `app/globals.css` and app font loading | `web/src/diffshub/globals.css`, `web/src/diffshub/vite/fonts.css` | CSS is verbatim; static `@font-face` replaces `next/font` with the exact checked-in assets and variables. |
| `ReviewUI.tsx` and `RootLayout.tsx` composition | `web/src/diffshub/main.tsx`, `web/src/diffshub/gitna/GitnaReviewUI.tsx` | Next/GitHub orchestration replaced by typed local adapters while preserving provider order and donor review composition. |
| GitHub loaders/auth, Next metadata and marketing route | none | Not distributed; these remote/site-only features have no truthful local Gitna counterpart. |

## Pierre npm packages

These packages are consumed as npm dependencies and bundled into Gitna's
embedded frontend. `@pierre/trees` is modified under Apache-2.0 through the
reproducible pnpm patch at `web/patches/@pierre__trees@1.0.0-beta.6.patch`.
Gitna's modification adds a generic public interactive row-action renderer,
semantic action buttons, and hover/focus styling while preserving Pierre's row
rendering, focus, selection and virtualization ownership. The other package
renderers are distributed unmodified.

| Package | Installed version | Package license evidence | Required distribution material |
| --- | --- | --- | --- |
| `@pierre/diffs` | `1.3.5` | `web/node_modules/@pierre/diffs/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; the package contains no NOTICE file. |
| `@pierre/icons` | `0.7.1` | `web/node_modules/@pierre/icons/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; the package contains no NOTICE file. |
| `@pierre/trees` | `1.0.0-beta.6` + Gitna row-actions patch | `web/node_modules/@pierre/trees/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`, `web/patches/@pierre__trees@1.0.0-beta.6.patch`, and the `@pierre/trees` notice below. |
| `@pierre/theme` | `2.0.0` | `web/node_modules/@pierre/theme/LICENSE`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt` and the `@pierre/theme` notice below. |
| `@pierre/theming` | `1.0.1` | `web/node_modules/@pierre/theming/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; the package contains no NOTICE file. |

The Apache-2.0 text shipped by the pinned DiffsHub app, `@pierre/icons`, and all
five installed Pierre packages is byte-identical, so Gitna keeps one verbatim
shared copy at `LICENSES/Apache-2.0.txt`. The Trees and Theme notices are
reproduced verbatim below because they contain distinct upstream attribution.
Their shared MIT license text is also available at `LICENSES/MIT.txt`.

## Geist font

Gitna incorporates `Geist-Variable.woff2` from `geist@1.5.1`, Copyright 2023
Vercel in collaboration with basement.studio. Geist is licensed under the SIL
Open Font License 1.1; the verbatim license is at `LICENSES/OFL-1.1.txt`.

## Distribution requirement

Release archives include `LICENSE`, this file, the shared license texts in
`LICENSES/`, and `THIRD_PARTY_LICENSES.txt`. The generated inventory records
every production npm package, every Go module, and the checked-in Geist font,
together with their applicable license texts. Regenerate it after dependency changes with
`node scripts/generate-third-party-licenses.mjs`.

## Verbatim upstream notices

### `@pierre/theme` notice

This theme was built on top of
[GitHub's Visual Studio Code Theme](https://github.com/primer/github-vscode-theme),
reusing its technique and build tooling, which we have since iterated on for
more specific language tokens.

`@pierre/theme` is licensed under Apache-2.0 (see `LICENSE`). The original MIT
license for `primer/github-vscode-theme` is included below for attribution.

Original license for `primer/github-vscode-theme`:

```
MIT License

Copyright (c) 2020 Primer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### `@pierre/trees` notice

This project includes some code derived from
[@headless-tree/core](https://github.com/lukasbach/headless-tree).

The initial version of this project used `headless-tree` as the underlying tree
implementation. We have since written our own core at `packages/path-store`, but
many of the best ideas from `headless-tree` made their way to `path-store` and
`trees`. It's hard to identify exactly which code this is at this point, but
definitely things like the drag and drop implementation and the general list
approach to rendering and I'm sure more. The work that `@lukasbach` has
contributed to this space is greatly appreciated. `<3`

Original license for `headless-tree/core`:

```
MIT License

Copyright (c) 2023 Lukas Bach

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
