#!/usr/bin/env bash

if [ -z "${ROOT_DIR:-}" ]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

mkdir -p \
  "$ROOT_DIR/.beep-dev/workspace" \
  "$ROOT_DIR/.beep-dev/lcm" \
  "$ROOT_DIR/.beep-dev/history" \
  "$ROOT_DIR/.beep-dev/state" \
  "$ROOT_DIR/.beep-dev/update-state"

if [ "${BEEP_RUNTIME_AUTO_UPDATE:-1}" != "0" ]; then
  "$ROOT_DIR/scripts/refresh-runtime-dependencies.sh" --if-stale
fi

update_env="$ROOT_DIR/.beep-dev/update-state/runtime-update.env"
if [ -f "$update_env" ]; then
  # shellcheck source=/dev/null
  source "$update_env"
  export BEEP_RUNTIME_UPDATE_EPOCH
fi
