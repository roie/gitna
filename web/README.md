# Gitna frontend

Gitna's frontend is a React 19/Vite application derived mechanically from the
pinned DiffsHub `diffs-v1.3.5` source. Vite emits static assets to
`../internal/webui/dist`; Go embeds that directory into the native executable.
There is no production Node.js or Next.js runtime.

Gitna keeps the donor DiffsHub header, responsive sidebar, file tree,
continuous CodeView, comments, themes, diff stats, worker monitor, controls and
interaction primitives. Typed adapters under `src/diffshub/gitna` connect
those presentation components to the local Go/system-Git API and add the VS
Code Source Control workflow.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm exec playwright test
```
