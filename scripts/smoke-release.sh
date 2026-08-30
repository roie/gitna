#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <gitna-binary> <expected-version>" >&2
  exit 2
fi

binary="$1"
expected_version="$2"
if [[ "$("$binary" --version)" != "$expected_version" ]]; then
  echo "packaged binary reported the wrong version" >&2
  exit 1
fi

smoke_root="$(mktemp -d)"
pid=""
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_root"
}
trap cleanup EXIT

mkdir "$smoke_root/home" "$smoke_root/folder"
printf 'macOS release smoke\n' >"$smoke_root/folder/README.txt"
HOME="$smoke_root/home" GITNA_NO_BROWSER=1 "$binary" "$smoke_root/folder" >"$smoke_root/server.log" 2>&1 &
pid=$!

url=""
for _ in {1..100}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat "$smoke_root/server.log" >&2
    wait "$pid" || true
    echo "Gitna exited before reporting its URL" >&2
    exit 1
  fi
  url="$(sed -n 's/^URL[[:space:]]*//p' "$smoke_root/server.log" | head -n 1)"
  if [[ -n "$url" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$url" ]]; then
  cat "$smoke_root/server.log" >&2
  echo "Gitna did not report its URL" >&2
  exit 1
fi
curl --fail --silent --show-error "$url" >/dev/null

kill -TERM "$pid"
for _ in {1..100}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"
    pid=""
    exit 0
  fi
  sleep 0.1
done

echo "Gitna did not shut down after SIGTERM" >&2
exit 1
