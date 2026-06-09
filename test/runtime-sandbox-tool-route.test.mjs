import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const apiSource = readFileSync(new URL("../runtime/src/beep-runtime-api.mjs", import.meta.url), "utf8");

test("runtime API exposes an authenticated sandbox tool route", () => {
  assert.match(apiSource, /handleSandboxToolRoute/u);
  assert.match(apiSource, /POST \/internal\/sandbox\/tools\/call/u);
  assert.match(apiSource, /executeSandboxTool/u);
  assert.match(apiSource, /normalizeSandboxToolRequest/u);
  assert.match(apiSource, /authorizeRuntimeApiRequest/u);
});

test("runtime capabilities advertise the full same-name sandbox tool set", () => {
  assert.match(apiSource, /tools: \["bash", "read", "write", "edit", "ls", "grep", "find"\]/u);
});

test("runtime sandbox route uses DockerSandboxManager in host-loop mode", () => {
  assert.match(apiSource, /DockerSandboxManager/u);
  assert.match(apiSource, /BEEP_SANDBOX_TOOL_BACKEND/u);
  assert.match(apiSource, /defaultSandboxManager/u);
  assert.match(apiSource, /BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT/u);
  assert.match(apiSource, /dockerWorkspaceRoot: SANDBOX_DOCKER_WORKSPACE_ROOT/u);
});
