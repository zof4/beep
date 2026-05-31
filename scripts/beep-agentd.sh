#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p \
  "$ROOT_DIR/.beep-dev/workspace" \
  "$ROOT_DIR/.beep-dev/lcm" \
  "$ROOT_DIR/.beep-dev/history" \
  "$ROOT_DIR/.beep-dev/hindsight" \
  "$ROOT_DIR/.beep-dev/state"

cd "$ROOT_DIR/docker"
exec docker compose --env-file "$ROOT_DIR/docker/hindsight-image.env" -f compose.runtime-dev.yml up --build beep-runtime-api
