#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p \
  "$ROOT_DIR/.beep-dev/workspace" \
  "$ROOT_DIR/.beep-dev/lcm" \
  "$ROOT_DIR/.beep-dev/history" \
  "$ROOT_DIR/.beep-dev/state" \
  "$ROOT_DIR/.beep-dev/state/codex" \
  "$ROOT_DIR/.beep-dev/hindsight"

compose=(
  docker compose
  --env-file "$ROOT_DIR/docker/hindsight-image.env"
  -f "$ROOT_DIR/docker/compose.runtime-dev.yml"
)

if "${compose[@]}" up --help 2>/dev/null | grep -q -- "--wait"; then
  "${compose[@]}" up -d --wait hindsight
else
  "${compose[@]}" up -d hindsight
  hindsight_container="$("${compose[@]}" ps -q hindsight)"
  for _ in {1..60}; do
    health="$(docker inspect --format "{{.State.Health.Status}}" "$hindsight_container" 2>/dev/null || true)"
    if [[ "$health" == "healthy" ]]; then
      break
    fi
    if [[ "$health" == "unhealthy" ]]; then
      echo "Hindsight sidecar became unhealthy." >&2
      exit 1
    fi
    sleep 2
  done
  if [[ "$health" != "healthy" ]]; then
    echo "Timed out waiting for Hindsight sidecar health." >&2
    exit 1
  fi
fi

"${compose[@]}" run --build --rm beep-runtime beep-hindsight-smoke "$@"
