import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeManager } from "../src/runtime-manager.mjs";
import { StateStore } from "../src/state-store.mjs";

const runtimeManagerSource = readFileSync(new URL("../src/runtime-manager.mjs", import.meta.url), "utf8");
const runtimeConfigSource = readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");

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

test("runtime manager starts and stops the configured host-loop compose service", async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "beep-runtime-manager-service-test-"));
  const store = new StateStore(dir);
  const { createRuntimeHealthProof } = await import("../../runtime/src/runtime-api-auth.mjs");
  try {
    const manager = new RuntimeManager({
      store,
      runCommand: async (command, args, options = {}) => {
        calls.push({ command, args, env: options.env || {} });
        return { stdout: "", stderr: "" };
      },
      fetchRuntime: async () => ({
        ok: true,
        service: "beep-agentd",
        runtimeId: "local",
        managedProof: createRuntimeHealthProof({
          challenge: "challenge",
          runtimeApiToken: store.ensureRuntimeApiToken(),
        }),
      }),
      challengeFactory: () => "challenge",
      runtimeService: "beep-host-loop",
    });

    await manager.ensureRuntime({ rebuild: true });
    await manager.stopRuntime();

    const up = calls.find((call) => call.args.includes("up"));
    const stop = calls.find((call) => call.args.includes("stop"));
    assert.ok(up, "runtime manager should start compose");
    assert.ok(stop, "runtime manager should stop compose");
    assert.equal(up.args.at(-1), "beep-host-loop");
    assert.equal(stop.args.at(-1), "beep-host-loop");
    assert.match(up.env.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT, /\.beep-dev\/workspace\/sandboxes$/u);
    assert.match(up.env.BEEP_DOCKER_GROUP_ID, /^\d+$/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("runtime compose declares the trusted host-loop service and sandbox boundary", () => {
  const compose = readFileSync(join(process.cwd(), "docker/compose.runtime-dev.yml"), "utf8");

  assert.match(runtimeConfigSource, /RUNTIME_COMPOSE_SERVICE[\s\S]*\|\|\s*"beep-host-loop"/u);
  assert.match(runtimeConfigSource, /SANDBOX_DOCKER_WORKSPACE_ROOT[\s\S]*\.beep-dev\/workspace\/sandboxes/u);
  assert.match(runtimeManagerSource, /RUNTIME_COMPOSE_SERVICE/u);
  assert.match(runtimeManagerSource, /BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT:\s*SANDBOX_DOCKER_WORKSPACE_ROOT/u);
  assert.match(runtimeManagerSource, /function dockerSocketGroupId\(/u);
  assert.match(runtimeManagerSource, /BEEP_DOCKER_GROUP_ID:\s*dockerSocketGroupId\(\)/u);
  assert.match(compose, /^x-beep-runtime-env:\s*&beep-runtime-env$/mu);
  assert.match(compose, /^\s+beep-host-loop:/mu);
  assert.match(compose, /^\s+BEEP_SANDBOX_TOOL_BACKEND:\s*docker$/mu);
  assert.match(compose, /^\s+BEEP_SANDBOX_TOOL_PORTAL_ENABLED:\s*"1"$/mu);
  assert.match(compose, /^\s+BEEP_SANDBOX_IMAGE:\s*"\$\{BEEP_SANDBOX_IMAGE:-beep-sandbox:local\}"$/mu);
  assert.match(compose, /^\s+BEEP_SANDBOX_WORKSPACE_ROOT:\s*\/workspace\/sandboxes$/mu);
  assert.match(
    compose,
    /^\s+BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT:\s*"\$\{BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT:-\$\{PWD\}\/\.\.\/\.beep-dev\/workspace\/sandboxes\}"$/mu,
  );
  assert.match(compose, /^\s+- \/var\/run\/docker\.sock:\/var\/run\/docker\.sock$/mu);
  assert.match(compose, /^\s+- "\$\{BEEP_DOCKER_GROUP_ID:-0\}"$/mu);
  assert.match(compose, /^\s+user:\s*"\$\{BEEP_HOST_LOOP_USER:-0:0\}"$/mu);
  assert.match(compose, /"127\.0\.0\.1:13000-13099:3000-3099"/u);
  assert.match(compose, /beep-runtime-api:[\s\S]*<<: \*beep-runtime-common/u);
  assert.match(compose, /beep-runtime-api:[\s\S]*profiles:[\s\S]*legacy-api/u);
  assert.match(compose, /beep-host-loop:[\s\S]*profiles:[\s\S]*api/u);
});

test("local agentd script derives Docker socket group and host sandbox workspace", () => {
  const script = readFileSync(join(process.cwd(), "scripts/beep-agentd.sh"), "utf8");

  assert.match(script, /stat -f "%g" \/var\/run\/docker\.sock/u);
  assert.match(script, /stat -c "%g" \/var\/run\/docker\.sock/u);
  assert.match(script, /export BEEP_DOCKER_GROUP_ID="\$\{BEEP_DOCKER_GROUP_ID:-0\}"/u);
  assert.match(script, /BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT:-\$ROOT_DIR\/\.beep-dev\/workspace\/sandboxes/u);
  assert.match(script, /--profile api up --build "\$BEEP_RUNTIME_COMPOSE_SERVICE"/u);
});

test("runtime image installs Docker CLI for trusted host-loop sandbox management", () => {
  const dockerfile = readFileSync(join(process.cwd(), "docker/runtime.Dockerfile"), "utf8");

  assert.match(dockerfile, /\bdocker\.io\b/u);
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
