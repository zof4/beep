#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITMODULES_PATH="$ROOT_DIR/.gitmodules"
FETCH_DEPTH="${BEEP_VENDOR_UPDATE_DEPTH:-1}"

update_repo() {
  local name="$1"
  local url="$2"
  local dir="$ROOT_DIR/vendor/$name"
  local submodule_key="submodule.vendor/$name.url"

  if git config --file "$GITMODULES_PATH" --get "$submodule_key" >/dev/null 2>&1; then
    if [[ ! -d "$dir/.git" ]]; then
      git -C "$ROOT_DIR" submodule update --init --depth "$FETCH_DEPTH" "vendor/$name"
    fi
    git -C "$dir" fetch --depth "$FETCH_DEPTH" origin main
    git -C "$dir" checkout --detach FETCH_HEAD
  elif [[ ! -d "$dir/.git" ]]; then
    git clone --depth "$FETCH_DEPTH" "$url" "$dir"
  else
    git -C "$dir" fetch --depth "$FETCH_DEPTH" origin main
    git -C "$dir" checkout --detach FETCH_HEAD
  fi

  printf '%s\n' "## $name"
  git -C "$dir" log -1 --format='commit: %H%ndate:   %ci%nsubject:%x20%s'
  printf '\n'
}

mkdir -p "$ROOT_DIR/vendor"

update_repo "openai-codex" "https://github.com/openai/codex.git"
update_repo "pi" "https://github.com/earendil-works/pi.git"
update_repo "lossless-claw" "https://github.com/martian-engineering/lossless-claw.git"
