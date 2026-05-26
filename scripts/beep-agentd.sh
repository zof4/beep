#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/runtime-dev-env.sh"

cd "$ROOT_DIR/docker"
exec docker compose -f compose.runtime-dev.yml up --build beep-runtime-api
