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

test("runtime manager rejects unproven health before sending runtime API token", async () => {
  const originalFetch = globalThis.fetch;
  const { store, manager, cleanup } = tempManager();
  try {
    const token = store.ensureRuntimeApiToken();
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.authorization || null });
      return {
        ok: true,
        json: async () => ({ ok: true, service: "beep-agentd", runtimeId: "local" }),
      };
    };

    const status = await manager.status();
    assert.equal(status.running, false);
    assert.match(status.error, /managed runtime identity/i);

    await assert.rejects(() => manager.proxyToRuntime("/agent"), /managed runtime identity/i);
    assert.equal(calls.some((call) => call.authorization === `Bearer ${token}`), false);
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
    globalThis.fetch = async (url, options = {}) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/health") {
        const challenge = requestUrl.searchParams.get("challenge");
        const { createRuntimeHealthProof } = await import("../../runtime/src/runtime-api-auth.mjs");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            service: "beep-agentd",
            runtimeId: "local",
            managedProof: createRuntimeHealthProof({ challenge, runtimeApiToken: token }),
          }),
        };
      }
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

test("runtime manager attaches parsed upstream payloads to non-2xx proxy errors", async () => {
  const originalFetch = globalThis.fetch;
  const { store, manager, cleanup } = tempManager();
  try {
    const token = store.ensureRuntimeApiToken();
    globalThis.fetch = async (url) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/health") {
        const challenge = requestUrl.searchParams.get("challenge");
        const { createRuntimeHealthProof } = await import("../../runtime/src/runtime-api-auth.mjs");
        return {
          ok: true,
          json: async () => ({
            ok: true,
            service: "beep-agentd",
            runtimeId: "local",
            managedProof: createRuntimeHealthProof({ challenge, runtimeApiToken: token }),
          }),
        };
      }
      return {
        ok: false,
        status: 409,
        statusText: "Conflict",
        json: async () => ({ ok: false, compact: { ok: false, reason: "busy" } }),
      };
    };

    await assert.rejects(
      () => manager.proxyToRuntime("/agent/lcm/compact", { method: "POST" }),
      (error) => {
        assert.equal(error.message, "Conflict");
        assert.equal(error.status, 409);
        assert.equal(error.upstreamStatus, 409);
        assert.deepEqual(error.payload, { ok: false, compact: { ok: false, reason: "busy" } });
        return true;
      },
    );
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

test("runtime compose uses the published Hindsight image tag", () => {
  const compose = readFileSync(join(process.cwd(), "docker/compose.runtime-dev.yml"), "utf8");
  const imageEnv = readFileSync(join(process.cwd(), "docker/hindsight-image.env"), "utf8");

  assert.match(imageEnv, /^BEEP_HINDSIGHT_IMAGE=ghcr\.io\/vectorize-io\/hindsight:0\.7\.1$/mu);
  assert.match(compose, /ghcr\.io\/vectorize-io\/hindsight:0\.7\.1/u);
  assert.doesNotMatch(imageEnv, /hindsight:v\d/u, "Hindsight image tags are not v-prefixed on GHCR");
});

test("control-plane README does not reference missing agent runtime boundaries doc", () => {
  const readme = readFileSync(join(process.cwd(), "control-plane/README.md"), "utf8");

  assert.doesNotMatch(readme, /\.\.\/docs\/agent-runtime-boundaries\.md/u);
});
