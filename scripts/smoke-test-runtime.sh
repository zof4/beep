#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/runtime-dev-env.sh"

docker compose -f "$ROOT_DIR/docker/compose.runtime-dev.yml" up --build --abort-on-container-exit --remove-orphans
