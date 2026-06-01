import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { StateStore } from "../src/state-store.mjs";

const runtimeManagerSource = readFileSync(new URL("../src/runtime-manager.mjs", import.meta.url), "utf8");

const requiredRuntimeBoundaryEnv = [
  "BEEP_RUNTIME_API_TOKEN",
  "BEEP_MODEL_GATEWAY_CREDENTIAL_URL",
  "BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN",
  "BEEP_ALLOW_RUNTIME_CODEX_AUTH",
  "BEEP_CONTROL_PLANE_URL",
  "BEEP_CONTROL_PLANE_RUNTIME_ID",
  "BEEP_CONTROL_PLANE_RUNTIME_TOKEN",
  "BEEP_CONTROL_PLANE_TOOLS_ENABLED",
];

function tempManager() {
  const dir = mkdtempSync(join(tmpdir(), "beep-runtime-manager-test-"));
  const store = new StateStore(dir);
  const manager = new RuntimeManager({ store });
  return {
    store,
    manager,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("runtime manager reports stopped when runtime health is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const { manager, cleanup } = tempManager();
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ ok: false, error: "down" }),
    });

    const status = await manager.status();
    assert.equal(status.runtimeId, "local");
    assert.equal(status.running, false);
    assert.match(status.error, /down/u);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("runtime manager proxies to runtime with runtime API token", async () => {
  const originalFetch = globalThis.fetch;
  const { store, manager, cleanup } = tempManager();
  try {
    const token = store.ensureRuntimeApiToken();
    let seenAuthorization = null;
    globalThis.fetch = async (_url, options = {}) => {
      seenAuthorization = options.headers.authorization;
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    };

    const result = await manager.proxyToRuntime("/agent");
    assert.equal(result.ok, true);
    assert.equal(seenAuthorization, `Bearer ${token}`);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("runtime compose file declares control-plane boundary environment", () => {
  const compose = readFileSync(join(process.cwd(), "docker/compose.runtime-dev.yml"), "utf8");

  for (const envName of requiredRuntimeBoundaryEnv) {
    assert.match(compose, new RegExp(`^\\s+${envName}:`, "mu"), `${envName} must be declared in compose environment`);
  }
});

test("control-plane tools default fail closed for compose and managed launches", () => {
  const compose = readFileSync(join(process.cwd(), "docker/compose.runtime-dev.yml"), "utf8");

  assert.match(
    compose,
    /BEEP_CONTROL_PLANE_TOOLS_ENABLED:\s*"\$\{BEEP_CONTROL_PLANE_TOOLS_ENABLED:-0\}"/u,
    "compose should default control-plane tools disabled",
  );
  assert.match(
    runtimeManagerSource,
    /BEEP_CONTROL_PLANE_TOOLS_ENABLED:\s*process\.env\.BEEP_CONTROL_PLANE_TOOLS_ENABLED\s*\|\|\s*"0"/u,
    "managed runtime launches should default control-plane tools disabled",
  );
});

test("runtime compose publishes preview host port range for direct preview URLs", () => {
  const compose = readFileSync(join(process.cwd(), "docker/compose.runtime-dev.yml"), "utf8");

  assert.match(
    compose,
    /"127\.0\.0\.1:13000-13099:3000-3099"/u,
    "compose should map preview host ports 13000-13099 to runtime container ports 3000-3099",
  );
});

test("control-plane README does not reference missing agent runtime boundaries doc", () => {
  const readme = readFileSync(join(process.cwd(), "control-plane/README.md"), "utf8");

  assert.doesNotMatch(readme, /\.\.\/docs\/agent-runtime-boundaries\.md/u);
});
