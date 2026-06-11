#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_VENDOR_DIR="$ROOT_DIR/vendor/openai-codex"

if [[ ! -d "$CODEX_VENDOR_DIR/.git" && ! -f "$CODEX_VENDOR_DIR/.git" ]]; then
  git -C "$ROOT_DIR" submodule update --init --depth 1 vendor/openai-codex
fi

git -C "$CODEX_VENDOR_DIR" fetch --depth 1 origin main
git -C "$CODEX_VENDOR_DIR" checkout --detach FETCH_HEAD

echo "vendor/openai-codex now points at $(git -C "$CODEX_VENDOR_DIR" rev-parse HEAD)"
npm run test:tools
