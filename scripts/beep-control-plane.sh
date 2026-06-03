#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${BEEP_CONTROL_PLANE_STATE_DIR:-$ROOT_DIR/.beep-dev/control-plane}"
PID_FILE="$STATE_DIR/control-plane.pid"
LOG_FILE="$STATE_DIR/control-plane.log"
CONTROL_PLANE_HOST="${BEEP_CONTROL_PLANE_HOST:-127.0.0.1}"
CONTROL_PLANE_PORT="${BEEP_CONTROL_PLANE_PORT:-8788}"
if [ "$CONTROL_PLANE_HOST" = "::1" ]; then
  URL="http://[::1]:$CONTROL_PLANE_PORT"
else
  URL="http://$CONTROL_PLANE_HOST:$CONTROL_PLANE_PORT"
fi
RUNTIME_ID="${BEEP_CONTROL_PLANE_RUNTIME_ID:-local}"
COMMAND="${1:-foreground}"

usage() {
  cat >&2 <<EOF
usage: beep-control-plane.sh [start|stop|restart|status|logs|foreground|operator-token|runtime-token|runtime-api-token|model-credential-token]
EOF
}

ensure_runtime_env() {
  # shellcheck source=scripts/runtime-dev-env.sh
  source "$ROOT_DIR/scripts/runtime-dev-env.sh"
  mkdir -p "$STATE_DIR"
}

running_pid() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if [ -z "$pid" ] || ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi
  printf '%s\n' "$pid"
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "$URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

is_loopback_control_plane_host() {
  case "$CONTROL_PLANE_HOST" in
    127.0.0.1|localhost|::1)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

health_matches_runtime() {
  local health_payload="$1"
  node --input-type=module - "$RUNTIME_ID" "$health_payload" <<'NODE'
const [runtimeId, healthPayload] = process.argv.slice(2);
let health;
try {
  health = JSON.parse(healthPayload);
} catch {
  process.exit(1);
}

if (health?.service === "beep-control-plane" && health?.runtimeId === runtimeId) {
  process.exit(0);
}

process.exit(1);
NODE
}

start() {
  ensure_runtime_env
  if pid="$(running_pid)"; then
    echo "beep-control-plane already running pid=$pid url=$URL"
    return 0
  fi
  export BEEP_CONTROL_PLANE_AUTOSTART="${BEEP_CONTROL_PLANE_AUTOSTART:-1}"
  nohup node "$ROOT_DIR/control-plane/src/server.mjs" >>"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  if wait_for_health; then
    echo "beep-control-plane started pid=$(cat "$PID_FILE") url=$URL"
  else
    echo "beep-control-plane did not become healthy; see $LOG_FILE" >&2
    exit 1
  fi
}

stop() {
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    echo "beep-control-plane is not running"
    return 0
  fi
  kill "$pid"
  local attempt
  for attempt in $(seq 1 30); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      rm -f "$PID_FILE"
      echo "beep-control-plane stopped"
      return 0
    fi
    sleep 1
  done
  echo "beep-control-plane did not stop after TERM; pid=$pid" >&2
  exit 1
}

status() {
  if pid="$(running_pid)"; then
    echo "process: running pid=$pid"
  else
    echo "process: stopped"
  fi
  local health_payload
  if health_payload="$(curl -fsS "$URL/health")"; then
    printf '%s\n' "$health_payload"
    if ! is_loopback_control_plane_host; then
      echo "status: refusing authenticated runtime status for non-loopback BEEP_CONTROL_PLANE_HOST=$CONTROL_PLANE_HOST" >&2
      return 0
    fi
    if ! health_matches_runtime "$health_payload"; then
      echo "status: refusing authenticated runtime status because /health is not beep-control-plane for runtimeId=$RUNTIME_ID" >&2
      return 0
    fi
    local operator_token
    operator_token="$(state_store_token ensureOperatorToken)"
    curl -fsS \
      -H "authorization: Bearer $operator_token" \
      "$URL/api/runtimes/$RUNTIME_ID" || true
  else
    echo "health: unavailable"
  fi
}

logs() {
  mkdir -p "$STATE_DIR"
  local lines="${2:-120}"
  if [ ! -f "$LOG_FILE" ]; then
    echo "no log file at $LOG_FILE"
    return 0
  fi
  tail -n "$lines" "$LOG_FILE"
}

foreground() {
  ensure_runtime_env
  export BEEP_CONTROL_PLANE_AUTOSTART="${BEEP_CONTROL_PLANE_AUTOSTART:-1}"
  exec node "$ROOT_DIR/control-plane/src/server.mjs"
}

operator_token() {
  state_store_token ensureOperatorToken
}

state_store_token() {
  local method="$1"
  ensure_runtime_env
  node --input-type=module - "$ROOT_DIR" "$STATE_DIR" "$method" <<'NODE'
import { pathToFileURL } from "node:url";

const [rootDir, stateDir, method] = process.argv.slice(2);
const { StateStore } = await import(pathToFileURL(`${rootDir}/control-plane/src/state-store.mjs`));
const store = new StateStore(stateDir);
process.stdout.write(`${store[method]()}\n`);
NODE
}

case "$COMMAND" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    start
    ;;
  status)
    status
    ;;
  logs)
    logs "$@"
    ;;
  foreground)
    foreground
    ;;
  operator-token)
    operator_token
    ;;
  runtime-token)
    state_store_token ensureRuntimeToken
    ;;
  runtime-api-token)
    state_store_token ensureRuntimeApiToken
    ;;
  model-credential-token)
    state_store_token ensureModelCredentialToken
    ;;
  *)
    usage
    exit 2
    ;;
esac
