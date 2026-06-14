#!/usr/bin/env bash
set -euo pipefail

# Deterministic replay smoke:
#   ./scripts/smoke-test-beep-notes-backbone.sh
#
# Optional live local-Beep smoke:
#   BEEP_NOTES_LIVE=1 ./scripts/smoke-test-beep-notes-backbone.sh
#
# Live mode requires a working local Beep runtime and Codex auth. Replay mode is
# the normal CI-safe check.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1 && [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi

PORT="${BEEP_NOTES_SMOKE_PORT:-18788}"
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beep-notes-backbone.XXXXXX")"
LOG_FILE="$STATE_DIR/control-plane.log"
HOST="127.0.0.1"
BASE_URL="http://$HOST:$PORT"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

port_available() {
  "$NODE_BIN" --input-type=module - "$HOST" "$1" <<'NODE'
import net from "node:net";

const [host, portText] = process.argv.slice(2);
const port = Number(portText);
const server = net.createServer();
server.once("error", () => process.exit(1));
server.once("listening", () => {
  server.close(() => process.exit(0));
});
server.listen(port, host);
NODE
}

pick_fallback_port() {
  "$NODE_BIN" --input-type=module - "$HOST" <<'NODE'
import net from "node:net";

const [host] = process.argv.slice(2);
const server = net.createServer();
server.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
server.listen(0, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  console.log(address.port);
  server.close();
});
NODE
}

if ! port_available "$PORT"; then
  if [[ -n "${BEEP_NOTES_SMOKE_PORT:-}" ]]; then
    printf 'Requested BEEP_NOTES_SMOKE_PORT is busy: %s\n' "$PORT" >&2
    exit 1
  fi
  PORT="$(pick_fallback_port)"
  BASE_URL="http://$HOST:$PORT"
fi

request() {
  local method="$1"
  local path="$2"
  local output_file="$3"
  local body_file="${4:-}"
  local http_status="000"
  local curl_exit=0
  local curl_args=(
    -sS
    -X "$method"
    -H "authorization: Bearer $OPERATOR_TOKEN"
    -o "$output_file"
    -w "%{http_code}"
  )
  if [[ -n "$body_file" ]]; then
    curl_args+=(
      -H "content-type: application/json"
      -d "@$body_file"
    )
  fi

  set +e
  http_status="$(curl "${curl_args[@]}" "$BASE_URL$path")"
  curl_exit=$?
  set -e

  if [[ "$curl_exit" -ne 0 || ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Request failed: method=%s path=%s status=%s curlExit=%s output=%s\n' \
      "$method" \
      "$path" \
      "${http_status:-000}" \
      "$curl_exit" \
      "$output_file" >&2
    if [[ -s "$output_file" ]]; then
      cat "$output_file" >&2
      printf '\n' >&2
    fi
    return 1
  fi
}

json_eval() {
  local file="$1"
  local expression="$2"
  "$NODE_BIN" --input-type=module - "$file" "$expression" <<'NODE'
import { readFileSync } from "node:fs";

const [path, expression] = process.argv.slice(2);
const data = JSON.parse(readFileSync(path, "utf8"));
const result = Function("data", `"use strict"; return (${expression});`)(data);
if (result == null) process.exit(1);
process.stdout.write(String(result));
NODE
}

url_encode() {
  "$NODE_BIN" --input-type=module - "$1" <<'NODE'
process.stdout.write(encodeURIComponent(process.argv[2]));
NODE
}

NOTE_BODY_FILE="$STATE_DIR/create-note.json"
ASK_BODY_FILE="$STATE_DIR/ask-beep.json"
EMPTY_BODY_FILE="$STATE_DIR/empty.json"
NOTE_RESPONSE_FILE="$STATE_DIR/create-note-response.json"
ASK_RESPONSE_FILE="$STATE_DIR/ask-beep-response.json"
ACCEPT_RESPONSE_FILE="$STATE_DIR/accept-proposal-response.json"
WORKSPACE_RESPONSE_FILE="$STATE_DIR/workspace-response.json"

cat >"$NOTE_BODY_FILE" <<'JSON'
{
  "type": "note",
  "title": "Backbone smoke note",
  "body": "Call Sam about the deterministic Beep Notes backbone smoke."
}
JSON

if [[ "${BEEP_NOTES_LIVE:-0}" == "1" ]]; then
  cat >"$ASK_BODY_FILE" <<'JSON'
{
  "reviewPolicy": "autopilot",
  "beepMode": "localAgent"
}
JSON
else
  cat >"$ASK_BODY_FILE" <<'JSON'
{
  "beepMode": "replay",
  "reviewPolicy": "autopilot"
}
JSON
fi

printf '{}\n' >"$EMPTY_BODY_FILE"

(
  cd "$ROOT_DIR"
  BEEP_CONTROL_PLANE_STATE_DIR="$STATE_DIR" \
  BEEP_CONTROL_PLANE_HOST="$HOST" \
  BEEP_CONTROL_PLANE_PORT="$PORT" \
  BEEP_CONTROL_PLANE_AUTOSTART=0 \
  "$NODE_BIN" control-plane/src/server.mjs
) >"$LOG_FILE" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 100); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    printf 'Control plane exited before health became ready. Log follows:\n' >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  sleep 0.1
done

if ! curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  printf 'Timed out waiting for control-plane health at %s. Log follows:\n' "$BASE_URL/health" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

OPERATOR_TOKEN="$(cat "$STATE_DIR/operator-token")"
if [[ -z "$OPERATOR_TOKEN" ]]; then
  printf 'Operator token was empty: %s\n' "$STATE_DIR/operator-token" >&2
  exit 1
fi

request "POST" "/api/notes/items" "$NOTE_RESPONSE_FILE" "$NOTE_BODY_FILE"
NOTE_ID="$(json_eval "$NOTE_RESPONSE_FILE" 'data.ok === true && data.item && data.item.type === "note" && data.item.id')"
NOTE_ID_PATH="$(url_encode "$NOTE_ID")"

request "POST" "/api/notes/items/$NOTE_ID_PATH/ask-beep" "$ASK_RESPONSE_FILE" "$ASK_BODY_FILE"
PROPOSAL_ID="$(json_eval "$ASK_RESPONSE_FILE" 'data.ok === true && data.run && data.run.status === "completed" && Array.isArray(data.proposals) && data.proposals[0] && data.proposals[0].id')"
PROPOSAL_ID_PATH="$(url_encode "$PROPOSAL_ID")"

request "POST" "/api/notes/proposals/$PROPOSAL_ID_PATH/accept" "$ACCEPT_RESPONSE_FILE" "$EMPTY_BODY_FILE"
json_eval "$ACCEPT_RESPONSE_FILE" 'data.ok === true && data.item && data.item.type === "todo" && data.proposal && data.proposal.status === "accepted"' >/dev/null

request "GET" "/api/notes/workspace" "$WORKSPACE_RESPONSE_FILE"
"$NODE_BIN" --input-type=module - "$WORKSPACE_RESPONSE_FILE" "$NOTE_ID" "$PROPOSAL_ID" <<'NODE'
import { readFileSync } from "node:fs";

const [workspacePath, noteId, proposalId] = process.argv.slice(2);
const payload = JSON.parse(readFileSync(workspacePath, "utf8"));
const workspace = payload.workspace;
const items = Object.values(workspace?.items || {});
const comments = Object.values(workspace?.comments || {});
const proposal = workspace?.proposals?.[proposalId];
const failures = [];

if (payload.ok !== true) failures.push("workspace response was not ok");
if (!items.some((item) => item.id === noteId && item.type === "note")) {
  failures.push("workspace did not contain the created note");
}
if (!items.some((item) => item.type === "todo" && item.relationships?.some((rel) => rel.targetId === noteId))) {
  failures.push("workspace did not contain an accepted todo linked to the note");
}
if (!proposal || proposal.status !== "accepted") {
  failures.push("workspace proposal was not accepted");
}
if (!comments.some((comment) => comment.targetId === noteId || comment.sourceItemIds?.includes(noteId))) {
  failures.push("workspace did not contain a Beep comment for the note");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
NODE

printf 'beep notes backbone smoke passed\n'
