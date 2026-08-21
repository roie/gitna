# Gitna frontend

Gitna's frontend is built by Vite and embedded into the Go binary as static
assets.

During the DiffsHub React migration, Vite has two explicit entries:

- `index.html` — the tested Svelte Gitna and current default.
- `react.html` — the fixture-backed React baseline copied from pinned DiffsHub
  source.

The temporary React entry is intentional. Do not route extensionless paths to it
or remove the Svelte entry until the parity matrix in
`../docs/research/diffshub-react-parity.md` is complete and equivalent workflow
coverage passes.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm build
pnpm exec playwright test
```

`pnpm build` emits both entries to `../internal/webui/dist`; the Go embed then
packages the directory into the native executable. There is no production
Node.js or Next.js runtime.
