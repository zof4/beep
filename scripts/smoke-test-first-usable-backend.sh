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

control_plane_request_http() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local body_file="${4:-}"
  local curl_args=(
    -sS
    -X "$method"
    -H "authorization: Bearer $OPERATOR_TOKEN"
    -o "$output_file"
    -w "%{http_code}"
  )
  if [ -n "$body_file" ]; then
    curl_args+=(
      -H "content-type: application/json"
      -d "@$body_file"
    )
  fi

  curl "${curl_args[@]}" "$CONTROL_PLANE_URL$path"
}

is_http_success() {
  case "$1" in
    2??)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

write_transport_failure_body() {
  local output_file="$1"
  local curl_exit="$2"
  local http_status="$3"
  if [ ! -s "$output_file" ]; then
    printf '{"ok":false,"error":"curl transport failed","curlExit":%s,"httpStatus":"%s"}\n' \
      "$curl_exit" \
      "$http_status" \
      >"$output_file"
  fi
}

fail_control_plane_request() {
  local method="$1"
  local path="$2"
  local http_status="$3"
  local output_file="$4"
  local curl_exit="${5:-0}"
  printf 'Control-plane request failed: method=%s path=%s status=%s curlExit=%s output=%s\n' \
    "$method" \
    "$path" \
    "$http_status" \
    "$curl_exit" \
    "$output_file" >&2
  return 1
}

control_plane_request() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local body_file="${4:-}"
  local http_status="000"
  local curl_exit=0

  set +e
  http_status="$(control_plane_request_http "$method" "$path" "$output_file" "$body_file")"
  curl_exit=$?
  set -e

  if [ "$curl_exit" -ne 0 ]; then
    http_status="${http_status:-000}"
    write_transport_failure_body "$output_file" "$curl_exit" "$http_status"
    fail_control_plane_request "$method" "$path" "$http_status" "$output_file" "$curl_exit"
    return 1
  fi

  if ! is_http_success "$http_status"; then
    fail_control_plane_request "$method" "$path" "$http_status" "$output_file"
    return 1
  fi
}

auth_get() {
  local path="$1"
  local output_file="$2"
  control_plane_request "GET" "$path" "$output_file"
}

auth_post() {
  local path="$1"
  local body_file="$2"
  local output_file="$3"
  control_plane_request "POST" "$path" "$output_file" "$body_file"
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
compact_http_status="$(control_plane_request_http "POST" "/api/agent/lcm/compact" "$COMPACT_OUTPUT_FILE" "$COMPACT_BODY_FILE")"
compact_exit=$?
set -e

if [ "$compact_exit" -ne 0 ]; then
  compact_http_status="${compact_http_status:-000}"
  write_transport_failure_body "$COMPACT_OUTPUT_FILE" "$compact_exit" "$compact_http_status"
  fail_control_plane_request "POST" "/api/agent/lcm/compact" "$compact_http_status" "$COMPACT_OUTPUT_FILE" "$compact_exit"
elif is_http_success "$compact_http_status"; then
  :
elif [ "$compact_http_status" = "502" ]; then
  printf 'LCM compact returned runtime proxy HTTP 502; continuing. Response file: %s\n' \
    "$COMPACT_OUTPUT_FILE" >&2
else
  fail_control_plane_request "POST" "/api/agent/lcm/compact" "$compact_http_status" "$COMPACT_OUTPUT_FILE"
fi

auth_post "/api/runtimes/$RUNTIME_ID/stop" "" "$RUNTIME_STOP_FILE"
auth_post "/api/runtimes/$RUNTIME_ID/start" "" "$RUNTIME_START_FILE"
auth_post "/api/requests" "$RECALL_BODY_FILE" "$RECALL_OUTPUT_FILE"
auth_get "/api/backend/status" "$STATUS_AFTER_FILE"

node --input-type=module - \
  "$STATUS_AFTER_FILE" \
  "$SEED_OUTPUT_FILE" \
  "$RECALL_OUTPUT_FILE" \
  "$RUNTIME_STOP_FILE" \
  "$RUNTIME_START_FILE" <<'NODE'
import { readFileSync } from "node:fs";

const [statusPath, seedResponsePath, recallResponsePath, stopResponsePath, startResponsePath] = process.argv.slice(2);
if (!statusPath || !seedResponsePath || !recallResponsePath || !stopResponsePath || !startResponsePath) {
  console.error(
    "usage: validator <final-status.json> <seed-response.json> <recall-response.json> <runtime-stop.json> <runtime-start.json>",
  );
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const status = readJson(statusPath);
const seedResponse = readJson(seedResponsePath);
const recallResponse = readJson(recallResponsePath);
const stopResponse = readJson(stopResponsePath);
const startResponse = readJson(startResponsePath);
const failures = [];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const failedStatuses = new Set(["failed", "error", "errored", "cancelled", "canceled", "timeout", "timed_out"]);
const isFailureStatus = (value) => failedStatuses.has(String(value || "").toLowerCase());
const hasErrorValue = (value) =>
  isObject(value) && Object.hasOwn(value, "error") && value.error !== null && value.error !== "";
const rejectErrorValue = (label, value) => {
  if (hasErrorValue(value)) {
    failures.push(`${label} must not include an error value`);
  }
};
const runtimeRunningFrom = (value) =>
  isObject(value) &&
  (value.running === true ||
    value.state?.status === "running" ||
    value.health?.ok === true ||
    value.health?.agent?.running === true);
const runtimeResultSummary = (response) => ({
  ok: isObject(response?.result) && Object.hasOwn(response.result, "ok") ? response.result.ok : null,
  status: isObject(response?.result?.request) ? response.result.request.status || null : null,
  runtimeRequestId: isObject(response?.result?.request) ? response.result.request.id || null : null,
});
const runtimeResponseSummary = (value) =>
  isObject(value)
    ? {
        running: Object.hasOwn(value, "running") ? value.running : runtimeRunningFrom(value),
        status: value.state?.status || value.status || null,
      }
    : null;
const validateControlPlaneRequestResponse = (label, response) => {
  if (!isObject(response)) {
    failures.push(`${label} response must be a JSON object`);
    return null;
  }
  if (response.ok !== true) {
    failures.push(`${label} response ok must be true`);
  }
  rejectErrorValue(`${label} response`, response);
  if (!nonEmptyString(response.requestId)) {
    failures.push(`${label} response must include a non-empty top-level requestId`);
  }

  if (!isObject(response.result)) {
    failures.push(`${label} response result must be an object`);
  } else {
    if (response.result.ok !== true) {
      failures.push(`${label} runtime result ok must be true`);
    }
    rejectErrorValue(`${label} runtime result`, response.result);

    const runtimeRequest = isObject(response.result.request) ? response.result.request : null;
    if (!runtimeRequest) {
      failures.push(`${label} runtime result request must be an object`);
    } else {
      if (!nonEmptyString(runtimeRequest.id)) {
        failures.push(`${label} runtime request id must be non-empty`);
      }
      if (runtimeRequest.status !== "completed") {
        failures.push(`${label} runtime request status must be completed`);
      }
      if (isFailureStatus(runtimeRequest.status)) {
        failures.push(`${label} runtime request status must not indicate failure`);
      }
      rejectErrorValue(`${label} runtime request`, runtimeRequest);
    }
  }

  return nonEmptyString(response.requestId) ? response.requestId : null;
};
const validateRuntimeLifecycleResponse = (label, response) => {
  if (!isObject(response)) {
    failures.push(`${label} response must be a JSON object`);
    return null;
  }
  if (response.ok !== true) {
    failures.push(`${label} response ok must be true`);
  }
  rejectErrorValue(`${label} response`, response);
  if (!isObject(response.runtime)) {
    failures.push(`${label} response runtime must be an object`);
    return null;
  }
  return response.runtime;
};

const seedRequestId = validateControlPlaneRequestResponse("seed", seedResponse);
const recallRequestId = validateControlPlaneRequestResponse("recall", recallResponse);
const stopRuntime = validateRuntimeLifecycleResponse("runtime stop", stopResponse);
const startRuntime = validateRuntimeLifecycleResponse("runtime start", startResponse);
const runtime = isObject(status.runtime) ? status.runtime : null;
const runtimeRunning = runtimeRunningFrom(runtime);
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
const recentRequestById = new Map(
  recentRequests
    .filter((request) => isObject(request) && nonEmptyString(request.requestId))
    .map((request) => [request.requestId, request]),
);
const requireFinalStatusRequest = (label, requestId) => {
  if (!requestId) return null;
  const request = recentRequestById.get(requestId) || null;
  if (!request) {
    failures.push(`final backend status must include ${label} request ${requestId} in controlPlane.recentRequests`);
    return null;
  }
  if (isFailureStatus(request.status)) {
    failures.push(`final backend status ${label} request ${requestId} must not be failed`);
  }
  if (!nonEmptyString(request.status)) {
    failures.push(`final backend status ${label} request ${requestId} must include a non-empty status`);
  }
  if (!nonEmptyString(request.runtimeRequestId)) {
    failures.push(`final backend status ${label} request ${requestId} must include a non-empty runtimeRequestId`);
  }
  rejectErrorValue(`final backend status ${label} request ${requestId}`, request);
  return request;
};
const finalSeedRequest = requireFinalStatusRequest("seed", seedRequestId);
const finalRecallRequest = requireFinalStatusRequest("recall", recallRequestId);

if (status.ok !== true) failures.push("backend status ok must be true");
if (status.schemaVersion !== 1) failures.push("backend status schemaVersion must be 1");
if (!runtime) failures.push("backend status must include a runtime object");
if (!runtimeRunning) {
  failures.push("final backend runtime must be running after control-plane restart");
}
if (!hasLcmProof) {
  failures.push("final backend status after seed/compact/restart/recall must include LCM telemetry/status proof");
}
if (!hasHindsightProof) {
  failures.push("final backend status after seed/compact/restart/recall must include Hindsight telemetry/status proof");
}

const requestStatuses = recentRequests.map((request) => ({
  requestId: request.requestId || null,
  status: request.status || null,
  runtimeRequestId: request.runtimeRequestId || null,
}));
const statusSummary = (request) =>
  request
    ? {
        requestId: request.requestId || null,
        status: request.status || null,
        runtimeRequestId: request.runtimeRequestId || null,
      }
    : null;
const summary = {
  seedRequestId,
  recallRequestId,
  seedRuntimeResult: runtimeResultSummary(seedResponse),
  recallRuntimeResult: runtimeResultSummary(recallResponse),
  finalSeedRequest: statusSummary(finalSeedRequest),
  finalRecallRequest: statusSummary(finalRecallRequest),
  runtimeStop: runtimeResponseSummary(stopRuntime),
  runtimeStart: runtimeResponseSummary(startRuntime),
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
