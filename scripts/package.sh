#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "usage: $0 <version> [output-directory] [linux|darwin-x64|darwin-arm64]" >&2
  exit 2
fi

version="${1#v}"
output_dir="${2:-dist}"
target="${3:-linux}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid release version: $1" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

if [[ "${GITNA_USE_PREBUILT_WEB:-0}" == "1" ]]; then
  [[ -f internal/webui/dist/index.html ]] || {
    echo "prebuilt frontend is missing internal/webui/dist/index.html" >&2
    exit 1
  }
else
  pnpm --dir web install --frozen-lockfile
  pnpm --dir web build
  node scripts/generate-third-party-licenses.mjs
  git diff --exit-code -- THIRD_PARTY_LICENSES.txt
fi

package_unix() {
  local goos="$1"
  local arch="$2"
  local asset_arch="$3"
  local stage
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' RETURN

  GOOS="$goos" GOARCH="$arch" CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags "-s -w -X main.version=$version" \
    -o "$stage/gitna" \
    ./cmd/gitna

  cp LICENSE README.md THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt "$stage/"
  cp -R LICENSES "$stage/"
  mkdir "$stage/patches"
  cp web/patches/*.patch "$stage/patches/"
  tar -C "$stage" -czf "$output_dir/gitna_${version}_${goos}_${asset_arch}.tar.gz" .
  rm -rf "$stage"
  trap - RETURN
}

case "$target" in
  linux)
    package_unix linux amd64 x64
    package_unix linux arm64 arm64
    ;;
  darwin-x64)
    package_unix darwin amd64 x64
    ;;
  darwin-arm64)
    package_unix darwin arm64 arm64
    ;;
  *)
    echo "unsupported package target: $target" >&2
    exit 2
    ;;
esac
