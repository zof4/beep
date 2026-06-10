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

wait_for_api_health() {
  local output_file="$1"
  local health_url="http://127.0.0.1:8787/health"

  for _ in {1..60}; do
    if curl -fsS "$health_url" >"$output_file"; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for Beep runtime API health at $health_url." >&2
  return 1
}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to print final Hindsight + LCM telemetry." >&2
  exit 1
fi

node "$ROOT_DIR/scripts/validate-codex-auth.mjs" \
  --require-tokens-access-token \
  --usage "Hindsight LCM smoke direct runtime" \
  "$ROOT_DIR/.beep-dev/state/codex/auth.json"

export BEEP_ALLOW_RUNTIME_CODEX_AUTH=1

export BEEP_RUNTIME_API_TOKEN="${BEEP_RUNTIME_API_TOKEN:-}"
if [[ -z "$BEEP_RUNTIME_API_TOKEN" ]]; then
  BEEP_RUNTIME_API_TOKEN="beep-hindsight-lcm-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  export BEEP_RUNTIME_API_TOKEN
fi

runtime_api_auth=(-H "authorization: Bearer $BEEP_RUNTIME_API_TOKEN")

"${compose[@]}" up --build -d hindsight beep-runtime-api

wait_for_api_health /tmp/beep-health.json

curl -fsS \
  "${runtime_api_auth[@]}" \
  -X POST http://127.0.0.1:8787/agent/submit \
  -H 'content-type: application/json' \
  -d '{
    "message": "Remember this Beep project rule: Hindsight must run as one local stock sidecar, Hindsight recall must feed LCM as ephemeral context, and LCM remains the final context manager. Create hindsight-lcm-proof-seed.txt with the word seeded.",
    "waitForCompletion": true,
    "timeoutMs": 600000
  }' >/tmp/beep-hindsight-seed.json

curl -fsS \
  "${runtime_api_auth[@]}" \
  -X POST http://127.0.0.1:8787/agent/lcm/compact \
  -H 'content-type: application/json' \
  -d '{"force":true,"tokenBudget":2048,"currentTokenCount":4096}' >/tmp/beep-hindsight-compact.json || true

"${compose[@]}" restart beep-runtime-api
wait_for_api_health /tmp/beep-health-after-restart.json

curl -fsS \
  "${runtime_api_auth[@]}" \
  -X POST http://127.0.0.1:8787/agent/submit \
  -H 'content-type: application/json' \
  -d '{
    "message": "Continue the memory integration according to the project rule I gave earlier. Create hindsight-lcm-proof-recall.txt summarizing that rule in one sentence.",
    "waitForCompletion": true,
    "timeoutMs": 600000
  }' >/tmp/beep-hindsight-recall.json

curl -fsS \
  "${runtime_api_auth[@]}" \
  http://127.0.0.1:8787/agent/summary >/tmp/beep-hindsight-summary.json

jq '.summary.hindsightMemory.latest, .summary.lcmContextInjection.latest' /tmp/beep-hindsight-summary.json
