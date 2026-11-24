# Third-Party Notices

Gitna itself is licensed under Apache-2.0 as stated in `LICENSE`. This file
records notices and provenance for third-party material incorporated into or
distributed with Gitna. Source copies/adaptations and packaged dependencies
are listed separately because they have different provenance requirements.

## Pierre DiffsHub React source

Gitna's DiffsHub donor is pinned to:

- Repository: [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre)
- Tag: `diffs-v1.7.0-beta.4`
- Commit: `8b12bdd75d723ac5b83cb9efe11c8ddb818bf462`
- License: Apache-2.0, Copyright 2025 Pierre Computer Company
- Verbatim license: `LICENSES/Apache-2.0.txt`
- Donor app license copy: `LICENSES/diffshub-Apache-2.0.md`

Retained copies and adaptations carry in-file `Modified by Gitna:` notes where changed.

| Gitna path | Donor path |
| --- | --- |
| `web/src/main.tsx` | `apps/diffshub/app/layout.tsx`, `apps/diffshub/components/RootLayout.tsx` |
| `web/src/styles/globals.css` | `apps/diffshub/app/globals.css` |
| `web/src/styles/fonts.css` | `apps/diffshub/app/layout.tsx` |
| `web/src/app/workbench-header.tsx` | `apps/diffshub/components/DiffsHubHeader.tsx` |
| `web/src/app/sidebar.tsx` | `apps/diffshub/components/DiffsHubSidebar.tsx` |
| `web/src/app/worker-pool.tsx` | `apps/diffshub/components/WorkerPoolProvider.tsx` |
| `web/src/app/scrollbar-gutter.tsx` | `apps/diffshub/components/ScrollbarGutterVariables.tsx` |
| `web/src/features/conversations/conversation-list.tsx` | `apps/diffshub/components/DiffsHubCommentsList.tsx` |
| `web/src/features/conversations/conversation-card.tsx` | `apps/diffshub/components/ExampleAnnotation.tsx` |
| `web/src/features/conversations/draft-comment.tsx` | `apps/diffshub/components/DraftAnnotation.tsx` |
| `web/src/features/conversations/annotation.ts` | `apps/diffshub/lib/annotation.ts` |
| `web/src/features/viewer/viewer.tsx` | `apps/diffshub/components/DiffsHubViewer.tsx` |
| `web/src/features/viewer/review-status.tsx` | `apps/diffshub/components/DiffsHubStatusPanel.tsx` |
| `web/src/features/viewer/review-data.ts` | `apps/diffshub/lib/diffsHubDataAccumulator.ts` |
| `web/src/components/ui/button.tsx` | `apps/diffshub/components/Button.tsx` |
| `web/src/components/ui/button-styles.ts` | `apps/diffshub/components/chromeButtonStyles.ts` |
| `web/src/components/ui/input.tsx` | `apps/diffshub/components/Input.tsx` |
| `web/src/components/ui/switch.tsx` | `apps/diffshub/components/Switch.tsx` |
| `web/src/components/ui/dropdown-menu.tsx` | `apps/diffshub/components/DropdownMenu.tsx` |
| `web/src/components/ui/dialog.tsx` | `apps/docs/components/ui/dialog.tsx` |
| `web/src/components/tree.tsx` | `apps/diffshub/components/DiffsHubFileTree.tsx` |
| `web/src/lib/review-types.ts` | `apps/diffshub/lib/types.ts` |
| `web/src/lib/cn.ts` | `apps/diffshub/lib/cn.ts` |
| `web/src/lib/code-view.ts` | `apps/diffshub/lib/constants.ts` |
| `web/src/lib/git-status.ts` | `apps/diffshub/lib/mapChangeTypeToGitStatus.ts` |
| `web/src/lib/tree-source.ts` | `apps/diffshub/lib/filterDiffsHubFileTreeSource.ts` |
| `web/src/lib/gutter-detector.ts` | `apps/diffshub/lib/gutterDetector.ts` |
| `web/src/lib/theme/theme-root.tsx` | `apps/diffshub/components/ThemeProvider.tsx`, `apps/diffshub/components/ThemeSourceProvider.tsx`, `apps/diffshub/components/themeController.ts` |
| `web/src/lib/theme/chrome-tokens.ts` | `apps/diffshub/lib/theme/deriveChromeTokens.ts` |
| `web/src/lib/theme/theme-names.ts` | `apps/diffshub/lib/themeNames.ts` |

## Pierre npm packages

These packages are consumed as npm dependencies and bundled into Gitna's
embedded frontend. `@pierre/diffs` and `@pierre/trees` are modified under
Apache-2.0 through reproducible pnpm patches in `web/patches/`. The Diffs patch
adds a preview body slot, visible invalid-regex feedback in the built-in editor
search, bounded large-file editing, plain-text edit refresh, and a gutter **+**
that follows the hovered line. The Trees patch adds a generic public
interactive row-action renderer with semantic action buttons and hover/focus
styling, on-demand folder loading, `<div>` row elements, and grapheme-safe
middle truncation, while preserving Pierre's row rendering, focus, selection
and virtualization ownership. `@radix-ui/react-dismissable-layer` (MIT) is
patched so Escape closes the topmost layer even as it opens.
`web/patches/README.md` describes all three patches. The other packages are
distributed unmodified.

| Package | Installed version | Package license evidence | Required distribution material |
| --- | --- | --- | --- |
| `@pierre/diffs` | `1.7.0-beta.4` + Gitna patch | `web/node_modules/@pierre/diffs/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`, `web/patches/@pierre__diffs@1.7.0-beta.4.patch`; the package contains no NOTICE file. |
| `@pierre/trees` | `1.0.0` + Gitna patch | `web/node_modules/@pierre/trees/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`, `web/patches/@pierre__trees@1.0.0.patch`, and the `@pierre/trees` notice below. |
| `@pierre/highlights` | `0.5.1` | `web/node_modules/@pierre/highlights/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; `LICENSES/pierre-highlights-NOTICE.md` preserves its upstream theme notices. |
| `@pierre/words` | `0.2.2` | `web/node_modules/@pierre/words/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; `LICENSES/pierre-words-NOTICE.md` preserves its data notices. |
| `@pierre/theming` | `1.0.2` shared by Gitna, Diffs, and Trees | `web/node_modules/@pierre/theming/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; the package contains no NOTICE file. |
| `@pierre/theme` | `2.0.0` | `web/node_modules/@pierre/theme/LICENSE`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt` and the `@pierre/theme` notice below. |
| `@pierre/icons` | `0.9.0` | `web/node_modules/@pierre/icons/LICENSE`; package metadata declares `Apache-2.0` | `LICENSES/pierre-icons-Apache-2.0.txt`; the package contains no NOTICE file. |

Gitna keeps the shared Apache-2.0 license text at `LICENSES/Apache-2.0.txt`.
The generated inventory includes the license text for each installed package.
Highlights' theme credits remain in `LICENSES/pierre-highlights-NOTICE.md`,
and Words' data notices in `LICENSES/pierre-words-NOTICE.md`.
Icons includes its own copyright attribution;
its full license is kept at `LICENSES/pierre-icons-Apache-2.0.txt`.
The Trees and Theme notices are
reproduced verbatim below because they contain distinct upstream attribution.
Their shared MIT license text is also available at `LICENSES/MIT.txt`.

## Geist font

Gitna incorporates `Geist-Variable.woff2` from `geist@1.5.1`, Copyright 2023
Vercel in collaboration with basement.studio. Geist is licensed under the SIL
Open Font License 1.1; the verbatim license is at `LICENSES/OFL-1.1.txt`.

## ACP Go SDK

Gitna uses `github.com/caelis-labs/acp-go-sdk` at `v1.7.0` under Apache-2.0.
Its license is included in `THIRD_PARTY_LICENSES.txt`. Its upstream notice is
reproduced below.

## Distribution requirement

Release archives include `LICENSE`, this file, the shared license texts in
`LICENSES/`, the reproducible Pierre patches in `patches/`, and
`THIRD_PARTY_LICENSES.txt`. The generated inventory records
every production npm package, every Go module, and the checked-in Geist font,
together with their applicable license texts. Regenerate it after dependency changes with
`node scripts/generate-third-party-licenses.mjs`.

## Verbatim upstream notices

### ACP Go SDK notice

```
ACP Go SDK
Copyright 2026 Caelis Labs

This product includes software derived from coder/acp-go-sdk,
Copyright Coder Technologies, Inc., licensed under the Apache License 2.0:
https://github.com/coder/acp-go-sdk

Generated protocol definitions are derived from the Agent Client Protocol
JSON Schema, licensed under the Apache License 2.0:
https://github.com/agentclientprotocol/agent-client-protocol
```

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
