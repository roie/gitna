#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <version> [output-directory]" >&2
  exit 2
fi

version="${1#v}"
output_dir="${2:-dist}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid release version: $1" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

pnpm --dir web install --frozen-lockfile
pnpm --dir web build
node scripts/generate-third-party-licenses.mjs
git diff --exit-code -- THIRD_PARTY_LICENSES.txt

package_linux() {
  local arch="$1"
  local asset_arch="$2"
  local stage
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' RETURN

  GOOS=linux GOARCH="$arch" CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags "-s -w -X main.version=$version" \
    -o "$stage/gitna" \
    ./cmd/gitna

  cp LICENSE README.md THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt "$stage/"
  cp -R LICENSES "$stage/"
  tar -C "$stage" -czf "$output_dir/gitna_${version}_linux_${asset_arch}.tar.gz" .
  if [[ "$asset_arch" == "x64" ]]; then
    node scripts/package-npm.mjs "$version" "linux-$asset_arch" "$stage/gitna" "$output_dir" --main
  else
    node scripts/package-npm.mjs "$version" "linux-$asset_arch" "$stage/gitna" "$output_dir"
  fi
  rm -rf "$stage"
  trap - RETURN
}

package_linux amd64 x64
package_linux arm64 arm64
