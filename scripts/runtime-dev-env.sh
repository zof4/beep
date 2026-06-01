#!/usr/bin/env bash

if [ -z "${ROOT_DIR:-}" ]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

mkdir -p \
  "$ROOT_DIR/.beep-dev/workspace" \
  "$ROOT_DIR/.beep-dev/lcm" \
  "$ROOT_DIR/.beep-dev/hindsight" \
  "$ROOT_DIR/.beep-dev/history" \
  "$ROOT_DIR/.beep-dev/codex-empty" \
  "$ROOT_DIR/.beep-dev/state" \
  "$ROOT_DIR/.beep-dev/update-state"

if [ ! -f "$ROOT_DIR/.beep-dev/codex-empty/config.toml" ]; then
  umask 077
  {
    printf 'approval_policy = "never"\n'
    printf 'sandbox_mode = "workspace-write"\n'
    printf 'cli_auth_credentials_store = "file"\n'
  } > "$ROOT_DIR/.beep-dev/codex-empty/config.toml"
fi

if [ "${BEEP_RUNTIME_AUTO_UPDATE:-1}" != "0" ] && [ -x "$ROOT_DIR/scripts/refresh-runtime-dependencies.sh" ]; then
  "$ROOT_DIR/scripts/refresh-runtime-dependencies.sh" --if-stale
fi

update_env="$ROOT_DIR/.beep-dev/update-state/runtime-update.env"
if [ -f "$update_env" ]; then
  BEEP_RUNTIME_UPDATE_EPOCH="$(
    awk -F= '$1 == "BEEP_RUNTIME_UPDATE_EPOCH" {
      value = substr($0, index($0, "=") + 1)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }' "$update_env"
  )"
  export BEEP_RUNTIME_UPDATE_EPOCH
fi
