#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${BEEP_CONTROL_PLANE_STATE_DIR:-$ROOT_DIR/.beep-dev/control-plane}"
PID_FILE="$STATE_DIR/control-plane.pid"
LOG_FILE="$STATE_DIR/control-plane.log"
URL="http://${BEEP_CONTROL_PLANE_HOST:-127.0.0.1}:${BEEP_CONTROL_PLANE_PORT:-8788}"
COMMAND="${1:-foreground}"

usage() {
  cat >&2 <<EOF
usage: beep-control-plane.sh [start|stop|restart|status|logs|foreground|operator-token]
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
  if curl -fsS "$URL/health"; then
    curl -fsS "$URL/api/runtimes/local" || true
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
  local token_file="$STATE_DIR/operator-token"
  if [ ! -f "$token_file" ]; then
    echo "operator token does not exist yet; start the control plane first" >&2
    exit 1
  fi
  cat "$token_file"
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
  *)
    usage
    exit 2
    ;;
esac
