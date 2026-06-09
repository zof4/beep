#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beep-host-loop-sandbox-smoke.XXXXXX")"
printf 'Smoke output directory: %s\n' "$OUT_DIR"

choose_control_plane_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
}

export BEEP_CONTROL_PLANE_HOST="${BEEP_CONTROL_PLANE_HOST:-127.0.0.1}"
export BEEP_CONTROL_PLANE_PORT="${BEEP_CONTROL_PLANE_PORT:-$(choose_control_plane_port)}"
export BEEP_CONTROL_PLANE_STATE_DIR="${BEEP_CONTROL_PLANE_STATE_DIR:-$OUT_DIR/control-plane-state}"
export BEEP_CONTROL_PLANE_AUTOSTART="${BEEP_CONTROL_PLANE_AUTOSTART:-0}"
export BEEP_RUNTIME_COMPOSE_SERVICE="${BEEP_RUNTIME_COMPOSE_SERVICE:-beep-host-loop}"
export BEEP_RUNTIME_AUTO_UPDATE="${BEEP_RUNTIME_AUTO_UPDATE:-0}"
export BEEP_HOST_LOOP_HINDSIGHT_ENABLED="${BEEP_HOST_LOOP_HINDSIGHT_ENABLED:-0}"
export BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT="${BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT:-$ROOT_DIR/.beep-dev/workspace/sandboxes}"

if [ "$BEEP_CONTROL_PLANE_HOST" = "::1" ]; then
  CONTROL_PLANE_URL="${BEEP_CONTROL_PLANE_URL:-http://[::1]:$BEEP_CONTROL_PLANE_PORT}"
else
  CONTROL_PLANE_URL="${BEEP_CONTROL_PLANE_URL:-http://$BEEP_CONTROL_PLANE_HOST:$BEEP_CONTROL_PLANE_PORT}"
fi
RUNTIME_API_URL="${BEEP_RUNTIME_API_URL:-http://127.0.0.1:8787}"
RUNTIME_ID="${BEEP_CONTROL_PLANE_RUNTIME_ID:-local}"
SESSION_ID="${BEEP_HOST_LOOP_SMOKE_SESSION_ID:-agent_beep}"

compose=(
  docker compose
  --env-file "$ROOT_DIR/docker/hindsight-image.env"
  -f "$ROOT_DIR/docker/compose.runtime-dev.yml"
)

cleanup() {
  if [ "${BEEP_HOST_LOOP_SMOKE_KEEP_CONTROL_PLANE:-0}" = "1" ]; then
    return
  fi
  "$ROOT_DIR/scripts/beep-control-plane.sh" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local output_file="$2"
  local label="$3"
  local error_file="$output_file.err"

  for _ in $(seq 1 90); do
    if curl -fsS "$url" >"$output_file" 2>"$error_file"; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for $label at $url." >&2
  if [ -s "$error_file" ]; then
    cat "$error_file" >&2
  fi
  return 1
}

require_text() {
  local pattern="$1"
  local file="$2"
  local label="$3"

  if ! grep -q "$pattern" "$file"; then
    echo "Expected $label to contain pattern: $pattern" >&2
    echo "File: $file" >&2
    exit 1
  fi
}

auth_request() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local status

  status="$(
    curl -sS \
      -o "$output_file" \
      -w "%{http_code}" \
      -X "$method" \
      "$CONTROL_PLANE_URL$path" \
      -H "authorization: Bearer $operator_token"
  )"

  case "$status" in
    2??)
      return 0
      ;;
    *)
      echo "Request $method $path failed with HTTP $status." >&2
      if [ -s "$output_file" ]; then
        cat "$output_file" >&2
      fi
      exit 1
      ;;
  esac
}

"$ROOT_DIR/scripts/beep-control-plane.sh" stop >/dev/null 2>&1 || true
"${compose[@]}" --profile legacy-api stop beep-runtime-api >/dev/null 2>&1 || true
"$ROOT_DIR/scripts/beep-control-plane.sh" restart

operator_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" operator-token)"
runtime_api_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-api-token)"

if [ -z "$operator_token" ] || [ -z "$runtime_api_token" ]; then
  echo "Control-plane tokens were not available." >&2
  exit 1
fi

wait_for_url "$CONTROL_PLANE_URL/health" "$OUT_DIR/control-plane-health.json" "control-plane health"
auth_request POST "/api/runtimes/$RUNTIME_ID/start" "$OUT_DIR/runtime-start.json"
require_text '"running": true' "$OUT_DIR/runtime-start.json" "runtime start response"
wait_for_url "$RUNTIME_API_URL/health" "$OUT_DIR/runtime-health.json" "runtime API health"

host_loop_container_id="$(
  docker ps \
    --filter "label=com.docker.compose.service=beep-host-loop" \
    --format '{{.ID}}' \
    | head -n 1
)"

if [ -z "$host_loop_container_id" ]; then
  echo "No running beep-host-loop container found after runtime health became available." >&2
  exit 1
fi

curl -fsS "$CONTROL_PLANE_URL/api/backend/status" \
  -H "authorization: Bearer $operator_token" \
  >"$OUT_DIR/status-before.json"

curl -fsS "$RUNTIME_API_URL/internal/sandbox/tools/call" \
  -H "authorization: Bearer $runtime_api_token" \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"toolCallId\":\"smoke_write\",\"toolName\":\"write\",\"args\":{\"path\":\"proof.txt\",\"content\":\"host-loop-sandbox-ok\n\"},\"timeoutMs\":5000}" \
  >"$OUT_DIR/write.json"

require_text "Successfully wrote" "$OUT_DIR/write.json" "write result"

container_id="$(
  docker ps \
    --filter "label=beep.sandbox.session=$SESSION_ID" \
    --format '{{.ID}}' \
    | head -n 1
)"

if [ -z "$container_id" ]; then
  echo "No sandbox container found for $SESSION_ID." >&2
  exit 1
fi

docker kill "$container_id" >/dev/null

curl -fsS "$CONTROL_PLANE_URL/api/backend/status" \
  -H "authorization: Bearer $operator_token" \
  >"$OUT_DIR/status-after-kill.json"

require_text '"ok": true' "$OUT_DIR/status-after-kill.json" "backend status after sandbox kill"

curl -fsS "$RUNTIME_API_URL/internal/sandbox/tools/call" \
  -H "authorization: Bearer $runtime_api_token" \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"$SESSION_ID\",\"toolCallId\":\"smoke_read\",\"toolName\":\"read\",\"args\":{\"path\":\"proof.txt\"},\"timeoutMs\":5000}" \
  >"$OUT_DIR/read-after-restart.json"

require_text "host-loop-sandbox-ok" "$OUT_DIR/read-after-restart.json" "read result after sandbox restart"

echo "host-loop sandbox smoke passed; outputs in $OUT_DIR"
