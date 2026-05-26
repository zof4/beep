#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${BEEP_RUNTIME_UPDATE_STATE_DIR:-$ROOT_DIR/.beep-dev/update-state}"
STAMP_FILE="$STATE_DIR/runtime-update.epoch"
ENV_FILE="$STATE_DIR/runtime-update.env"
INTERVAL_SECONDS="${BEEP_RUNTIME_UPDATE_INTERVAL_SECONDS:-86400}"
MODE="${1:---if-stale}"

usage() {
  echo "usage: refresh-runtime-dependencies.sh [--if-stale|--force|--status]" >&2
}

mkdir -p "$STATE_DIR"

if ! [[ "$INTERVAL_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "BEEP_RUNTIME_UPDATE_INTERVAL_SECONDS must be a positive integer." >&2
  exit 2
fi

now_epoch="$(date -u +%s)"
last_epoch="0"
if [ -f "$STAMP_FILE" ]; then
  last_epoch="$(cat "$STAMP_FILE")"
elif [ -f "$ENV_FILE" ]; then
  last_epoch="$(sed -n 's/^export BEEP_RUNTIME_UPDATE_EPOCH=//p' "$ENV_FILE" | tail -n 1)"
fi
last_epoch="${last_epoch:-0}"

if [ "$MODE" = "--status" ]; then
  echo "last_update_epoch=$last_epoch"
  for name in openai-codex pi lossless-claw; do
    git -C "$ROOT_DIR/vendor/$name" log -1 --format="$name %H %ci %s"
  done
  exit 0
fi

should_update=0
case "$MODE" in
  --force)
    should_update=1
    ;;
  --if-stale)
    if [ "$last_epoch" = "0" ] || [ $((now_epoch - last_epoch)) -ge "$INTERVAL_SECONDS" ]; then
      should_update=1
    fi
    ;;
  *)
    usage
    exit 2
    ;;
esac

if [ "$should_update" = "0" ]; then
  echo "Runtime dependency update skipped; last check is within ${INTERVAL_SECONDS}s."
  exit 0
fi

if ! "$ROOT_DIR/scripts/update-vendored-references.sh"; then
  if [ "${BEEP_RUNTIME_UPDATE_REQUIRED:-0}" = "1" ]; then
    exit 1
  fi
  echo "Runtime dependency update failed; continuing with current local dependencies." >&2
  exit 0
fi

printf '%s\n' "$now_epoch" > "$STAMP_FILE"
cat >"$ENV_FILE" <<EOF
export BEEP_RUNTIME_UPDATE_EPOCH=$now_epoch
EOF

echo "Runtime dependency update completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
