import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const rootDir = new URL("..", import.meta.url).pathname;

function scriptSource(scriptName) {
  return readFileSync(join(rootDir, "scripts", scriptName), "utf8");
}

function composeSource() {
  return readFileSync(join(rootDir, "docker", "compose.runtime-dev.yml"), "utf8");
}

test("control-plane start refuses an occupied URL before writing a new pid", () => {
  const source = scriptSource("beep-control-plane.sh");
  const startIndex = source.indexOf("start() {");
  const nohupIndex = source.indexOf("nohup node", startIndex);
  const guardIndex = source.indexOf("guard_unmanaged_listener", startIndex);

  assert.notEqual(startIndex, -1);
  assert.notEqual(nohupIndex, -1);
  assert.notEqual(guardIndex, -1);
  assert.ok(guardIndex < nohupIndex, "occupied URL guard must run before spawning a new server");
  assert.match(source, /curl -fsS "\$URL\/health"/u);
  assert.match(source, /wait_for_started_health/u);
});

test("full-stack E2E wrapper validates persisted Codex auth before the backend scenario", () => {
  const source = scriptSource("test-full-stack-e2e.sh");
  const preflightIndex = source.indexOf("scripts/validate-codex-auth.mjs");
  const scenarioIndex = source.indexOf("scripts/smoke-test-first-usable-backend.sh");

  assert.notEqual(preflightIndex, -1, "wrapper should call the Codex auth validator");
  assert.notEqual(scenarioIndex, -1, "wrapper should run the first usable backend scenario");
  assert.ok(preflightIndex < scenarioIndex, "Codex auth validation must happen before the scenario starts");
  assert.match(source, /BEEP_CONTROL_PLANE_CODEX_AUTH_PATH:-\$ROOT_DIR\/\.beep-dev\/state\/codex\/auth\.json/u);
  assert.match(source, /--require-access-token-or-api-key/u);
  assert.match(source, /--usage "Full-stack E2E"/u);
});

test("full-stack E2E wrapper exports an isolated run before scenario startup", () => {
  const source = scriptSource("test-full-stack-e2e.sh");
  const scenarioIndex = source.indexOf("scripts/smoke-test-first-usable-backend.sh");
  const beforeScenario = source.slice(0, scenarioIndex);

  assert.match(beforeScenario, /RUN_ID=/u);
  assert.match(
    beforeScenario,
    /export COMPOSE_PROJECT_NAME="\$\{BEEP_FULL_STACK_E2E_COMPOSE_PROJECT_NAME:-beep_full_stack_e2e_\$RUN_ID\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{COMPOSE_PROJECT_NAME:-/u);
  assert.match(
    beforeScenario,
    /export BEEP_AGENT_ID="\$\{BEEP_FULL_STACK_E2E_AGENT_ID:-full_stack_e2e_\$RUN_ID\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_AGENT_ID:-/u);
  assert.match(
    beforeScenario,
    /export BEEP_CONTROL_PLANE_STATE_DIR="\$\{BEEP_FULL_STACK_E2E_CONTROL_PLANE_STATE_DIR:-\$OUTPUT_DIR\/control-plane\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_CONTROL_PLANE_STATE_DIR:-/u);
  assert.match(beforeScenario, /allocate_ports/u);
  assert.match(beforeScenario, /validatePortSet/u);
  assert.match(beforeScenario, /BEEP_FULL_STACK_E2E_CONTROL_PLANE_PORT/u);
  assert.match(beforeScenario, /BEEP_FULL_STACK_E2E_RUNTIME_API_HOST_PORT/u);
  assert.match(beforeScenario, /BEEP_FULL_STACK_E2E_HINDSIGHT_API_HOST_PORT/u);
  assert.match(beforeScenario, /BEEP_FULL_STACK_E2E_HINDSIGHT_WORKER_HOST_PORT/u);
  assert.match(beforeScenario, /BEEP_FULL_STACK_E2E_PREVIEW_HOST_PORT_RANGE/u);
  assert.match(beforeScenario, /export BEEP_CONTROL_PLANE_PORT/u);
  assert.match(beforeScenario, /export BEEP_RUNTIME_API_HOST_PORT/u);
  assert.match(
    beforeScenario,
    /export BEEP_RUNTIME_API_URL="\$\{BEEP_FULL_STACK_E2E_RUNTIME_API_URL:-http:\/\/127\.0\.0\.1:\$BEEP_RUNTIME_API_HOST_PORT\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_RUNTIME_API_URL:-/u);
  assert.match(beforeScenario, /export BEEP_HINDSIGHT_API_HOST_PORT/u);
  assert.match(beforeScenario, /export BEEP_HINDSIGHT_WORKER_HOST_PORT/u);
  assert.match(beforeScenario, /export BEEP_PREVIEW_HOST_PORT_RANGE/u);
  assert.match(
    beforeScenario,
    /export BEEP_HINDSIGHT_DEPLOYMENT_ID="\$\{BEEP_FULL_STACK_E2E_HINDSIGHT_DEPLOYMENT_ID:-full-stack-e2e-\$RUN_ID\}"/u,
  );
  assert.match(
    beforeScenario,
    /export BEEP_HINDSIGHT_USER_ID="\$\{BEEP_FULL_STACK_E2E_HINDSIGHT_USER_ID:-full-stack-e2e-user-\$RUN_ID\}"/u,
  );
  assert.match(
    beforeScenario,
    /export BEEP_HINDSIGHT_PROJECT_ID="\$\{BEEP_FULL_STACK_E2E_HINDSIGHT_PROJECT_ID:-beep2-full-stack-e2e-\$RUN_ID\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_HINDSIGHT_DEPLOYMENT_ID:-/u);
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_HINDSIGHT_USER_ID:-/u);
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_HINDSIGHT_PROJECT_ID:-/u);
  assert.match(beforeScenario, /export BEEP_CONTROL_PLANE_HOST="\$\{BEEP_FULL_STACK_E2E_CONTROL_PLANE_HOST:-127\.0\.0\.1\}"/u);
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_CONTROL_PLANE_HOST:-/u);
  assert.match(
    beforeScenario,
    /export BEEP_RUNTIME_COMPOSE_SERVICE="\$\{BEEP_FULL_STACK_E2E_RUNTIME_COMPOSE_SERVICE:-beep-host-loop\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_RUNTIME_COMPOSE_SERVICE:-/u);
  assert.match(
    beforeScenario,
    /export BEEP_HOST_LOOP_HINDSIGHT_ENABLED="\$\{BEEP_FULL_STACK_E2E_HOST_LOOP_HINDSIGHT_ENABLED:-1\}"/u,
  );
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_HOST_LOOP_HINDSIGHT_ENABLED:-/u);
  assert.match(beforeScenario, /export BEEP_RUNTIME_AUTO_UPDATE="\$\{BEEP_FULL_STACK_E2E_RUNTIME_AUTO_UPDATE:-0\}"/u);
  assert.doesNotMatch(beforeScenario, /\$\{BEEP_RUNTIME_AUTO_UPDATE:-/u);
});

test("full-stack E2E wrapper starts Hindsight sidecar before the backend scenario", () => {
  const source = scriptSource("test-full-stack-e2e.sh");
  const scenarioIndex = source.indexOf("scripts/smoke-test-first-usable-backend.sh");
  const upIndex = source.indexOf('--profile api up --build -d hindsight');
  const waitIndex = source.indexOf('wait_for_url "http://127.0.0.1:$BEEP_HINDSIGHT_API_HOST_PORT/health"');

  assert.notEqual(upIndex, -1, "wrapper should explicitly start Hindsight in its compose project");
  assert.notEqual(waitIndex, -1, "wrapper should wait for Hindsight health");
  assert.ok(upIndex < waitIndex, "Hindsight up should happen before health wait");
  assert.ok(waitIndex < scenarioIndex, "Hindsight must be healthy before the backend scenario starts");
  assert.match(source, /"\$\{compose\[@\]\}" --profile api up --build -d hindsight/u);
});

test("full-stack E2E wrapper proves host-loop Docker sandbox execution after the scenario", () => {
  const source = scriptSource("test-full-stack-e2e.sh");
  const scenarioIndex = source.indexOf("scripts/smoke-test-first-usable-backend.sh");
  const sandboxIndex = source.indexOf("/internal/sandbox/tools/call");

  assert.notEqual(sandboxIndex, -1, "wrapper should call the runtime sandbox tool route");
  assert.ok(sandboxIndex > scenarioIndex, "sandbox proof should run after the backend scenario starts the runtime");
  assert.match(source, /runtime_api_token="\$\("\$ROOT_DIR\/scripts\/beep-control-plane\.sh" runtime-api-token\)"/u);
  assert.match(source, /authorization: Bearer \$runtime_api_token/u);
  assert.match(source, /toolName:\s*"write"/u);
  assert.match(source, /node --input-type=module >"\$SANDBOX_BODY_FILE"/u);
  assert.doesNotMatch(source, /-d "\{\\"sessionId\\":\\"\$SESSION_ID/u);
  assert.match(source, /require_text "Successfully wrote"/u);
});

test("full-stack E2E wrapper isolates compose data directories and copies Codex auth", () => {
  const source = scriptSource("test-full-stack-e2e.sh");
  const scenarioIndex = source.indexOf("scripts/smoke-test-first-usable-backend.sh");
  const beforeScenario = source.slice(0, scenarioIndex);

  assert.match(beforeScenario, /ISOLATED_CODEX_AUTH_PATH="\$OUTPUT_DIR\/state\/codex\/auth\.json"/u);
  assert.match(beforeScenario, /cp "\$CODEX_AUTH_PATH" "\$ISOLATED_CODEX_AUTH_PATH"/u);
  assert.match(beforeScenario, /export BEEP_RUNTIME_WORKSPACE_HOST_PATH="\$OUTPUT_DIR\/workspace"/u);
  assert.match(beforeScenario, /export BEEP_RUNTIME_LCM_HOST_PATH="\$OUTPUT_DIR\/lcm"/u);
  assert.match(beforeScenario, /export BEEP_RUNTIME_HISTORY_HOST_PATH="\$OUTPUT_DIR\/history"/u);
  assert.match(beforeScenario, /export BEEP_RUNTIME_STATE_HOST_PATH="\$OUTPUT_DIR\/state"/u);
  assert.match(beforeScenario, /export BEEP_HINDSIGHT_STORAGE_HOST_PATH="\$OUTPUT_DIR\/hindsight"/u);
  assert.match(beforeScenario, /export BEEP_HINDSIGHT_CODEX_HOST_PATH="\$OUTPUT_DIR\/state\/codex"/u);
  assert.match(beforeScenario, /export BEEP_CONTROL_PLANE_CODEX_AUTH_PATH="\$ISOLATED_CODEX_AUTH_PATH"/u);
  assert.match(beforeScenario, /export BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT="\$OUTPUT_DIR\/workspace\/sandboxes"/u);
});

test("full-stack E2E wrapper cleans up only its control plane and compose project", () => {
  const source = scriptSource("test-full-stack-e2e.sh");

  assert.match(source, /trap cleanup EXIT/u);
  assert.match(source, /scripts\/beep-control-plane\.sh" stop/u);
  assert.match(source, /--project-name "\$COMPOSE_PROJECT_NAME"/u);
  assert.match(source, /--profile api --profile legacy-api down --remove-orphans/u);
  assert.doesNotMatch(source, /docker compose down --remove-orphans/u);
});

test("runtime compose ports and Hindsight identity are env-substituted with local defaults", () => {
  const compose = composeSource();

  assert.match(compose, /\$\{BEEP_RUNTIME_WORKSPACE_HOST_PATH:-\.\.\/\.beep-dev\/workspace\}:\/workspace/u);
  assert.match(compose, /\$\{BEEP_RUNTIME_LCM_HOST_PATH:-\.\.\/\.beep-dev\/lcm\}:\/lcm/u);
  assert.match(compose, /\$\{BEEP_RUNTIME_HISTORY_HOST_PATH:-\.\.\/\.beep-dev\/history\}:\/history/u);
  assert.match(compose, /\$\{BEEP_RUNTIME_STATE_HOST_PATH:-\.\.\/\.beep-dev\/state\}:\/state/u);
  assert.match(compose, /\$\{BEEP_HINDSIGHT_STORAGE_HOST_PATH:-\.\.\/\.beep-dev\/hindsight\}:\/home\/hindsight\/\.pg0/u);
  assert.match(compose, /\$\{BEEP_HINDSIGHT_CODEX_HOST_PATH:-\.\.\/\.beep-dev\/state\/codex\}:\/home\/hindsight\/\.codex:ro/u);
  assert.match(compose, /BEEP_HINDSIGHT_API_URL:\s*"\$\{BEEP_RUNTIME_HINDSIGHT_API_URL:-http:\/\/hindsight:8888\}"/u);
  assert.doesNotMatch(compose, /BEEP_HINDSIGHT_API_URL:\s*"\$\{BEEP_HINDSIGHT_API_URL:-/u);
  assert.match(compose, /BEEP_HINDSIGHT_DEPLOYMENT_ID:\s*"\$\{BEEP_HINDSIGHT_DEPLOYMENT_ID:-local\}"/u);
  assert.match(compose, /BEEP_HINDSIGHT_USER_ID:\s*"\$\{BEEP_HINDSIGHT_USER_ID:-default-user\}"/u);
  assert.match(compose, /BEEP_HINDSIGHT_PROJECT_ID:\s*"\$\{BEEP_HINDSIGHT_PROJECT_ID:-beep2\}"/u);
  assert.match(compose, /"127\.0\.0\.1:\$\{BEEP_HINDSIGHT_API_HOST_PORT:-8888\}:8888"/u);
  assert.match(compose, /"127\.0\.0\.1:\$\{BEEP_HINDSIGHT_WORKER_HOST_PORT:-9999\}:9999"/u);
  assert.match(compose, /"127\.0\.0\.1:\$\{BEEP_RUNTIME_API_HOST_PORT:-8787\}:8787"/u);
  assert.match(compose, /"127\.0\.0\.1:\$\{BEEP_PREVIEW_HOST_PORT_RANGE:-13000-13099\}:3000-3099"/u);
});

test("first usable backend scenario can be labelled by the full-stack wrapper", () => {
  const source = scriptSource("smoke-test-first-usable-backend.sh");

  assert.match(source, /SCENARIO_LABEL="\$\{BEEP_BACKEND_SCENARIO_LABEL:-Smoke\}"/u);
  assert.match(source, /printf '%s output directory: %s\\n' "\$SCENARIO_LABEL" "\$OUTPUT_DIR"/u);
});

test("first usable backend scenario prints response body tails on control-plane request failure", () => {
  const source = scriptSource("smoke-test-first-usable-backend.sh");

  assert.match(source, /if \[ -s "\$output_file" \]; then/u);
  assert.match(source, /Control-plane response body/u);
  assert.match(source, /tail -c 4000 "\$output_file"/u);
});

test("full-stack E2E npm script syntax-checks each shell script explicitly", () => {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));

  assert.match(
    pkg.scripts["test:full-stack-e2e"],
    /bash -n scripts\/test-full-stack-e2e\.sh && bash -n scripts\/smoke-test-first-usable-backend\.sh/u,
  );
  assert.doesNotMatch(
    pkg.scripts["test:full-stack-e2e"],
    /bash -n scripts\/test-full-stack-e2e\.sh scripts\/smoke-test-first-usable-backend\.sh/u,
  );
});

test("full-stack E2E covers generated tool package install, enable, manifest visibility, and execution", () => {
  const source = scriptSource("test-full-stack-e2e.sh");

  assert.match(source, /\/api\/tools\/packages/u);
  assert.match(source, /demo_tools/u);
  assert.match(source, /\/tools\/demo_echo\/enable/u);
  assert.match(source, /beep\.tools\.demo_tools\.demo_echo/u);
  assert.match(source, /\/internal\/tools\/call/u);
  assert.match(source, /web\.run/u);
});
