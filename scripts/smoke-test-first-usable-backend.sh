#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export BEEP_RUNTIME_AUTO_UPDATE=0

CONTROL_PLANE_HOST="${BEEP_CONTROL_PLANE_HOST:-127.0.0.1}"
CONTROL_PLANE_PORT="${BEEP_CONTROL_PLANE_PORT:-8788}"
RUNTIME_ID="${BEEP_CONTROL_PLANE_RUNTIME_ID:-local}"
if [ "$CONTROL_PLANE_HOST" = "::1" ]; then
  CONTROL_PLANE_URL="http://[::1]:$CONTROL_PLANE_PORT"
else
  CONTROL_PLANE_URL="http://$CONTROL_PLANE_HOST:$CONTROL_PLANE_PORT"
fi

OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beep-first-usable-backend.XXXXXX")"
STATUS_BEFORE_FILE="$OUTPUT_DIR/backend-status-before.json"
SEED_BODY_FILE="$OUTPUT_DIR/seed-request.json"
SEED_OUTPUT_FILE="$OUTPUT_DIR/seed-response.json"
COMPACT_BODY_FILE="$OUTPUT_DIR/lcm-compact-request.json"
COMPACT_OUTPUT_FILE="$OUTPUT_DIR/lcm-compact-response.json"
RUNTIME_STOP_FILE="$OUTPUT_DIR/runtime-stop-response.json"
RUNTIME_START_FILE="$OUTPUT_DIR/runtime-start-response.json"
RECALL_BODY_FILE="$OUTPUT_DIR/recall-request.json"
RECALL_OUTPUT_FILE="$OUTPUT_DIR/recall-response.json"
STATUS_AFTER_FILE="$OUTPUT_DIR/backend-status-after.json"

auth_get() {
  local path="$1"
  local output_file="$2"
  curl -fsS \
    -H "authorization: Bearer $OPERATOR_TOKEN" \
    "$CONTROL_PLANE_URL$path" \
    >"$output_file"
}

auth_post() {
  local path="$1"
  local body_file="$2"
  local output_file="$3"
  curl -fsS -X POST \
    -H "authorization: Bearer $OPERATOR_TOKEN" \
    -H "content-type: application/json" \
    -d "@$body_file" \
    "$CONTROL_PLANE_URL$path" \
    >"$output_file"
}

node --input-type=module >"$SEED_BODY_FILE" <<'NODE'
const body = {
  message:
    "Remember this Beep project rule: the first usable backend loop must prove control-plane request submission, Hindsight recall, LCM context handling, and control-plane managed runtime restart. Keep this rule available for a later recall request.",
  waitForCompletion: true,
  timeoutMs: 900000,
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

node --input-type=module >"$COMPACT_BODY_FILE" <<'NODE'
const body = {
  force: true,
  tokenBudget: 2048,
  currentTokenCount: 4096,
  telemetry: {
    kind: "first_usable_backend_live_smoke",
    source: "control-plane",
  },
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

node --input-type=module >"$RECALL_BODY_FILE" <<'NODE'
const body = {
  message:
    "Continue from the earlier memory rule about the first usable backend loop. Summarize that rule in one concise sentence and mention the control plane, managed runtime restart, LCM, and Hindsight if you recall them.",
  waitForCompletion: true,
  timeoutMs: 900000,
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

printf 'Starting Beep control plane at %s ...\n' "$CONTROL_PLANE_URL"
"$ROOT_DIR/scripts/beep-control-plane.sh" start

OPERATOR_TOKEN="$("$ROOT_DIR/scripts/beep-control-plane.sh" operator-token)"
if [ -z "$OPERATOR_TOKEN" ]; then
  echo "Operator token helper returned an empty token." >&2
  exit 1
fi

auth_get "/api/backend/status" "$STATUS_BEFORE_FILE"
auth_post "/api/requests" "$SEED_BODY_FILE" "$SEED_OUTPUT_FILE"

compact_http_status="000"
set +e
compact_http_status="$(curl -sS -X POST \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d "@$COMPACT_BODY_FILE" \
  -o "$COMPACT_OUTPUT_FILE" \
  -w "%{http_code}" \
  "$CONTROL_PLANE_URL/api/agent/lcm/compact")"
compact_exit=$?
set -e

if [ "$compact_exit" -ne 0 ]; then
  printf '{"ok":false,"error":"curl failed","curlExit":%s,"httpStatus":"%s"}\n' \
    "$compact_exit" \
    "$compact_http_status" \
    >"$COMPACT_OUTPUT_FILE"
  printf 'LCM compact request failed with curl exit %s; continuing. Response file: %s\n' \
    "$compact_exit" \
    "$COMPACT_OUTPUT_FILE" >&2
elif [ "$compact_http_status" -lt 200 ] || [ "$compact_http_status" -ge 300 ]; then
  printf 'LCM compact returned HTTP %s; continuing. Response file: %s\n' \
    "$compact_http_status" \
    "$COMPACT_OUTPUT_FILE" >&2
fi

auth_post "/api/runtimes/$RUNTIME_ID/stop" /dev/null "$RUNTIME_STOP_FILE"
auth_post "/api/runtimes/$RUNTIME_ID/start" /dev/null "$RUNTIME_START_FILE"
auth_post "/api/requests" "$RECALL_BODY_FILE" "$RECALL_OUTPUT_FILE"
auth_get "/api/backend/status" "$STATUS_AFTER_FILE"

node --input-type=module - "$STATUS_AFTER_FILE" <<'NODE'
import { readFileSync } from "node:fs";

const [statusPath] = process.argv.slice(2);
const status = JSON.parse(readFileSync(statusPath, "utf8"));
const failures = [];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const runtime = isObject(status.runtime) ? status.runtime : null;
const runtimeRunning =
  runtime?.running === true ||
  runtime?.state?.status === "running" ||
  runtime?.health?.ok === true ||
  runtime?.health?.agent?.running === true;
const recentRequests = Array.isArray(status.controlPlane?.recentRequests)
  ? status.controlPlane.recentRequests
  : [];
const lcm = isObject(status.memory?.lcm) ? status.memory.lcm : null;
const hindsight = isObject(status.memory?.hindsight) ? status.memory.hindsight : null;
const hasLcmProof = Boolean(
  lcm && (lcm.available === true || isObject(lcm.status) || isObject(lcm.latestContextInjection)),
);
const hasHindsightProof = Boolean(
  hindsight && (hindsight.available === true || isObject(hindsight.latest) || isObject(hindsight.telemetry)),
);

if (status.ok !== true) failures.push("backend status ok must be true");
if (status.schemaVersion !== 1) failures.push("backend status schemaVersion must be 1");
if (!runtime) failures.push("backend status must include a runtime object");
if (recentRequests.length < 1) failures.push("controlPlane.recentRequests must include at least one request");
if (!hasLcmProof && !hasHindsightProof) {
  failures.push("memory status must include LCM or Hindsight telemetry/status proof");
}

const requestStatuses = recentRequests.map((request) => ({
  requestId: request.requestId || null,
  status: request.status || null,
  runtimeRequestId: request.runtimeRequestId || null,
}));
const summary = {
  runtimeRunning,
  runtimeStatus: runtime?.state?.status || runtime?.status || null,
  agentAvailable: status.agent?.available === true,
  lcmAvailable: lcm?.available === true,
  lcmStatus: lcm?.status?.status || lcm?.status?.ok || null,
  lcmLatestContextKind: lcm?.latestContextInjection?.kind || null,
  hindsightAvailable: hindsight?.available === true,
  hindsightLatestKind: hindsight?.latest?.kind || null,
  hindsightTelemetryTotal: hindsight?.telemetry?.total ?? null,
  recentRequestStatuses: requestStatuses,
};

console.log("Backend status summary:");
console.log(JSON.stringify(summary, null, 2));

if (failures.length > 0) {
  console.error("Backend smoke validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
NODE

cat <<EOF

Smoke output files:
  initial backend status: $STATUS_BEFORE_FILE
  seed request body:      $SEED_BODY_FILE
  seed response:          $SEED_OUTPUT_FILE
  LCM compact body:       $COMPACT_BODY_FILE
  LCM compact response:   $COMPACT_OUTPUT_FILE
  runtime stop response:  $RUNTIME_STOP_FILE
  runtime start response: $RUNTIME_START_FILE
  recall request body:    $RECALL_BODY_FILE
  recall response:        $RECALL_OUTPUT_FILE
  final backend status:   $STATUS_AFTER_FILE

First usable backend control-plane smoke passed.
EOF
