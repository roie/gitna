# Contributing to Gitna

## Development setup

Gitna uses Go for the native application and React, TypeScript, and Vite for the embedded frontend. Tool versions are pinned in [`mise.toml`](mise.toml).

```sh
mise install
pnpm --dir web install --frozen-lockfile
```

Build the frontend before the Go application because the generated assets are embedded in the executable:

```sh
pnpm --dir web build
go build ./cmd/gitna
```

Run the application from a Git repository:

```sh
go run ./cmd/gitna /path/to/repository
```

## Validation

Run the standard checks before opening a pull request:

```sh
pnpm --dir web check
pnpm --dir web lint
pnpm --dir web test
pnpm --dir web format:check
web/node_modules/.bin/tsc -p tsconfig.json
go vet ./...
go test ./...
go test -race ./...
```

Browser tests use a disposable real Git repository and a production frontend build:

```sh
pnpm --dir web exec playwright install chromium
pnpm --dir web test:e2e
```

## Packaging

Create Linux x64 and arm64 release archives and npm tarballs with:

```sh
./scripts/package.sh 0.1.0
```

Create the Windows x64 archive and npm tarball from PowerShell with:

```powershell
./scripts/package.ps1 0.1.0
```

Release archives contain the native executable, README, and required license notices. npm distribution uses a small launcher package plus one native package per supported platform.

## Release process

1. Run CI on the release candidate commit.
2. Confirm npm trusted publishing authorizes `.github/workflows/release.yml` in `roie/gitna`.
3. Perform the WSL receipt below.
4. Create an annotated `v<version>` tag on the accepted commit.
5. Push only that tag.
6. Verify the GitHub Release archives, checksums, npm packages, and installation paths.

The tag workflow builds and smoke-tests the exact Linux and Windows release archives before publishing. Do not reuse a published npm version or move a published release tag.

npm publishing uses GitHub Actions OIDC trusted publishing; do not add a long-lived publish token.

## WSL release receipt

1. Install the Linux release archive inside WSL.
2. Open a repository stored on the WSL Linux filesystem.
3. Run `gitna .`.
4. Confirm the session opens in the normal Windows browser through localhost.
5. Stage, unstage, commit, expand a Graph commit, and inspect a split diff.
6. Confirm no Node.js runtime, WSLg application, FUSE mount, or Windows access to `\\wsl$` is required.

## Security reports

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md), not through a public issue.
