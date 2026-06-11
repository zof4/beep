#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

allocate_ports() {
  node --input-type=module <<'NODE'
import net from "node:net";

const singlePortSpecs = [
  ["BEEP_CONTROL_PLANE_PORT", "BEEP_FULL_STACK_E2E_CONTROL_PLANE_PORT"],
  ["BEEP_RUNTIME_API_HOST_PORT", "BEEP_FULL_STACK_E2E_RUNTIME_API_HOST_PORT"],
  ["BEEP_HINDSIGHT_API_HOST_PORT", "BEEP_FULL_STACK_E2E_HINDSIGHT_API_HOST_PORT"],
  ["BEEP_HINDSIGHT_WORKER_HOST_PORT", "BEEP_FULL_STACK_E2E_HINDSIGHT_WORKER_HOST_PORT"],
];
const previewCount = 100;
const minPort = 1;
const maxPort = 65535;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parsePort(name, value) {
  if (!value) return null;
  if (!/^\d+$/.test(value)) fail(`${name} must be a numeric TCP port.`);
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < minPort || port > maxPort) {
    fail(`${name} must be between ${minPort} and ${maxPort}.`);
  }
  return port;
}

function parseRange(name, value) {
  if (!value) return null;
  const match = value.match(/^(\d+)-(\d+)$/);
  if (!match) fail(`${name} must be a TCP port range like 13000-13099.`);
  const start = parsePort(`${name} start`, match[1]);
  const end = parsePort(`${name} end`, match[2]);
  if (end < start) fail(`${name} end must be greater than or equal to start.`);
  if (end - start + 1 !== previewCount) {
    fail(`${name} must contain exactly ${previewCount} ports for container ports 3000-3099.`);
  }
  return { start, end };
}

function inRange(port, range) {
  return port >= range.start && port <= range.end;
}

function validatePortSet(ports, range) {
  const seen = new Map();
  for (const [name, port] of Object.entries(ports)) {
    if (seen.has(port)) {
      fail(`${name} collides with ${seen.get(port)} on port ${port}.`);
    }
    seen.set(port, name);
    if (inRange(port, range)) {
      fail(`${name}=${port} collides with BEEP_PREVIEW_HOST_PORT_RANGE=${range.start}-${range.end}.`);
    }
  }
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function rangeIsAvailable(range) {
  for (let port = range.start; port <= range.end; port += 1) {
    if (!(await canListen(port))) return false;
  }
  return true;
}

async function choosePreviewRange(excludedPorts) {
  const minBase = 14000;
  const maxBase = 60000 - previewCount;
  const randomOffset = Math.floor(Math.random() * 3000);
  for (let scanned = 0; scanned <= maxBase - minBase; scanned += previewCount) {
    const base = minBase + ((randomOffset + scanned) % (maxBase - minBase + 1));
    const alignedBase = base - (base % previewCount);
    const range = { start: alignedBase, end: alignedBase + previewCount - 1 };
    if (range.start < minBase || range.end > maxPort) continue;
    if ([...excludedPorts].some((port) => inRange(port, range))) continue;
    if (await rangeIsAvailable(range)) return range;
  }
  fail(`Could not find ${previewCount} contiguous free localhost ports.`);
}

async function chooseSinglePort(excludedPorts, range) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => resolve(address.port));
      });
    });
    if (excludedPorts.has(port) || inRange(port, range)) continue;
    if (await canListen(port)) return port;
  }
  fail("Could not allocate a free localhost port.");
}

const ports = Object.fromEntries(
  singlePortSpecs.map(([outputName, overrideName]) => [outputName, parsePort(overrideName, process.env[overrideName])]),
);
const previewBase = parsePort(
  "BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_BASE",
  process.env.BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_BASE,
);
let previewRange = parseRange(
  "BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_RANGE",
  process.env.BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_RANGE,
);

if (!previewRange && previewBase !== null) {
  previewRange = { start: previewBase, end: previewBase + previewCount - 1 };
  if (previewRange.end > maxPort) {
    fail("BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_BASE leaves too few ports for the preview range.");
  }
}
if (previewRange && previewBase !== null && previewBase !== previewRange.start) {
  fail("BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_BASE must match the start of BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_RANGE.");
}

const userPorts = new Set(Object.values(ports).filter((port) => port !== null));
if (!previewRange) {
  previewRange = await choosePreviewRange(userPorts);
} else if (!(await rangeIsAvailable(previewRange))) {
  fail(`BEEP_PREVIEW_HOST_PORT_RANGE=${previewRange.start}-${previewRange.end} includes a port that is not free.`);
}

const excludedPorts = new Set(userPorts);
for (const [name] of singlePortSpecs) {
  if (ports[name] === null) {
    ports[name] = await chooseSinglePort(excludedPorts, previewRange);
  } else if (!(await canListen(ports[name]))) {
    fail(`${name}=${ports[name]} is not available on 127.0.0.1.`);
  }
  excludedPorts.add(ports[name]);
}

validatePortSet(ports, previewRange);

for (const [name, port] of Object.entries(ports)) {
  process.stdout.write(`${name}=${port}\n`);
}
process.stdout.write(`BEEP_PREVIEW_HOST_PORT_RANGE=${previewRange.start}-${previewRange.end}\n`);
process.stdout.write(`BEEP_PREVIEW_HOST_PORT_BASE=${previewRange.start}\n`);
NODE
}

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

RUN_ID="${BEEP_FULL_STACK_E2E_RUN_ID:-$(node -e 'process.stdout.write(require("node:crypto").randomUUID().replaceAll("-", "").slice(0, 12))')}"
OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beep-full-stack-e2e.XXXXXX")"
CODEX_AUTH_PATH="${BEEP_FULL_STACK_E2E_CODEX_AUTH_PATH:-${BEEP_CONTROL_PLANE_CODEX_AUTH_PATH:-$ROOT_DIR/.beep-dev/state/codex/auth.json}}"
ISOLATED_CODEX_AUTH_PATH="$OUTPUT_DIR/state/codex/auth.json"
SANDBOX_BODY_FILE="$OUTPUT_DIR/sandbox-write-request.json"
SANDBOX_OUTPUT_FILE="$OUTPUT_DIR/sandbox-write.json"

port_exports="$(allocate_ports)"
eval "$port_exports"
export BEEP_CONTROL_PLANE_PORT
export BEEP_RUNTIME_API_HOST_PORT
export BEEP_HINDSIGHT_API_HOST_PORT
export BEEP_HINDSIGHT_WORKER_HOST_PORT
export BEEP_PREVIEW_HOST_PORT_RANGE
export BEEP_PREVIEW_HOST_PORT_BASE
export COMPOSE_PROJECT_NAME="${BEEP_FULL_STACK_E2E_COMPOSE_PROJECT_NAME:-beep_full_stack_e2e_$RUN_ID}"
export BEEP_AGENT_ID="${BEEP_FULL_STACK_E2E_AGENT_ID:-full_stack_e2e_$RUN_ID}"
export BEEP_CONTROL_PLANE_HOST="${BEEP_FULL_STACK_E2E_CONTROL_PLANE_HOST:-127.0.0.1}"
export BEEP_CONTROL_PLANE_STATE_DIR="${BEEP_FULL_STACK_E2E_CONTROL_PLANE_STATE_DIR:-$OUTPUT_DIR/control-plane}"
export BEEP_CONTROL_PLANE_CODEX_AUTH_PATH="$ISOLATED_CODEX_AUTH_PATH"
export BEEP_RUNTIME_API_URL="${BEEP_FULL_STACK_E2E_RUNTIME_API_URL:-http://127.0.0.1:$BEEP_RUNTIME_API_HOST_PORT}"
export BEEP_RUNTIME_WORKSPACE_HOST_PATH="$OUTPUT_DIR/workspace"
export BEEP_RUNTIME_LCM_HOST_PATH="$OUTPUT_DIR/lcm"
export BEEP_RUNTIME_HISTORY_HOST_PATH="$OUTPUT_DIR/history"
export BEEP_RUNTIME_STATE_HOST_PATH="$OUTPUT_DIR/state"
export BEEP_HINDSIGHT_STORAGE_HOST_PATH="$OUTPUT_DIR/hindsight"
export BEEP_HINDSIGHT_CODEX_HOST_PATH="$OUTPUT_DIR/state/codex"
export BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT="$OUTPUT_DIR/workspace/sandboxes"
export BEEP_HINDSIGHT_DEPLOYMENT_ID="${BEEP_FULL_STACK_E2E_HINDSIGHT_DEPLOYMENT_ID:-full-stack-e2e-$RUN_ID}"
export BEEP_HINDSIGHT_USER_ID="${BEEP_FULL_STACK_E2E_HINDSIGHT_USER_ID:-full-stack-e2e-user-$RUN_ID}"
export BEEP_HINDSIGHT_PROJECT_ID="${BEEP_FULL_STACK_E2E_HINDSIGHT_PROJECT_ID:-beep2-full-stack-e2e-$RUN_ID}"
export BEEP_HINDSIGHT_WORKER_ID="${BEEP_FULL_STACK_E2E_HINDSIGHT_WORKER_ID:-beep-hindsight-full-stack-e2e-$RUN_ID}"
export BEEP_RUNTIME_COMPOSE_SERVICE="${BEEP_FULL_STACK_E2E_RUNTIME_COMPOSE_SERVICE:-beep-host-loop}"
export BEEP_HOST_LOOP_HINDSIGHT_ENABLED="${BEEP_FULL_STACK_E2E_HOST_LOOP_HINDSIGHT_ENABLED:-1}"
export BEEP_RUNTIME_AUTO_UPDATE="${BEEP_FULL_STACK_E2E_RUNTIME_AUTO_UPDATE:-0}"
export BEEP_BACKEND_SCENARIO_LABEL="${BEEP_FULL_STACK_E2E_SCENARIO_LABEL:-Full-stack E2E}"

compose=(
  docker compose
  --project-name "$COMPOSE_PROJECT_NAME"
  --env-file "$ROOT_DIR/docker/hindsight-image.env"
  -f "$ROOT_DIR/docker/compose.runtime-dev.yml"
)

cleanup() {
  local status=$?
  if [ "${BEEP_FULL_STACK_E2E_KEEP_CONTROL_PLANE:-0}" != "1" ]; then
    "$ROOT_DIR/scripts/beep-control-plane.sh" stop >/dev/null 2>&1 || true
  fi
  if [ "${BEEP_FULL_STACK_E2E_KEEP_COMPOSE:-0}" != "1" ]; then
    "${compose[@]}" --profile api --profile legacy-api down --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

node "$ROOT_DIR/scripts/validate-codex-auth.mjs" \
  --require-access-token-or-api-key \
  --usage "Full-stack E2E" \
  "$CODEX_AUTH_PATH"

mkdir -p \
  "$OUTPUT_DIR/workspace/sandboxes" \
  "$OUTPUT_DIR/lcm" \
  "$OUTPUT_DIR/history" \
  "$OUTPUT_DIR/state/codex" \
  "$OUTPUT_DIR/hindsight"
cp "$CODEX_AUTH_PATH" "$ISOLATED_CODEX_AUTH_PATH"
chmod 600 "$ISOLATED_CODEX_AUTH_PATH"

printf 'Full-stack E2E run id: %s\n' "$RUN_ID"
printf 'Full-stack E2E output directory: %s\n' "$OUTPUT_DIR"
printf 'Full-stack E2E compose project: %s\n' "$COMPOSE_PROJECT_NAME"
printf 'Full-stack E2E control plane: http://%s:%s\n' "$BEEP_CONTROL_PLANE_HOST" "$BEEP_CONTROL_PLANE_PORT"
printf 'Full-stack E2E runtime API: %s\n' "$BEEP_RUNTIME_API_URL"
printf 'Full-stack E2E Hindsight API host port: %s\n' "$BEEP_HINDSIGHT_API_HOST_PORT"
printf 'Full-stack E2E preview host port range: %s\n' "$BEEP_PREVIEW_HOST_PORT_RANGE"

"${compose[@]}" --profile api up --build -d hindsight
wait_for_url "http://127.0.0.1:$BEEP_HINDSIGHT_API_HOST_PORT/health" \
  "$OUTPUT_DIR/hindsight-health.json" \
  "Hindsight sidecar health"

"$ROOT_DIR/scripts/smoke-test-first-usable-backend.sh"

runtime_api_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-api-token)"
if [ -z "$runtime_api_token" ]; then
  echo "Control-plane runtime API token helper returned an empty token." >&2
  exit 1
fi

SESSION_ID="${BEEP_FULL_STACK_E2E_SANDBOX_SESSION_ID:-full_stack_e2e_$RUN_ID}"
SESSION_ID="$SESSION_ID" node --input-type=module >"$SANDBOX_BODY_FILE" <<'NODE'
const body = {
  sessionId: process.env.SESSION_ID,
  toolCallId: "full_stack_sandbox_write",
  toolName: "write",
  args: {
    path: "full-stack-sandbox-proof.txt",
    content: "full-stack-sandbox-ok\n",
  },
  timeoutMs: 5000,
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

curl -fsS "$BEEP_RUNTIME_API_URL/internal/sandbox/tools/call" \
  -H "authorization: Bearer $runtime_api_token" \
  -H "content-type: application/json" \
  -d "@$SANDBOX_BODY_FILE" \
  >"$SANDBOX_OUTPUT_FILE"

require_text "Successfully wrote" "$SANDBOX_OUTPUT_FILE" "sandbox write result"

if [ "$BEEP_CONTROL_PLANE_HOST" = "::1" ]; then
  CONTROL_PLANE_URL="${BEEP_FULL_STACK_E2E_CONTROL_PLANE_URL:-http://[::1]:$BEEP_CONTROL_PLANE_PORT}"
else
  CONTROL_PLANE_URL="${BEEP_FULL_STACK_E2E_CONTROL_PLANE_URL:-http://$BEEP_CONTROL_PLANE_HOST:$BEEP_CONTROL_PLANE_PORT}"
fi
operator_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" operator-token)"
runtime_tool_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-token)"
if [ -z "$operator_token" ]; then
  echo "Control-plane operator token helper returned an empty token." >&2
  exit 1
fi
if [ -z "$runtime_tool_token" ]; then
  echo "Control-plane runtime tool token helper returned an empty token." >&2
  exit 1
fi

DYNAMIC_TOOL_SCRIPT_BODY_FILE="$OUTPUT_DIR/dynamic-tool-script-request.json"
DYNAMIC_TOOL_SCRIPT_OUTPUT_FILE="$OUTPUT_DIR/dynamic-tool-script-write.json"
TOOL_PACKAGE_BODY_FILE="$OUTPUT_DIR/tool-package-install-request.json"
TOOL_PACKAGE_CALL_BODY_FILE="$OUTPUT_DIR/dynamic-tool-call-request.json"

SESSION_ID="$SESSION_ID" node --input-type=module >"$DYNAMIC_TOOL_SCRIPT_BODY_FILE" <<'NODE'
const script = [
  "#!/usr/bin/env node",
  "let input = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { input += chunk; });",
  "process.stdin.on('end', () => {",
  "  const payload = JSON.parse(input || '{}');",
  "  process.stdout.write(`demo_echo:${payload.args.text}`);",
  "});",
  "",
].join("\n");
const body = {
  sessionId: process.env.SESSION_ID,
  toolCallId: "full_stack_dynamic_tool_write",
  toolName: "write",
  args: {
    path: ".beep/tools/demo_tools/bin/echo.mjs",
    content: script,
  },
  timeoutMs: 5000,
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

curl -fsS "$BEEP_RUNTIME_API_URL/internal/sandbox/tools/call" \
  -H "authorization: Bearer $runtime_api_token" \
  -H "content-type: application/json" \
  -d "@$DYNAMIC_TOOL_SCRIPT_BODY_FILE" \
  >"$DYNAMIC_TOOL_SCRIPT_OUTPUT_FILE"
require_text "Successfully wrote" "$DYNAMIC_TOOL_SCRIPT_OUTPUT_FILE" "dynamic tool script write result"

node --input-type=module >"$TOOL_PACKAGE_BODY_FILE" <<'NODE'
const body = {
  schemaVersion: 1,
  packageId: "demo_tools",
  version: "1.0.0",
  packageHash: "sha256:e2e",
  source: "sandbox",
  tools: [
    {
      name: "demo_echo",
      action: "beep.tools.demo_tools.demo_echo",
      namespace: "beep_tools",
      description: "Echo text from the sandbox.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string" },
        },
      },
      target: "sandbox",
      command: {
        argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"],
        input: "json-stdin",
        timeoutMs: 5000,
      },
      scopes: ["sandbox.tool.execute"],
      defaultDecision: "allow",
    },
  ],
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

curl -fsS "$CONTROL_PLANE_URL/api/tools/packages" \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d "@$TOOL_PACKAGE_BODY_FILE" \
  >"$OUTPUT_DIR/tool-package-install.json"

curl -fsS "$CONTROL_PLANE_URL/api/tools/packages/demo_tools/1.0.0/tools/demo_echo/enable" \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{}' \
  >"$OUTPUT_DIR/tool-package-enable.json"

curl -fsS "$CONTROL_PLANE_URL/api/tools" >"$OUTPUT_DIR/tools-after-enable.json"
require_text "beep.tools.demo_tools.demo_echo" "$OUTPUT_DIR/tools-after-enable.json" "tools manifest after dynamic package enable"
require_text "web.run" "$OUTPUT_DIR/tools-after-enable.json" "tools manifest after dynamic package enable"

node --input-type=module >"$TOOL_PACKAGE_CALL_BODY_FILE" <<'NODE'
const body = {
  action: "beep.tools.demo_tools.demo_echo",
  toolCallId: "full_stack_dynamic_tool_call",
  args: {
    text: "hello-from-e2e",
  },
};
process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
NODE

curl -fsS "$CONTROL_PLANE_URL/internal/tools/call" \
  -H "authorization: Bearer $runtime_tool_token" \
  -H "content-type: application/json" \
  -d "@$TOOL_PACKAGE_CALL_BODY_FILE" \
  >"$OUTPUT_DIR/dynamic-tool-call.json"
require_text "demo_echo:hello-from-e2e" "$OUTPUT_DIR/dynamic-tool-call.json" "dynamic tool call result"

echo "Full-stack E2E sandbox and dynamic tool proofs passed; output in $OUTPUT_DIR"
