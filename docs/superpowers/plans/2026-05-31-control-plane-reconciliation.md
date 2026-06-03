# Control Plane Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the prior local Beep control-plane slice onto current `main` while preserving the merged Hindsight + LCM sidecar runtime behavior.

**Architecture:** Import the committed control-plane boundary code in narrow groups from prior branches, prove each group with focused Node tests, and keep `beep-agentd` as the runtime house. The control plane owns operator/runtime tokens, request forwarding, tool routing, gatekeeper review, approvals, audit, and preview broker execution; the runtime only receives scoped tool stubs and keeps the current LCM/Hindsight path.

**Tech Stack:** Node.js ESM modules, Node built-in test runner, Docker Compose for live runtime startup, Pi runtime extensions, Lossless Claw LCM, current Hindsight sidecar compose service, shell scripts for local process control.

---

## File Structure

Create these control-plane files from `codex-end-to-end-hindsight-gatekeeper` unless a task explicitly says otherwise:

- `control-plane/src/config.mjs`: control-plane paths, ports, runtime IDs, preview limits, gatekeeper settings.
- `control-plane/src/http-utils.mjs`: JSON body parsing, JSON responses, CORS headers, error status extraction.
- `control-plane/src/state-store.mjs`: local locked JSON state, runtime/operator/model tokens, requests, approvals, sites, gatekeeper reviews, audit.
- `control-plane/src/tool-broker-error.mjs`: typed broker error with HTTP status.
- `control-plane/src/tool-manifest.mjs`: stable control-plane tool manifest and default-allowed scopes.
- `control-plane/src/gatekeeper/*.mjs` and `control-plane/src/gatekeeper/*.md`: managed static preview policy, evidence collection, prompt construction, decision normalization, local auto-review.
- `control-plane/src/static-site-preview.mjs`: safe static-site snapshot and managed preview container operations.
- `control-plane/src/tool-broker.mjs`: runtime tool-call classification, default-allowed preview-port execution, restricted static-preview gatekeeper/approval flow.
- `control-plane/src/approval-routes.mjs`: operator-only approval listing, approval, denial, and cancellation.
- `control-plane/src/site-routes.mjs`: operator-only site listing and stop operations.
- `control-plane/src/proxy-utils.mjs`: safe local preview proxy request options.
- `control-plane/src/codex-token.mjs`: local-dev Codex credential resolution for the model-credential endpoint.
- `control-plane/src/runtime-manager.mjs`: host-side runtime status, startup, stop, and proxy-to-runtime calls.
- `control-plane/src/server.mjs`: local HTTP control-plane API and internal capability endpoints.
- `control-plane/README.md`: operator usage and boundary notes.

Create or modify these runtime and repo files:

- `runtime/pi-extensions/control-plane-tools-extension.mjs`: Pi tool extension that calls `POST /internal/tools/call` on the control plane with the runtime token.
- `runtime/src/beep-runtime-api.mjs`: load the control-plane tools extension only when configured, without changing current LCM context extension logic.
- `test/runtime-integration-static.test.mjs`: static regression checks for Hindsight/LCM ordering plus control-plane extension loading.
- `scripts/runtime-dev-env.sh`: shared local-dev directory setup for control-plane startup.
- `scripts/beep-control-plane.sh`: host-side foreground/start/stop/status/logs/token helper.
- `scripts/smoke-test-control-plane-reconciliation.sh`: pure verification wrapper.
- `package.json`: add explicit control-plane and reconciliation test scripts.
- `runtime/README.md`: short note that the control plane is the host authority path and the runtime remains the LCM/Hindsight house.

Do not port these older branch pieces in this plan:

- `runtime/src/memory/*` from the older semantic-memory adapter branch.
- `vendor/hindsight` submodule changes from the older integration branch.
- Full runtime route refactor files such as `runtime/src/pi-rpc-session.mjs`, `runtime/src/agent-supervisor.mjs`, and `runtime/src/routes/*`.
- Web provider adapters from `codex-control-plane-runtime-boundary`; restore web tools in a separate plan after this boundary is stable.

### Task 1: Control-Plane State And HTTP Utilities

**Files:**
- Create: `control-plane/src/config.mjs`
- Create: `control-plane/src/http-utils.mjs`
- Create: `control-plane/src/state-store.mjs`
- Test: `control-plane/test/state-store.test.mjs`
- Test: `control-plane/test/http-utils.test.mjs`

- [ ] **Step 1: Restore only the tests first**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/test/state-store.test.mjs \
  control-plane/test/http-utils.test.mjs
```

- [ ] **Step 2: Run tests to verify the implementation is still missing**

Run:

```bash
node --test control-plane/test/state-store.test.mjs control-plane/test/http-utils.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `control-plane/src/state-store.mjs` or `control-plane/src/http-utils.mjs`.

- [ ] **Step 3: Restore the minimal implementation files**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/src/config.mjs \
  control-plane/src/http-utils.mjs \
  control-plane/src/state-store.mjs
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test control-plane/test/state-store.test.mjs control-plane/test/http-utils.test.mjs
```

Expected: PASS. The state-store test must prove runtime, runtime API, model credential, and operator tokens are four distinct token values.

- [ ] **Step 5: Inspect for authority-boundary regressions**

Run:

```bash
rg -n "docker|spawn\\(|exec\\(|approval_policy|BEEP_HINDSIGHT|memory-coordinator|hindsight" control-plane/src/config.mjs control-plane/src/http-utils.mjs control-plane/src/state-store.mjs
```

Expected: no matches that execute Docker or import runtime memory code. Path constants and token file names are acceptable.

- [ ] **Step 6: Commit**

Run:

```bash
git add control-plane/src/config.mjs control-plane/src/http-utils.mjs control-plane/src/state-store.mjs control-plane/test/state-store.test.mjs control-plane/test/http-utils.test.mjs
git commit -m "feat: restore control plane state store"
```

### Task 2: Static Preview Evidence And Snapshot Safety

**Files:**
- Create: `control-plane/src/tool-broker-error.mjs`
- Create: `control-plane/src/gatekeeper/evidence.mjs`
- Create: `control-plane/src/static-site-preview.mjs`
- Test: `control-plane/test/static-site-preview.test.mjs`

- [ ] **Step 1: Restore the static preview safety test**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/test/static-site-preview.test.mjs
```

- [ ] **Step 2: Run the test to verify static preview implementation is missing**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `control-plane/src/static-site-preview.mjs`.

- [ ] **Step 3: Restore static preview implementation and evidence collector**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/src/tool-broker-error.mjs \
  control-plane/src/gatekeeper/evidence.mjs \
  control-plane/src/static-site-preview.mjs
```

- [ ] **Step 4: Run focused static preview tests**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs
```

Expected: PASS. The tests must prove snapshot independence, `.env` rejection, symlinked directory rejection, and symlinked parent-component rejection.

- [ ] **Step 5: Inspect the static preview source for raw runtime authority**

Run:

```bash
rg -n "BEEP_CONTROL_PLANE_RUNTIME_TOKEN|operator-token|/state/codex|/lcm|BEEP_HINDSIGHT|memory" control-plane/src/static-site-preview.mjs control-plane/src/gatekeeper/evidence.mjs
```

Expected: no matches. Static preview validation must not read runtime auth, LCM, Hindsight, or memory files.

- [ ] **Step 6: Commit**

Run:

```bash
git add control-plane/src/tool-broker-error.mjs control-plane/src/gatekeeper/evidence.mjs control-plane/src/static-site-preview.mjs control-plane/test/static-site-preview.test.mjs
git commit -m "feat: restore static preview safety checks"
```

### Task 3: Gatekeeper And Tool Broker

**Files:**
- Create: `control-plane/src/tool-manifest.mjs`
- Create: `control-plane/src/tool-broker.mjs`
- Create: `control-plane/src/gatekeeper/context.mjs`
- Create: `control-plane/src/gatekeeper/decision-schema.mjs`
- Create: `control-plane/src/gatekeeper/index.mjs`
- Create: `control-plane/src/gatekeeper/policy-template.md`
- Create: `control-plane/src/gatekeeper/policy.md`
- Create: `control-plane/src/gatekeeper/prompt.mjs`
- Test: `control-plane/test/gatekeeper.test.mjs`

- [ ] **Step 1: Restore the gatekeeper/broker test first**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/test/gatekeeper.test.mjs
```

- [ ] **Step 2: Run the gatekeeper test to verify implementation is missing**

Run:

```bash
node --test control-plane/test/gatekeeper.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `control-plane/src/gatekeeper/index.mjs` or `control-plane/src/tool-broker.mjs`.

- [ ] **Step 3: Restore gatekeeper and broker files**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/src/tool-manifest.mjs \
  control-plane/src/tool-broker.mjs \
  control-plane/src/gatekeeper/context.mjs \
  control-plane/src/gatekeeper/decision-schema.mjs \
  control-plane/src/gatekeeper/index.mjs \
  control-plane/src/gatekeeper/policy-template.md \
  control-plane/src/gatekeeper/policy.md \
  control-plane/src/gatekeeper/prompt.mjs
```

- [ ] **Step 4: Run focused gatekeeper tests**

Run:

```bash
node --test control-plane/test/gatekeeper.test.mjs
```

Expected: PASS. The tests must prove bounded static preview allow, explicit user denial, contradictory preview instructions deny, invalid evidence denies, missing authorization creates `needs_review`, and hidden gatekeeper rationale is not agent-visible.

- [ ] **Step 5: Verify public gatekeeper outcomes are constrained**

Run:

```bash
node --input-type=module - <<'NODE'
import { normalizeGatekeeperDecision } from "./control-plane/src/gatekeeper/decision-schema.mjs";

const allowed = ["allow", "allow_for_session", "deny", "timeout", "circuit_breaker", "escalate_to_user"];
for (const outcome of allowed) {
  const decision = normalizeGatekeeperDecision({
    outcome,
    scope: "once",
    riskLevel: "medium",
    userAuthorization: "unknown",
    auditRationale: "test",
    agentMessage: "safe",
    userPrompt: null,
  });
  if (decision.outcome !== outcome) throw new Error(`outcome mismatch: ${outcome}`);
}
try {
  normalizeGatekeeperDecision({
    outcome: "raw_reasoning",
    auditRationale: "bad",
    agentMessage: "bad",
  });
  throw new Error("unexpectedly accepted raw_reasoning");
} catch (error) {
  if (!/Invalid gatekeeper outcome/.test(String(error.message))) throw error;
}
NODE
```

Expected: command exits 0.

- [ ] **Step 6: Commit**

Run:

```bash
git add control-plane/src/tool-manifest.mjs control-plane/src/tool-broker.mjs control-plane/src/gatekeeper control-plane/test/gatekeeper.test.mjs
git commit -m "feat: restore control plane gatekeeper broker"
```

### Task 4: Approval Routes, Runtime Manager, And Server Boundary

**Files:**
- Create: `control-plane/src/approval-routes.mjs`
- Create: `control-plane/src/site-routes.mjs`
- Create: `control-plane/src/proxy-utils.mjs`
- Create: `control-plane/src/codex-token.mjs`
- Create: `control-plane/src/runtime-manager.mjs`
- Create: `control-plane/src/server.mjs`
- Test: `control-plane/test/proxy-utils.test.mjs`
- Test: `control-plane/test/codex-token.test.mjs`
- Test: `control-plane/test/approval-routes-auth.test.mjs`
- Test: `control-plane/test/runtime-manager.test.mjs`

- [ ] **Step 1: Restore existing route and utility tests**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/test/proxy-utils.test.mjs \
  control-plane/test/codex-token.test.mjs
```

- [ ] **Step 2: Add approval-route auth test**

Use `apply_patch`:

```diff
*** Begin Patch
*** Add File: control-plane/test/approval-routes-auth.test.mjs
+import assert from "node:assert/strict";
+import { mkdtempSync, rmSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { PassThrough } from "node:stream";
+import test from "node:test";
+import { handleApprovalRoute } from "../src/approval-routes.mjs";
+import { StateStore } from "../src/state-store.mjs";
+
+function tempStore() {
+  const dir = mkdtempSync(join(tmpdir(), "beep-approval-auth-test-"));
+  const store = new StateStore(dir);
+  return {
+    store,
+    cleanup: () => rmSync(dir, { recursive: true, force: true }),
+  };
+}
+
+function requestWithAuth(method, authorization, body = null) {
+  const request = new PassThrough();
+  request.method = method;
+  request.headers = authorization ? { authorization } : {};
+  process.nextTick(() => {
+    if (body) request.write(JSON.stringify(body));
+    request.end();
+  });
+  return request;
+}
+
+function captureResponse() {
+  let statusCode = 0;
+  let body = "";
+  return {
+    response: {
+      writeHead(status) {
+        statusCode = status;
+      },
+      end(chunk = "") {
+        body += chunk;
+      },
+    },
+    json() {
+      return { statusCode, payload: body ? JSON.parse(body) : null };
+    },
+  };
+}
+
+test("runtime token cannot list operator approval records", async () => {
+  const { store, cleanup } = tempStore();
+  try {
+    const runtimeToken = store.ensureRuntimeToken();
+    const operatorToken = store.ensureOperatorToken();
+    assert.notEqual(runtimeToken, operatorToken);
+
+    const request = requestWithAuth("GET", `Bearer ${runtimeToken}`);
+    const response = captureResponse();
+    await assert.rejects(
+      handleApprovalRoute({
+        request,
+        response: response.response,
+        pathname: "/api/approvals",
+        url: new URL("http://127.0.0.1/api/approvals"),
+        store,
+        toolBroker: {},
+        requireOperatorAuth(req) {
+          if (req.headers.authorization !== `Bearer ${operatorToken}`) {
+            const error = new Error("operator token is invalid");
+            error.status = 401;
+            throw error;
+          }
+        },
+      }),
+      /operator token is invalid/u,
+    );
+  } finally {
+    cleanup();
+  }
+});
+
+test("operator token can list pending approval records", async () => {
+  const { store, cleanup } = tempStore();
+  try {
+    const operatorToken = store.ensureOperatorToken();
+    const approval = store.createApproval({
+      runtimeId: "local",
+      toolCallId: "call_auth",
+      action: "preview.container.createStaticSite",
+      args: { sourcePath: "/workspace/site" },
+      risk: "high",
+      prompt: "Approve preview?",
+      reason: "test",
+    });
+
+    const request = requestWithAuth("GET", `Bearer ${operatorToken}`);
+    const response = captureResponse();
+    await handleApprovalRoute({
+      request,
+      response: response.response,
+      pathname: "/api/approvals",
+      url: new URL("http://127.0.0.1/api/approvals"),
+      store,
+      toolBroker: {},
+      requireOperatorAuth(req) {
+        if (req.headers.authorization !== `Bearer ${operatorToken}`) {
+          const error = new Error("operator token is invalid");
+          error.status = 401;
+          throw error;
+        }
+      },
+    });
+
+    const { statusCode, payload } = response.json();
+    assert.equal(statusCode, 200);
+    assert.equal(payload.ok, true);
+    assert.equal(payload.approvals[0].approvalId, approval.approvalId);
+  } finally {
+    cleanup();
+  }
+});
*** End Patch
```

- [ ] **Step 3: Add runtime-manager proxy test**

Use `apply_patch`:

```diff
*** Begin Patch
*** Add File: control-plane/test/runtime-manager.test.mjs
+import assert from "node:assert/strict";
+import { mkdtempSync, rmSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import test from "node:test";
+import { RuntimeManager } from "../src/runtime-manager.mjs";
+import { StateStore } from "../src/state-store.mjs";
+
+function tempManager() {
+  const dir = mkdtempSync(join(tmpdir(), "beep-runtime-manager-test-"));
+  const store = new StateStore(dir);
+  const manager = new RuntimeManager({ store });
+  return {
+    store,
+    manager,
+    cleanup: () => rmSync(dir, { recursive: true, force: true }),
+  };
+}
+
+test("runtime manager reports stopped when runtime health is unavailable", async () => {
+  const originalFetch = globalThis.fetch;
+  const { manager, cleanup } = tempManager();
+  try {
+    globalThis.fetch = async () => ({
+      ok: false,
+      status: 503,
+      statusText: "Service Unavailable",
+      json: async () => ({ ok: false, error: "down" }),
+    });
+
+    const status = await manager.status();
+    assert.equal(status.runtimeId, "local");
+    assert.equal(status.running, false);
+    assert.match(status.error, /down/u);
+  } finally {
+    globalThis.fetch = originalFetch;
+    cleanup();
+  }
+});
+
+test("runtime manager proxies to runtime with runtime API token", async () => {
+  const originalFetch = globalThis.fetch;
+  const { store, manager, cleanup } = tempManager();
+  try {
+    const token = store.ensureRuntimeApiToken();
+    let seenAuthorization = null;
+    globalThis.fetch = async (_url, options = {}) => {
+      seenAuthorization = options.headers.authorization;
+      return {
+        ok: true,
+        json: async () => ({ ok: true }),
+      };
+    };
+
+    const result = await manager.proxyToRuntime("/agent");
+    assert.equal(result.ok, true);
+    assert.equal(seenAuthorization, `Bearer ${token}`);
+  } finally {
+    globalThis.fetch = originalFetch;
+    cleanup();
+  }
+});
*** End Patch
```

- [ ] **Step 4: Run tests to verify route implementation is missing**

Run:

```bash
node --test \
  control-plane/test/proxy-utils.test.mjs \
  control-plane/test/codex-token.test.mjs \
  control-plane/test/approval-routes-auth.test.mjs \
  control-plane/test/runtime-manager.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `control-plane/src/approval-routes.mjs`, `control-plane/src/proxy-utils.mjs`, `control-plane/src/codex-token.mjs`, or `control-plane/src/runtime-manager.mjs`.

- [ ] **Step 5: Restore route, model credential, runtime manager, and server files**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  control-plane/src/approval-routes.mjs \
  control-plane/src/site-routes.mjs \
  control-plane/src/proxy-utils.mjs \
  control-plane/src/codex-token.mjs \
  control-plane/src/runtime-manager.mjs \
  control-plane/src/server.mjs
```

- [ ] **Step 6: Preserve current Hindsight compose behavior in runtime manager**

Use `apply_patch`:

```diff
*** Begin Patch
*** Update File: control-plane/src/runtime-manager.mjs
@@
-import { existsSync, readFileSync } from "node:fs";
+import { existsSync, readFileSync } from "node:fs";
+import { join } from "node:path";
@@
 function run(command, args, { cwd = ROOT_DIR, env = process.env } = {}) {
@@
 }
+
+function composeArgs(...args) {
+  const envFile = join(ROOT_DIR, "docker/hindsight-image.env");
+  return existsSync(envFile) ? ["compose", "--env-file", envFile, ...args] : ["compose", ...args];
+}
@@
-    await run("docker", ["compose", "-f", COMPOSE_FILE, "--profile", "api", "up", "--build", "-d", "beep-runtime-api"], {
+    await run("docker", composeArgs("-f", COMPOSE_FILE, "--profile", "api", "up", "--build", "-d", "beep-runtime-api"), {
       env: composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }),
     });
@@
-    await run("docker", ["compose", "-f", COMPOSE_FILE, "--profile", "api", "stop", "beep-runtime-api"], {
+    await run("docker", composeArgs("-f", COMPOSE_FILE, "--profile", "api", "stop", "beep-runtime-api"), {
       env: composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }),
     });
*** End Patch
```

- [ ] **Step 7: Run focused route tests**

Run:

```bash
node --test \
  control-plane/test/proxy-utils.test.mjs \
  control-plane/test/codex-token.test.mjs \
  control-plane/test/approval-routes-auth.test.mjs \
  control-plane/test/runtime-manager.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Run all control-plane tests restored so far**

Run:

```bash
node --test control-plane/test/*.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add control-plane/src/approval-routes.mjs control-plane/src/site-routes.mjs control-plane/src/proxy-utils.mjs control-plane/src/codex-token.mjs control-plane/src/runtime-manager.mjs control-plane/src/server.mjs control-plane/test
git commit -m "feat: restore control plane request boundary"
```

### Task 5: Runtime Control-Plane Tool Extension

**Files:**
- Create: `runtime/pi-extensions/control-plane-tools-extension.mjs`
- Modify: `runtime/src/beep-runtime-api.mjs`
- Modify: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Add static tests for extension loading without changing implementation**

Use `apply_patch`:

```diff
*** Begin Patch
*** Update File: test/runtime-integration-static.test.mjs
@@
 test("agent request records LCM before Hindsight retain", () => {
   const lcmIndex = apiSource.indexOf("request.lcm = await session.recordLcm");
   const retainIndex = apiSource.indexOf("defaultMemoryCoordinator.retainPiSessionSpan");
   assert.ok(lcmIndex > 0, "LCM record call should exist");
   assert.ok(retainIndex > 0, "Hindsight retain call should exist");
   assert.ok(lcmIndex < retainIndex, "LCM ingest must happen before Hindsight retain");
 });
+
+test("Pi spawn can load control-plane tools extension independently from LCM context extension", () => {
+  const lcmConstantIndex = apiSource.indexOf("LCM_CONTEXT_EXTENSION_PATH");
+  const toolsConstantIndex = apiSource.indexOf("CONTROL_PLANE_TOOLS_EXTENSION_PATH");
+  const lcmPushIndex = apiSource.indexOf("args.push(\"--extension\", LCM_CONTEXT_EXTENSION_PATH)");
+  const toolsPushIndex = apiSource.indexOf("args.push(\"--extension\", CONTROL_PLANE_TOOLS_EXTENSION_PATH)");
+
+  assert.ok(lcmConstantIndex > 0, "LCM context extension constant should still exist");
+  assert.ok(toolsConstantIndex > 0, "control-plane tools extension constant should exist");
+  assert.ok(lcmPushIndex > 0, "LCM context extension should still be loaded");
+  assert.ok(toolsPushIndex > 0, "control-plane tools extension should be loaded when configured");
+});
+
+test("control-plane tool env is passed to Pi without changing Hindsight memory order", () => {
+  const envIndex = apiSource.indexOf("BEEP_CONTROL_PLANE_TOOLS_ENABLED");
+  const recallIndex = apiSource.indexOf("defaultMemoryCoordinator.recallForContext");
+  const assembleIndex = apiSource.indexOf("defaultLcmService.assembleMessages");
+
+  assert.ok(envIndex > 0, "control-plane tool env should be passed into Pi");
+  assert.ok(recallIndex > 0, "Hindsight recall should still exist");
+  assert.ok(assembleIndex > recallIndex, "Hindsight recall must still feed LCM before assemble");
+});
*** End Patch
```

- [ ] **Step 2: Run static runtime tests to verify new assertions fail**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL with assertion message containing `control-plane tools extension constant should exist`.

- [ ] **Step 3: Restore the runtime tool extension**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  runtime/pi-extensions/control-plane-tools-extension.mjs
```

- [ ] **Step 4: Patch `beep-runtime-api.mjs` to load the control-plane tool extension**

Use `apply_patch`:

```diff
*** Begin Patch
*** Update File: runtime/src/beep-runtime-api.mjs
@@
 const LCM_CONTEXT_TOKEN = process.env.BEEP_LCM_CONTEXT_TOKEN || randomUUID();
 const LCM_CONTEXT_TOKEN_BUDGET = process.env.BEEP_LCM_CONTEXT_TOKEN_BUDGET || "128000";
 const LCM_CONTEXT_TIMEOUT_MS = process.env.BEEP_LCM_CONTEXT_TIMEOUT_MS || "15000";
+const CONTROL_PLANE_TOOLS_ENABLED =
+  !["0", "false", "no", "off"].includes(String(process.env.BEEP_CONTROL_PLANE_TOOLS_ENABLED || "1").toLowerCase());
+const CONTROL_PLANE_TOOLS_EXTENSION_PATH =
+  process.env.BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH || "/runtime/pi-extensions/control-plane-tools-extension.mjs";
 const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
@@
     const lcmContextExtensionLoaded = LCM_CONTEXT_ENABLED && existsSync(LCM_CONTEXT_EXTENSION_PATH);
     if (lcmContextExtensionLoaded) {
       args.push("--extension", LCM_CONTEXT_EXTENSION_PATH);
     }
+    const controlPlaneToolsExtensionLoaded =
+      CONTROL_PLANE_TOOLS_ENABLED &&
+      Boolean(process.env.BEEP_CONTROL_PLANE_URL) &&
+      Boolean(process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN) &&
+      existsSync(CONTROL_PLANE_TOOLS_EXTENSION_PATH);
+    if (controlPlaneToolsExtensionLoaded) {
+      args.push("--extension", CONTROL_PLANE_TOOLS_EXTENSION_PATH);
+    }
@@
       lcmContext: {
         enabled: LCM_CONTEXT_ENABLED,
         extensionPath: LCM_CONTEXT_EXTENSION_PATH,
         extensionLoaded: lcmContextExtensionLoaded,
         url: LCM_CONTEXT_URL,
         tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
         timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
       },
+      controlPlaneTools: {
+        enabled: CONTROL_PLANE_TOOLS_ENABLED,
+        extensionPath: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
+        extensionLoaded: controlPlaneToolsExtensionLoaded,
+        url: process.env.BEEP_CONTROL_PLANE_URL || null,
+        runtimeId: process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || null,
+      },
       createdAt: this.createdAt,
     });
@@
       BEEP_LCM_RUNTIME_SESSION_ID: this.id,
       BEEP_LCM_CONTEXT_TOKEN_BUDGET: LCM_CONTEXT_TOKEN_BUDGET,
       BEEP_LCM_CONTEXT_TIMEOUT_MS: LCM_CONTEXT_TIMEOUT_MS,
+      BEEP_CONTROL_PLANE_TOOLS_ENABLED: controlPlaneToolsExtensionLoaded ? "1" : "0",
+      BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
     };
*** End Patch
```

- [ ] **Step 5: Run static runtime tests**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: PASS. Existing Hindsight + LCM ordering tests must still pass.

- [ ] **Step 6: Run all current main tests**

Run:

```bash
node --test test/*.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add runtime/pi-extensions/control-plane-tools-extension.mjs runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
git commit -m "feat: wire runtime control plane tools"
```

### Task 6: Control-Plane Local Script And Docs

**Files:**
- Create: `scripts/runtime-dev-env.sh`
- Create: `scripts/beep-control-plane.sh`
- Create: `control-plane/README.md`
- Modify: `runtime/README.md`

- [ ] **Step 1: Restore control-plane shell helpers and README**

Run:

```bash
git restore --source=codex-end-to-end-hindsight-gatekeeper -- \
  scripts/runtime-dev-env.sh \
  scripts/beep-control-plane.sh \
  control-plane/README.md
chmod +x scripts/runtime-dev-env.sh scripts/beep-control-plane.sh
```

- [ ] **Step 2: Patch operator-token helper for no-server token creation**

Use `apply_patch` so `operator-token` is also a state-store helper and does not require the server to be started first:

```diff
*** Begin Patch
*** Update File: scripts/beep-control-plane.sh
@@
 operator_token() {
-  local token_file="$STATE_DIR/operator-token"
-  if [ ! -f "$token_file" ]; then
-    echo "operator token does not exist yet; start the control plane first" >&2
-    exit 1
-  fi
-  cat "$token_file"
+  state_store_token ensureOperatorToken
 }
*** End Patch
```

- [ ] **Step 3: Run shell syntax checks**

Run:

```bash
bash -n scripts/runtime-dev-env.sh
bash -n scripts/beep-control-plane.sh
```

Expected: both commands exit 0.

- [ ] **Step 4: Verify script token helpers work without starting Docker**

Run:

```bash
runtime_token="$(./scripts/beep-control-plane.sh runtime-token)"
runtime_api_token="$(./scripts/beep-control-plane.sh runtime-api-token)"
model_token="$(./scripts/beep-control-plane.sh model-credential-token)"
operator_token="$(./scripts/beep-control-plane.sh operator-token)"
test -n "$runtime_token"
test -n "$runtime_api_token"
test -n "$model_token"
test "$runtime_token" != "$runtime_api_token"
test "$runtime_token" != "$model_token"
test "$runtime_api_token" != "$model_token"
test -n "$operator_token"
```

Expected: command exits 0. This creates local token files under `.beep-dev/control-plane`.

- [ ] **Step 5: Add runtime README control-plane note**

Use `apply_patch`:

```diff
*** Begin Patch
*** Update File: runtime/README.md
@@
 `beep-agentd` is not the future trust boundary for external tools. It owns the
 sandbox-local agent loop, queue, events, Pi RPC process, and LCM adapter. Future
 website, location, calendar, email, Docker, and secret tools should be exposed
 to the harness as local stubs that submit `ToolIntent` requests to the control
 plane. The control plane owns the durable tool router, gatekeeper, grants,
 audit log, and typed broker execution.
+
+The local control plane is restored under `control-plane/` and can be run from
+the host:
+
+```bash
+./scripts/beep-control-plane.sh start
+./scripts/beep-control-plane.sh status
+./scripts/beep-control-plane.sh stop
+```
+
+When the control plane starts the runtime, it passes scoped control-plane tool
+credentials into the container. `beep-agentd` loads
+`/runtime/pi-extensions/control-plane-tools-extension.mjs` only when those
+credentials are present. LCM context injection and Hindsight recall/retain
+ordering remain owned by the runtime house.
*** End Patch
```

- [ ] **Step 6: Check docs for stale older-memory claims**

Run:

```bash
rg -n "vendor/hindsight|semantic-memory|memory-bridge|projection-ledger|replaces Hindsight sidecar" control-plane/README.md runtime/README.md
```

Expected: no matches that instruct replacing current main's Hindsight sidecar with the older semantic-memory adapter. Mentions of Hindsight + LCM sidecar behavior in `runtime/README.md` are acceptable.

- [ ] **Step 7: Commit**

Run:

```bash
git add scripts/runtime-dev-env.sh scripts/beep-control-plane.sh control-plane/README.md runtime/README.md
git commit -m "docs: restore control plane local workflow"
```

### Task 7: Package Scripts And Pure Smoke Wrapper

**Files:**
- Modify: `package.json`
- Create: `scripts/smoke-test-control-plane-reconciliation.sh`

- [ ] **Step 1: Add package test scripts**

Use `apply_patch`:

```diff
*** Begin Patch
*** Update File: package.json
@@
   "scripts": {
     "test": "node --test test/*.test.mjs",
     "test:hindsight": "node --test test/hindsight-service.test.mjs test/external-memory-hints.test.mjs test/memory-coordinator.test.mjs",
     "test:lcm": "node --test test/lcm-external-memory.test.mjs",
     "test:proof": "node --test test/proof-memory-lifecycle.test.mjs",
-    "test:runtime-static": "node --test test/runtime-integration-static.test.mjs"
+    "test:runtime-static": "node --test test/runtime-integration-static.test.mjs",
+    "test:control-plane": "node --test control-plane/test/*.test.mjs",
+    "test:reconciliation": "node --test test/*.test.mjs control-plane/test/*.test.mjs"
   }
 }
*** End Patch
```

- [ ] **Step 2: Add pure smoke wrapper**

Use `apply_patch`:

```diff
*** Begin Patch
*** Add File: scripts/smoke-test-control-plane-reconciliation.sh
+#!/usr/bin/env bash
+set -euo pipefail
+
+ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
+
+node --test "$ROOT_DIR"/test/*.test.mjs
+node --test "$ROOT_DIR"/control-plane/test/*.test.mjs
+
+bash -n "$ROOT_DIR/scripts/runtime-dev-env.sh"
+bash -n "$ROOT_DIR/scripts/beep-control-plane.sh"
+
+runtime_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-token)"
+runtime_api_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-api-token)"
+model_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" model-credential-token)"
+operator_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" operator-token)"
+
+test -n "$runtime_token"
+test -n "$runtime_api_token"
+test -n "$model_token"
+test -n "$operator_token"
+test "$runtime_token" != "$runtime_api_token"
+test "$runtime_token" != "$model_token"
+test "$runtime_api_token" != "$model_token"
+test "$operator_token" != "$runtime_token"
+
+cat <<'EOF'
+Pure control-plane reconciliation checks passed.
+
+For live verification with Docker and Codex auth:
+
+  ./scripts/beep-control-plane.sh start
+  ./scripts/beep-control-plane.sh status
+  ./scripts/smoke-test-hindsight-lcm.sh
+EOF
*** End Patch
```

- [ ] **Step 3: Make smoke wrapper executable**

Run:

```bash
chmod +x scripts/smoke-test-control-plane-reconciliation.sh
```

- [ ] **Step 4: Run pure smoke**

Run:

```bash
./scripts/smoke-test-control-plane-reconciliation.sh
```

Expected: PASS and final output starts with `Pure control-plane reconciliation checks passed.`

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json scripts/smoke-test-control-plane-reconciliation.sh
git commit -m "test: add control plane reconciliation smoke"
```

### Task 8: Final Verification And Boundary Review

**Files:**
- Modify only files required to fix defects found by the commands in this task.

- [ ] **Step 1: Run all pure tests**

Run:

```bash
npm run test:reconciliation
```

Expected: PASS.

- [ ] **Step 2: Run focused package scripts**

Run:

```bash
npm run test:control-plane
npm run test:runtime-static
npm run test:hindsight
npm run test:lcm
npm run test:proof
```

Expected: PASS for every command.

- [ ] **Step 3: Run boundary scans**

Run:

```bash
rg -n "vendor/hindsight|runtime/src/memory|memory-bridge|projection-ledger|semantic-memory-service|lcm-recall-tools|pi-rpc-session|agent-supervisor" control-plane runtime scripts test package.json
rg -n "BEEP_CONTROL_PLANE_RUNTIME_TOKEN|operator-token|ensureOperatorToken|/api/approvals|/internal/tools/call" control-plane runtime/pi-extensions scripts
```

Expected: first command has no matches except documentation or plan references if docs are included by mistake; this scan command intentionally excludes `docs/`. Second command shows runtime token use only for `/internal/tools/call`, operator token helpers only in `control-plane/src/state-store.mjs`, `control-plane/src/server.mjs`, and `scripts/beep-control-plane.sh`, and approval routes only under control-plane files.

- [ ] **Step 4: Confirm current Hindsight + LCM ordering still exists**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
rg -n "defaultMemoryCoordinator.recallForContext|defaultLcmService.assembleMessages|retainPiSessionSpan|request.lcm = await session.recordLcm" runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
```

Expected: test passes, and `recallForContext` appears before `assembleMessages`; `request.lcm = await session.recordLcm` appears before `retainPiSessionSpan`.

- [ ] **Step 5: Inspect git diff and recent commits**

Run:

```bash
git status --short
git log --oneline --decorate -10
```

Expected: working tree is clean, and recent commits are the task commits from this plan.

- [ ] **Step 6: Run live control-plane status only when Docker is available**

Run:

```bash
./scripts/beep-control-plane.sh start
./scripts/beep-control-plane.sh status
./scripts/beep-control-plane.sh stop
```

Expected: If Docker and Codex auth are available, status reports `beep-control-plane` health and the local runtime status. If Docker or Codex auth is unavailable, record the exact failure in the final implementation notes and keep pure verification as the passing baseline.

- [ ] **Step 7: Commit final fixes if any were required**

If Step 1 through Step 6 required edits, run:

```bash
git add control-plane runtime scripts test package.json
git commit -m "chore: finalize control plane reconciliation"
```

Expected: commit succeeds. If no edits were required after Task 7, skip this commit and report that no final fixes were needed.

## Self-Review

Spec coverage:

- Control-plane service, state, tokens, request forwarding, tool broker, approval records, gatekeeper, audit, and static preview records are covered by Tasks 1 through 4.
- Runtime-house preservation and current Hindsight + LCM ordering are covered by Tasks 5 and 8.
- Scripted local workflow and docs are covered by Tasks 6 and 7.
- Non-goals are enforced by file exclusions in the File Structure section and boundary scans in Task 8.

Placeholder scan:

- The plan contains no unresolved placeholder markers and no steps that ask the implementer to invent unspecified behavior.

Type consistency:

- The plan consistently uses `runtimeId`, `toolCallId`, `approvalId`, `preview.port.expose`, `preview.container.createStaticSite`, `ensureRuntimeToken`, `ensureRuntimeApiToken`, `ensureModelCredentialToken`, and `ensureOperatorToken`.
