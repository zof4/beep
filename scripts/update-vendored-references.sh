#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITMODULES_PATH="$ROOT_DIR/.gitmodules"

update_repo() {
  local name="$1"
  local url="$2"
  local dir="$ROOT_DIR/vendor/$name"
  local submodule_key="submodule.vendor/$name.url"

  if git config --file "$GITMODULES_PATH" --get "$submodule_key" >/dev/null 2>&1; then
    git -C "$ROOT_DIR" submodule update --init --depth 1 "vendor/$name"
    git -C "$dir" fetch --depth 1 origin main
    git -C "$dir" checkout --detach FETCH_HEAD
    git -C "$ROOT_DIR" add "vendor/$name"
  elif [[ ! -d "$dir/.git" ]]; then
    git clone --depth 1 "$url" "$dir"
  else
    git -C "$dir" fetch --depth 1 origin main
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
"$ROOT_DIR/scripts/update-hindsight-image.sh"
