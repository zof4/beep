#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p \
  "$ROOT_DIR/.beep-dev/workspace" \
  "$ROOT_DIR/.beep-dev/workspace/sandboxes" \
  "$ROOT_DIR/.beep-dev/lcm" \
  "$ROOT_DIR/.beep-dev/history" \
  "$ROOT_DIR/.beep-dev/hindsight" \
  "$ROOT_DIR/.beep-dev/state" \
  "$ROOT_DIR/.beep-dev/state/codex"

export BEEP_RUNTIME_COMPOSE_SERVICE="${BEEP_RUNTIME_COMPOSE_SERVICE:-beep-host-loop}"
export BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT="${BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT:-$ROOT_DIR/.beep-dev/workspace/sandboxes}"
if [[ -z "${BEEP_DOCKER_GROUP_ID:-}" ]]; then
  BEEP_DOCKER_GROUP_ID="$(
    stat -f "%g" /var/run/docker.sock 2>/dev/null \
      || stat -c "%g" /var/run/docker.sock 2>/dev/null \
      || true
  )"
fi
export BEEP_DOCKER_GROUP_ID="${BEEP_DOCKER_GROUP_ID:-0}"

cd "$ROOT_DIR/docker"
exec docker compose --env-file "$ROOT_DIR/docker/hindsight-image.env" -f compose.runtime-dev.yml --profile api up --build "$BEEP_RUNTIME_COMPOSE_SERVICE"
