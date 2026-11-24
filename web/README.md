# Gitna frontend

Gitna's frontend is a React 19 application built with Vite+, derived mechanically
from the pinned DiffsHub `diffs-v1.7.0-beta.4` source. Vite+ emits static assets to
`../internal/webui/dist`; Go embeds that directory into the native executable.
There is no production Node.js or Next.js runtime.

Gitna keeps the donor DiffsHub header, responsive sidebar, file tree,
continuous CodeView, comments, themes, diff stats, worker monitor, controls and
interaction primitives. `src/app` composes the workbench, `src/features` holds
its features, and `src/components` holds shared UI. `src/repository` manages
Git and file state using the local Go/system-Git API; `src/lib` holds shared
contracts and helpers.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm exec playwright test
```

These scripts use the project-local Vite+ toolchain. You can also run
`pnpm exec vp dev`, `pnpm exec vp check`, `pnpm exec vp test`, and
`pnpm exec vp build`. `vp check` combines formatting, linting, and type checks;
`pnpm check` retains the explicit TypeScript project checks.

Node.js and pnpm versions are managed by the root `mise.toml`, not Vite+.
