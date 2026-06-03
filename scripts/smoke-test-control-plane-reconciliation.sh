#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node --test "$ROOT_DIR"/test/*.test.mjs
node --test "$ROOT_DIR"/control-plane/test/*.test.mjs

bash -n "$ROOT_DIR/scripts/runtime-dev-env.sh"
bash -n "$ROOT_DIR/scripts/beep-control-plane.sh"

runtime_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-token)"
runtime_api_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-api-token)"
model_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" model-credential-token)"
operator_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" operator-token)"

test -n "$runtime_token"
test -n "$runtime_api_token"
test -n "$model_token"
test -n "$operator_token"
test "$runtime_token" != "$runtime_api_token"
test "$runtime_token" != "$model_token"
test "$runtime_api_token" != "$model_token"
test "$operator_token" != "$runtime_token"

cat <<'EOF'
Pure control-plane reconciliation checks passed.

For live verification with Docker and Codex auth:

  ./scripts/beep-control-plane.sh start
  ./scripts/beep-control-plane.sh status
  ./scripts/smoke-test-hindsight-lcm.sh
EOF
