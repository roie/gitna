# Third-Party Notices

Gitna itself is licensed under Apache-2.0 as stated in `LICENSE`. This file
records notices and provenance for third-party material incorporated into or
distributed with Gitna. Source adaptations and packaged dependencies are
listed separately because they have different provenance requirements.

## Pierre DiffsHub source adaptations

Gitna's DiffsHub donor is pinned to:

- Repository: [pierrecomputer/pierre](https://github.com/pierrecomputer/pierre)
- Tag: `diffs-v1.3.5`
- Commit: `59ec35ffac97abccef4c69f8d58d3747cbfbc6cb`
- License: Apache-2.0, Copyright 2025 Pierre Computer Company
- Verbatim license: `LICENSES/Apache-2.0.txt`

The following table covers source already modified and incorporated into this
repository. Each local source file carries a prominent modified-file notice.

| Exact upstream path at the pinned commit | Local destination | Modification summary |
| --- | --- | --- |
| `apps/diffshub/lib/theme/deriveChromeTokens.ts`; `apps/diffshub/lib/theme/diffshubChromeMapping.ts` | `web/src/lib/chrome-theme.ts` | Ported the token derivation and CSS-variable mapping to framework-neutral TypeScript; removed React `CSSProperties`; applies the resulting variables to Gitna's document root. |
| `apps/diffshub/components/Button.tsx` | `web/src/components/Button.svelte` | Ported the React/Tailwind/CVA button contract to Svelte and component-scoped CSS while retaining variants, sizes, and interaction states. |
| `apps/diffshub/components/Input.tsx` | `web/src/components/Input.svelte` | Ported the React/Tailwind input contract to Svelte and component-scoped CSS. |
| `apps/diffshub/components/Switch.tsx` | `web/src/components/Switch.svelte` | Replaced React/Radix wiring with a native Svelte switch while retaining the donor sizing and visual states. |
| `apps/diffshub/app/globals.css` | `web/src/app.css` | Adapted the DiffsHub chrome variable vocabulary into Gitna fallback values and system dark/light behavior. |

## Pinned DiffsHub donor inventory

The recovery plan requires inspecting these exact donor files before equivalent
Gitna chrome is implemented. A `planned` row is provenance inventory only: no
source from that row has been copied yet. When a planned adaptation is created,
its concrete local destination, modification summary, and prominent modified-file
notice must be added to the source-adaptation table above.

| Donor responsibility | Exact upstream path at the pinned commit | Current status |
| --- | --- | --- |
| Button | `apps/diffshub/components/Button.tsx` | Adapted as recorded above; Milestone 3 must reconcile it mechanically with the pinned donor. |
| Input | `apps/diffshub/components/Input.tsx` | Adapted as recorded above; Milestone 3 must reconcile it mechanically with the pinned donor. |
| Dropdown menu | `apps/diffshub/components/DropdownMenu.tsx` | Planned; do not import its React/Radix runtime. |
| Switch | `apps/diffshub/components/Switch.tsx` | Adapted as recorded above; Milestone 3 must reconcile it mechanically with the pinned donor. |
| Themed surface | `apps/diffshub/components/ThemedSurface.tsx` | Planned Svelte adaptation. |
| Chrome icon-button styles | `apps/diffshub/components/chromeButtonStyles.ts` | Planned Svelte/CSS adaptation. |
| Theme catalog and persistence controller | `apps/diffshub/components/themeCatalog.ts`; `apps/diffshub/components/themeController.ts` | Planned framework-neutral adaptation. |
| Chrome theme hook behavior | `apps/diffshub/components/useChromeThemeProps.ts` | Planned behavior port without React hooks. |
| Active theme source contract | `apps/diffshub/lib/theme/ThemeSource.ts` | Planned framework-neutral adaptation. |
| Chrome mapping helpers | `apps/diffshub/lib/theme/chromeThemeProps.ts`; `apps/diffshub/lib/theme/deriveChromeTokens.ts`; `apps/diffshub/lib/theme/diffshubChromeMapping.ts`; `apps/diffshub/lib/theme/dropdownChromeStyle.ts` | Token derivation and DiffsHub mapping are adapted as recorded above; remaining helper behavior is planned. |
| Global chrome CSS | `apps/diffshub/app/globals.css` | Partially adapted as recorded above; Milestone 3 must mechanically reconcile applicable review chrome, surfaces, scrollbars, and responsive rules. |

The broader review composition donor paths are enumerated in
`docs/superpowers/plans/2026-08-20-gitna-recovery-plan.md`. This inventory is
intentionally limited to the chrome primitives and theme helpers required by
Milestone 0.

## Pierre npm packages

These packages are consumed as npm dependencies and bundled into Gitna's
embedded frontend. Their package use is not a claim that their renderer source
was copied into Gitna.

| Package | Installed version | Package license evidence | Required distribution material |
| --- | --- | --- | --- |
| `@pierre/diffs` | `1.3.5` | `web/node_modules/@pierre/diffs/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; the package contains no NOTICE file. |
| `@pierre/trees` | `1.0.0-beta.6` | `web/node_modules/@pierre/trees/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt` and the `@pierre/trees` notice below. |
| `@pierre/theme` | `2.0.0` | `web/node_modules/@pierre/theme/LICENSE`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt` and the `@pierre/theme` notice below. |
| `@pierre/theming` | `1.0.1` | `web/node_modules/@pierre/theming/LICENSE.md`; package metadata declares `apache-2.0` | `LICENSES/Apache-2.0.txt`; the package contains no NOTICE file. |

The Apache-2.0 text shipped by the pinned DiffsHub app and all four installed
Pierre packages is byte-identical, so Gitna keeps one verbatim shared copy at
`LICENSES/Apache-2.0.txt`. The Trees and Theme notices are reproduced verbatim
below because they contain distinct upstream attribution. Their shared MIT
license text is also available at `LICENSES/MIT.txt`.

## Distribution requirement

Release archives must include `LICENSE`, this file, and the license texts in
`LICENSES/`.

Milestone 6 owns packaging automation and the complete dependency-license scan.
Until that automation exists, these files are explicit release inputs, not proof
that every non-Pierre transitive frontend dependency has already been audited.

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
