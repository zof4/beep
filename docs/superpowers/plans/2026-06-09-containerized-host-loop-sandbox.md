# Containerized Host Loop Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the first usable backend loop into a containerized trusted host-loop service that keeps the agent alive while code execution happens in dynamically spawned Docker sandboxes.

**Architecture:** Keep the current `beep-agentd`/`PiRpcSession` implementation as the trusted host-loop process for the first migration, but run it in a renamed trusted service and load same-name sandbox portal tools into Pi. Add a Docker sandbox manager behind the portal so `bash`, `read`, `write`, `edit`, `ls`, `grep`, and `find` execute in per-session sandbox containers instead of the trusted host-loop container. Keep the control plane as the operator API and lifecycle owner.

**Tech Stack:** Node.js ESM, Node built-in test runner, Docker Compose, Docker CLI subprocesses behind a manager interface, Pi extensions, current Beep control-plane state store, LCM, Hindsight.

---

## Scope Check

This plan implements the first local-dev/Oracle-compatible host-loop slice. It does not extract `AgentSupervisor` and `PiRpcSession` into new modules yet. That extraction is valuable, but doing it before sandbox isolation increases risk. The first slice changes the trust topology by making the long-running service trusted and making code execution happen in child sandbox containers.

## File Structure

- Restore from `codex/host-pi-sandbox-tool-portal`:
  - `runtime/src/sandbox-tool-protocol.mjs`: shared validation and result envelopes for same-name sandbox tools.
  - `runtime/src/sandbox-tool-executor.mjs`: sandbox-internal implementations of `bash`, `read`, `write`, `edit`, `ls`, `grep`, and `find`.
  - `runtime/pi-extensions/sandbox-tool-portal-runtime.mjs`: Pi tool schemas and portal HTTP client.
  - `runtime/pi-extensions/sandbox-tool-portal-extension.mjs`: Pi extension entrypoint.
  - Tests for the above.
- Create `runtime/bin/beep-sandbox-tool-runner`: executable Node runner used by `docker exec` inside sandbox containers.
- Create `docker/sandbox.Dockerfile`: untrusted code-execution image with runtime tool files.
- Create `runtime/src/docker-sandbox-manager.mjs`: trusted Docker manager used by the host-loop service.
- Modify `runtime/src/beep-runtime-api.mjs`: advertise host-loop mode, load the sandbox portal extension into Pi, and route `/internal/sandbox/tools/call` through the Docker sandbox manager.
- Modify `docker/compose.runtime-dev.yml`: add `beep-host-loop` trusted service and keep `beep-runtime-api` as a compatibility alias during migration.
- Modify `control-plane/src/config.mjs`: add configurable managed service name.
- Modify `control-plane/src/runtime-manager.mjs`: start/stop the configured trusted host-loop service.
- Modify docs and smoke scripts:
  - `runtime/README.md`
  - `docs/first-usable-backend-loop.md`
  - `scripts/smoke-test-host-loop-sandbox.sh`
  - `package.json`

## Task 1: Restore Same-Name Sandbox Tool Portal

**Files:**
- Create: `runtime/src/sandbox-tool-protocol.mjs`
- Create: `runtime/src/sandbox-tool-executor.mjs`
- Create: `runtime/pi-extensions/sandbox-tool-portal-runtime.mjs`
- Create: `runtime/pi-extensions/sandbox-tool-portal-extension.mjs`
- Test: `test/sandbox-tool-protocol.test.mjs`
- Test: `test/sandbox-tool-executor.test.mjs`
- Test: `test/sandbox-tool-portal-extension.test.mjs`

- [ ] **Step 1: Restore the tested portal files from the existing branch**

Run:

```bash
git restore --source=codex/host-pi-sandbox-tool-portal -- \
  runtime/src/sandbox-tool-protocol.mjs \
  runtime/src/sandbox-tool-executor.mjs \
  runtime/pi-extensions/sandbox-tool-portal-runtime.mjs \
  runtime/pi-extensions/sandbox-tool-portal-extension.mjs \
  test/sandbox-tool-protocol.test.mjs \
  test/sandbox-tool-executor.test.mjs \
  test/sandbox-tool-portal-extension.test.mjs
```

Expected: the seven files appear in `git status --short`. Existing uncommitted agent-settings changes stay untouched.

- [ ] **Step 2: Run restored pure tests**

Run:

```bash
node --test \
  test/sandbox-tool-protocol.test.mjs \
  test/sandbox-tool-executor.test.mjs \
  test/sandbox-tool-portal-extension.test.mjs
```

Expected: PASS. If failures mention model names, control-plane route names, or agent settings, inspect the current branch drift before editing.

- [ ] **Step 3: Verify the portal registers same-name tools**

Run:

```bash
rg -n 'name: "(bash|read|write|edit|ls|grep|find)"' runtime/pi-extensions/sandbox-tool-portal-runtime.mjs
```

Expected: one match for each same-name tool. There must be no model-facing names like `sandbox_bash`.

- [ ] **Step 4: Commit the restored portal**

Run:

```bash
git add \
  runtime/src/sandbox-tool-protocol.mjs \
  runtime/src/sandbox-tool-executor.mjs \
  runtime/pi-extensions/sandbox-tool-portal-runtime.mjs \
  runtime/pi-extensions/sandbox-tool-portal-extension.mjs \
  test/sandbox-tool-protocol.test.mjs \
  test/sandbox-tool-executor.test.mjs \
  test/sandbox-tool-portal-extension.test.mjs
git commit -m "feat: restore sandbox tool portal"
```

## Task 2: Add Sandbox Tool Runner Entrypoint

**Files:**
- Create: `runtime/bin/beep-sandbox-tool-runner`
- Test: `test/sandbox-tool-runner.test.mjs`

- [ ] **Step 1: Write the failing runner test**

Create `test/sandbox-tool-runner.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runRunner(payload, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["runtime/bin/beep-sandbox-tool-runner"], {
      cwd: new URL("..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BEEP_SANDBOX_WORKSPACE: cwd },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

test("sandbox tool runner executes one normalized request from stdin", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-runner-"));
  try {
    const result = await runRunner(
      {
        toolCallId: "call_write",
        toolName: "write",
        args: { path: "proof.txt", content: "runner-ok\n" },
      },
      { cwd: workspace },
    );

    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(readFileSync(join(workspace, "proof.txt"), "utf8"), "runner-ok\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("sandbox tool runner returns a nonzero exit for malformed input", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-runner-bad-"));
  try {
    const result = await runRunner({ toolName: "bash", args: {} }, { cwd: workspace });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /toolCallId is required/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/sandbox-tool-runner.test.mjs
```

Expected: FAIL with `Cannot find module` or `ENOENT` for `runtime/bin/beep-sandbox-tool-runner`.

- [ ] **Step 3: Create the runner**

Create `runtime/bin/beep-sandbox-tool-runner`:

```javascript
#!/usr/bin/env node
import { stdin, stdout, stderr, exit } from "node:process";
import { executeSandboxTool } from "../src/sandbox-tool-executor.mjs";
import { normalizeSandboxToolRequest } from "../src/sandbox-tool-protocol.mjs";

async function readStdin() {
  let input = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) input += chunk;
  return input;
}

try {
  const input = await readStdin();
  const body = JSON.parse(input || "{}");
  const request = normalizeSandboxToolRequest({
    ...body,
    cwd: body.cwd || process.env.BEEP_SANDBOX_WORKSPACE || "/workspace",
  });
  const result = await executeSandboxTool(request);
  stdout.write(`${JSON.stringify(result)}\n`);
  exit(result.ok ? 0 : 2);
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
```

- [ ] **Step 4: Make the runner executable and run the test**

Run:

```bash
chmod +x runtime/bin/beep-sandbox-tool-runner
node --test test/sandbox-tool-runner.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add runtime/bin/beep-sandbox-tool-runner test/sandbox-tool-runner.test.mjs
git commit -m "feat: add sandbox tool runner"
```

## Task 3: Add The Sandbox Image

**Files:**
- Create: `docker/sandbox.Dockerfile`
- Modify: `package.json`
- Test: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Add static assertions before the Dockerfile exists**

Append this test to `test/runtime-integration-static.test.mjs`:

```javascript
test("sandbox image copies the tool runner without credentials", () => {
  const dockerfile = readFileSync(new URL("../docker/sandbox.Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY runtime\/bin\/beep-sandbox-tool-runner/u);
  assert.match(dockerfile, /COPY runtime\/src\/sandbox-tool-/u);
  assert.match(dockerfile, /USER beep/u);
  assert.doesNotMatch(dockerfile, /CODEX_HOME|auth\.json|BEEP_RUNTIME_API_TOKEN|BEEP_CONTROL_PLANE_RUNTIME_TOKEN/u);
});
```

If `test/runtime-integration-static.test.mjs` does not currently import `readFileSync`, add this near the top:

```javascript
import { readFileSync } from "node:fs";
```

- [ ] **Step 2: Run the static test to verify it fails**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL with `ENOENT` for `docker/sandbox.Dockerfile`.

- [ ] **Step 3: Create the sandbox Dockerfile**

Create `docker/sandbox.Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV BEEP_SANDBOX_WORKSPACE=/workspace
ENV HOME=/home/beep
ENV TMPDIR=/tmp
ENV PATH=/runtime/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash beep

WORKDIR /runtime

COPY runtime/bin/beep-sandbox-tool-runner /runtime/bin/beep-sandbox-tool-runner
COPY runtime/src/sandbox-tool-executor.mjs /runtime/src/sandbox-tool-executor.mjs
COPY runtime/src/sandbox-tool-protocol.mjs /runtime/src/sandbox-tool-protocol.mjs

RUN chmod +x /runtime/bin/beep-sandbox-tool-runner \
  && mkdir -p /workspace \
  && chown -R beep:beep /runtime /workspace /home/beep

USER beep
WORKDIR /workspace

CMD ["sleep", "infinity"]
```

- [ ] **Step 4: Add an npm static test alias**

Modify `package.json` scripts so the object includes:

```json
"test:host-loop-static": "node --test test/sandbox-tool-protocol.test.mjs test/sandbox-tool-executor.test.mjs test/sandbox-tool-portal-extension.test.mjs test/sandbox-tool-runner.test.mjs test/runtime-integration-static.test.mjs"
```

Keep the existing scripts unchanged.

- [ ] **Step 5: Run static tests**

Run:

```bash
npm run test:host-loop-static
```

Expected: PASS.

- [ ] **Step 6: Build the local image**

Run:

```bash
docker build -f docker/sandbox.Dockerfile -t beep-sandbox:local .
```

Expected: PASS. This build is required before the live smoke can run; if Docker is not available, stop this task and report Docker availability as the blocker.

- [ ] **Step 7: Commit**

Run:

```bash
git add docker/sandbox.Dockerfile package.json test/runtime-integration-static.test.mjs
git commit -m "feat: add sandbox execution image"
```

## Task 4: Add Docker Sandbox Manager

**Files:**
- Create: `runtime/src/docker-sandbox-manager.mjs`
- Test: `test/docker-sandbox-manager.test.mjs`

- [ ] **Step 1: Write failing manager tests**

Create `test/docker-sandbox-manager.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSandboxManager } from "../runtime/src/docker-sandbox-manager.mjs";

function fakeRunner() {
  const calls = [];
  return {
    calls,
    async run(command, args, options = {}) {
      calls.push({ command, args, options });
      if (args[0] === "ps") return { stdout: "", stderr: "" };
      if (args[0] === "create") return { stdout: "container_1\n", stderr: "" };
      if (args[0] === "start") return { stdout: "container_1\n", stderr: "" };
      if (args[0] === "inspect") {
        return {
          stdout: JSON.stringify([{ Id: "container_1", State: { Running: true, Status: "running" } }]),
          stderr: "",
        };
      }
      if (args[0] === "exec") {
        return {
          stdout: JSON.stringify({
            ok: true,
            toolCallId: "call_1",
            content: [{ type: "text", text: "ok" }],
            details: {},
            diagnostics: {},
            isError: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  };
}

test("creates a labeled non-root sandbox with only the session workspace mounted", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-"));
  try {
    const runner = fakeRunner();
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      image: "beep-sandbox:local",
      runDocker: runner.run,
    });

    const sandbox = await manager.ensureSandbox("agent_beep");
    assert.equal(sandbox.sessionId, "agent_beep");
    assert.equal(sandbox.generation, 1);
    assert.equal(sandbox.containerId, "container_1");

    const create = runner.calls.find((call) => call.args[0] === "create");
    assert.ok(create);
    assert.ok(create.args.includes("--read-only"));
    assert.ok(create.args.includes("--network"));
    assert.ok(create.args.includes("none"));
    assert.ok(create.args.includes("--security-opt"));
    assert.ok(create.args.includes("no-new-privileges:true"));
    assert.ok(create.args.includes("--user"));
    assert.ok(create.args.includes("beep"));
    assert.ok(create.args.includes("--label"));
    assert.ok(create.args.includes("beep.sandbox.session=agent_beep"));
    assert.ok(create.args.includes("--mount"));
    assert.match(create.args.join(" "), /target=\/workspace/u);
    assert.doesNotMatch(create.args.join(" "), /codex|auth\.json|docker\.sock/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executes a normalized tool request in the active sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-exec-"));
  try {
    const runner = fakeRunner();
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      image: "beep-sandbox:local",
      runDocker: runner.run,
    });

    const result = await manager.executeTool("agent_beep", {
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "printf ok" },
      timeoutMs: 5000,
    });

    assert.equal(result.ok, true);
    const exec = runner.calls.find((call) => call.args[0] === "exec");
    assert.ok(exec);
    assert.ok(exec.args.includes("container_1"));
    assert.ok(exec.args.includes("beep-sandbox-tool-runner"));
    assert.match(exec.options.input, /"toolName":"bash"/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the manager test to verify it fails**

Run:

```bash
node --test test/docker-sandbox-manager.test.mjs
```

Expected: FAIL with module not found for `runtime/src/docker-sandbox-manager.mjs`.

- [ ] **Step 3: Implement the manager**

Create `runtime/src/docker-sandbox-manager.mjs`:

```javascript
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeSandboxToolRequest, sandboxToolErrorResult } from "./sandbox-tool-protocol.mjs";

function slug(value) {
  return String(value || "sandbox")
    .replace(/[^A-Za-z0-9_.-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "sandbox";
}

function defaultRunDocker(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else {
        const error = new Error(`${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`.trim());
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        rejectPromise(error);
      }
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function containerName(prefix, sessionId, generation) {
  return `${prefix}-${slug(sessionId)}-${generation}`;
}

export class DockerSandboxManager {
  constructor({
    workspaceRoot,
    image = process.env.BEEP_SANDBOX_IMAGE || "beep-sandbox:local",
    namePrefix = process.env.BEEP_SANDBOX_NAME_PREFIX || "beep-sandbox",
    memory = process.env.BEEP_SANDBOX_MEMORY || "1024m",
    cpus = process.env.BEEP_SANDBOX_CPUS || "2",
    pidsLimit = process.env.BEEP_SANDBOX_PIDS_LIMIT || "512",
    runDocker = defaultRunDocker,
  } = {}) {
    this.workspaceRoot = resolve(workspaceRoot || process.env.BEEP_SANDBOX_WORKSPACE_ROOT || "/workspace/sandboxes");
    this.image = image;
    this.namePrefix = namePrefix;
    this.memory = memory;
    this.cpus = cpus;
    this.pidsLimit = pidsLimit;
    this.runDocker = runDocker;
    this.leases = new Map();
  }

  workspaceFor(sessionId) {
    return join(this.workspaceRoot, slug(sessionId));
  }

  async ensureSandbox(sessionId) {
    const existing = this.leases.get(sessionId);
    if (existing && (await this.isRunning(existing.containerId))) return existing;
    const generation = Number(existing?.generation || 0) + 1;
    const workspacePath = this.workspaceFor(sessionId);
    await mkdir(workspacePath, { recursive: true });
    const name = containerName(this.namePrefix, sessionId, generation);
    const create = await this.runDocker("docker", [
      "create",
      "--name",
      name,
      "--label",
      "beep.sandbox=1",
      "--label",
      `beep.sandbox.session=${sessionId}`,
      "--label",
      `beep.sandbox.generation=${generation}`,
      "--read-only",
      "--tmpfs",
      "/tmp:size=256m,mode=1777",
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "ALL",
      "--user",
      "beep",
      "--network",
      "none",
      "--memory",
      this.memory,
      "--cpus",
      this.cpus,
      "--pids-limit",
      this.pidsLimit,
      "--mount",
      `type=bind,source=${workspacePath},target=/workspace`,
      this.image,
    ]);
    const containerId = create.stdout.trim();
    await this.runDocker("docker", ["start", containerId]);
    const lease = {
      sessionId,
      generation,
      containerId,
      name,
      workspacePath,
      status: "running",
      createdAt: new Date().toISOString(),
      lastHealthyAt: new Date().toISOString(),
      lastError: null,
    };
    this.leases.set(sessionId, lease);
    return lease;
  }

  async isRunning(containerId) {
    if (!containerId) return false;
    try {
      const result = await this.runDocker("docker", ["inspect", containerId]);
      const payload = JSON.parse(result.stdout);
      return Boolean(payload?.[0]?.State?.Running);
    } catch {
      return false;
    }
  }

  async executeTool(sessionId, input) {
    const lease = await this.ensureSandbox(sessionId);
    const request = normalizeSandboxToolRequest({
      ...input,
      cwd: "/workspace",
      sandboxGeneration: lease.generation,
    });
    try {
      const result = await this.runDocker(
        "docker",
        ["exec", "-i", lease.containerId, "beep-sandbox-tool-runner"],
        { input: `${JSON.stringify(request)}\n` },
      );
      lease.lastHealthyAt = new Date().toISOString();
      const parsed = JSON.parse(result.stdout);
      return {
        ...parsed,
        diagnostics: {
          ...(parsed.diagnostics || {}),
          sandbox: {
            sessionId,
            generation: lease.generation,
            containerId: lease.containerId,
          },
        },
      };
    } catch (error) {
      lease.status = "failed";
      lease.lastError = error instanceof Error ? error.message : String(error);
      return sandboxToolErrorResult({
        toolCallId: input.toolCallId,
        error: lease.lastError,
        details: { interrupted: true },
        diagnostics: {
          sandbox: {
            sessionId,
            generation: lease.generation,
            containerId: lease.containerId,
          },
        },
      });
    }
  }

  status(sessionId) {
    if (sessionId) return this.leases.get(sessionId) || null;
    return [...this.leases.values()];
  }

  async stopSandbox(sessionId) {
    const lease = this.leases.get(sessionId);
    if (!lease) return null;
    await this.runDocker("docker", ["rm", "-f", lease.containerId]).catch(() => {});
    lease.status = "stopped";
    lease.stoppedAt = new Date().toISOString();
    return lease;
  }
}
```

- [ ] **Step 4: Run the manager tests**

Run:

```bash
node --test test/docker-sandbox-manager.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add runtime/src/docker-sandbox-manager.mjs test/docker-sandbox-manager.test.mjs
git commit -m "feat: add docker sandbox manager"
```

## Task 5: Route Sandbox Tool Calls Through Docker Manager

**Files:**
- Modify: `runtime/src/beep-runtime-api.mjs`
- Test: `test/runtime-sandbox-tool-route.test.mjs`
- Test: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Restore route tests from the portal branch**

Run:

```bash
git restore --source=codex/host-pi-sandbox-tool-portal -- \
  test/runtime-sandbox-tool-route.test.mjs
```

Expected: `test/runtime-sandbox-tool-route.test.mjs` is restored. It should assert the presence of `POST /internal/sandbox/tools/call`.

- [ ] **Step 2: Add static assertions for Docker manager usage**

Append to `test/runtime-sandbox-tool-route.test.mjs`:

```javascript
test("runtime sandbox route uses DockerSandboxManager in host-loop mode", () => {
  assert.match(apiSource, /DockerSandboxManager/u);
  assert.match(apiSource, /BEEP_SANDBOX_TOOL_BACKEND/u);
  assert.match(apiSource, /defaultSandboxManager/u);
});
```

- [ ] **Step 3: Run route tests to verify they fail**

Run:

```bash
node --test test/runtime-sandbox-tool-route.test.mjs
```

Expected: FAIL until `runtime/src/beep-runtime-api.mjs` imports and wires the Docker manager.

- [ ] **Step 4: Wire imports and manager selection**

Modify the top of `runtime/src/beep-runtime-api.mjs` so the sandbox imports include:

```javascript
import { DockerSandboxManager } from "./docker-sandbox-manager.mjs";
import { executeSandboxTool } from "./sandbox-tool-executor.mjs";
import { normalizeSandboxToolRequest } from "./sandbox-tool-protocol.mjs";
```

Near the existing constants, add:

```javascript
const SANDBOX_TOOL_BACKEND = process.env.BEEP_SANDBOX_TOOL_BACKEND || "docker";
const SANDBOX_WORKSPACE_ROOT = process.env.BEEP_SANDBOX_WORKSPACE_ROOT || join(WORKSPACE_DIR, "sandboxes");
const defaultSandboxManager = new DockerSandboxManager({
  workspaceRoot: SANDBOX_WORKSPACE_ROOT,
});
```

- [ ] **Step 5: Replace the sandbox tool route body**

In `handleSandboxToolRoute`, replace the execution block with:

```javascript
const body = await readRequestJson(req);
const request = normalizeSandboxToolRequest({
  ...body,
  cwd: body.cwd || WORKSPACE_DIR,
});
const sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : agentSupervisor.sessionId;
const result =
  SANDBOX_TOOL_BACKEND === "local"
    ? await executeSandboxTool(request)
    : await defaultSandboxManager.executeTool(sessionId, request);
jsonResponse(res, result.ok ? 200 : 422, result);
```

Keep the existing `try/catch` and runtime API token authorization.

- [ ] **Step 6: Advertise sandbox backend in capabilities**

In `handleCapabilities`, update the `sandboxTools` object to include:

```javascript
backend: SANDBOX_TOOL_BACKEND,
workspaceRoot: SANDBOX_WORKSPACE_ROOT,
```

Expected object shape:

```javascript
sandboxTools: {
  enabled: true,
  backend: SANDBOX_TOOL_BACKEND,
  route: "POST /internal/sandbox/tools/call",
  tools: ["bash", "read", "write", "edit", "ls", "grep", "find"],
  auth: "runtime-api-token",
  workspaceDir: WORKSPACE_DIR,
  workspaceRoot: SANDBOX_WORKSPACE_ROOT,
},
```

- [ ] **Step 7: Run route and static tests**

Run:

```bash
node --test test/runtime-sandbox-tool-route.test.mjs test/runtime-integration-static.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add runtime/src/beep-runtime-api.mjs test/runtime-sandbox-tool-route.test.mjs test/runtime-integration-static.test.mjs
git commit -m "feat: route sandbox tools through docker manager"
```

## Task 6: Load Sandbox Portal Into The Trusted Pi Loop

**Files:**
- Modify: `runtime/src/beep-runtime-api.mjs`
- Test: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Add static tests for Pi extension loading**

Append to `test/runtime-integration-static.test.mjs`:

```javascript
test("trusted Pi loop can load the sandbox tool portal extension", () => {
  const source = readFileSync(new URL("../runtime/src/beep-runtime-api.mjs", import.meta.url), "utf8");
  assert.match(source, /SANDBOX_TOOL_PORTAL_EXTENSION_PATH/u);
  assert.match(source, /BEEP_SANDBOX_TOOL_PORTAL_ENABLED/u);
  assert.match(source, /--extension", SANDBOX_TOOL_PORTAL_EXTENSION_PATH/u);
  assert.match(source, /BEEP_SANDBOX_TOOL_PORTAL_URL/u);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL until the sandbox portal extension is wired into `PiRpcSession.spawn()`.

- [ ] **Step 3: Add sandbox portal constants**

In `runtime/src/beep-runtime-api.mjs`, near the control-plane tools constants, add:

```javascript
const SANDBOX_TOOL_PORTAL_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.BEEP_SANDBOX_TOOL_PORTAL_ENABLED || "1").toLowerCase(),
);
const SANDBOX_TOOL_PORTAL_EXTENSION_PATH =
  process.env.BEEP_SANDBOX_TOOL_PORTAL_EXTENSION_PATH || "/runtime/pi-extensions/sandbox-tool-portal-extension.mjs";
const SANDBOX_TOOL_PORTAL_URL =
  process.env.BEEP_SANDBOX_TOOL_PORTAL_URL || `http://127.0.0.1:${API_PORT}/internal/sandbox/tools/call`;
const SANDBOX_TOOL_PORTAL_TIMEOUT_MS = process.env.BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS || "60000";
```

- [ ] **Step 4: Pass sandbox portal env to Pi**

In `buildPiChildEnv`, add:

```javascript
BEEP_SANDBOX_TOOL_PORTAL_ENABLED: SANDBOX_TOOL_PORTAL_ENABLED ? "1" : "0",
BEEP_SANDBOX_TOOL_PORTAL_URL: SANDBOX_TOOL_PORTAL_URL,
BEEP_SANDBOX_TOOL_PORTAL_TOKEN: RUNTIME_API_TOKEN,
BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS: SANDBOX_TOOL_PORTAL_TIMEOUT_MS,
```

Keep the existing secret deletion block, but do not delete `BEEP_SANDBOX_TOOL_PORTAL_TOKEN` before the child starts. The extension deletes it from `process.env` after reading it.

- [ ] **Step 5: Add the extension to Pi args**

In `PiRpcSession.spawn()`, after the LCM extension block and before control-plane tools, add:

```javascript
const sandboxToolPortalExtensionLoaded =
  SANDBOX_TOOL_PORTAL_ENABLED && Boolean(RUNTIME_API_TOKEN) && existsSync(SANDBOX_TOOL_PORTAL_EXTENSION_PATH);
if (sandboxToolPortalExtensionLoaded) {
  args.push("--extension", SANDBOX_TOOL_PORTAL_EXTENSION_PATH);
}
```

In `run-config.json`, add:

```javascript
sandboxToolPortal: {
  enabled: SANDBOX_TOOL_PORTAL_ENABLED,
  extensionPath: SANDBOX_TOOL_PORTAL_EXTENSION_PATH,
  extensionLoaded: sandboxToolPortalExtensionLoaded,
  url: SANDBOX_TOOL_PORTAL_URL,
  timeoutMs: Number(SANDBOX_TOOL_PORTAL_TIMEOUT_MS),
},
```

Pass `sandboxToolPortalExtensionLoaded` into `buildPiChildEnv` by changing its signature to:

```javascript
function buildPiChildEnv(session, {
  lcmContextExtensionLoaded,
  controlPlaneToolsExtensionLoaded,
  sandboxToolPortalExtensionLoaded,
})
```

and set `BEEP_SANDBOX_TOOL_PORTAL_ENABLED` from the loaded flag:

```javascript
BEEP_SANDBOX_TOOL_PORTAL_ENABLED: sandboxToolPortalExtensionLoaded ? "1" : "0",
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:host-loop-static
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
git commit -m "feat: load sandbox portal in trusted pi loop"
```

## Task 7: Add Trusted Host-Loop Compose Service

**Files:**
- Modify: `docker/compose.runtime-dev.yml`
- Modify: `control-plane/src/config.mjs`
- Modify: `control-plane/src/runtime-manager.mjs`
- Test: `control-plane/test/runtime-manager.test.mjs`

- [ ] **Step 1: Add failing runtime-manager service-name test**

Append to `control-plane/test/runtime-manager.test.mjs`:

```javascript
test("runtime manager starts the configured trusted host-loop service", async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "beep-runtime-manager-service-test-"));
  const store = new StateStore(dir);
  const { createRuntimeHealthProof } = await import("../../runtime/src/runtime-api-auth.mjs");
  try {
    const manager = new RuntimeManager({
      store,
      runCommand: async (command, args) => {
        calls.push({ command, args });
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

    const up = calls.find((call) => call.args.includes("up"));
    assert.ok(up);
    assert.equal(up.args.at(-1), "beep-host-loop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --test control-plane/test/runtime-manager.test.mjs
```

Expected: FAIL because `RuntimeManager` does not accept or use `runtimeService`.

- [ ] **Step 3: Add runtime service config**

In `control-plane/src/config.mjs`, add:

```javascript
export const RUNTIME_COMPOSE_SERVICE = process.env.BEEP_RUNTIME_COMPOSE_SERVICE || "beep-host-loop";
```

- [ ] **Step 4: Inject service name and command runner into RuntimeManager**

Modify `control-plane/src/runtime-manager.mjs` imports to include:

```javascript
RUNTIME_COMPOSE_SERVICE,
```

Change the constructor to:

```javascript
constructor({
  store,
  runCommand = run,
  fetchRuntime: fetchRuntimeFn = fetchRuntime,
  challengeFactory = randomUUID,
  runtimeService = RUNTIME_COMPOSE_SERVICE,
} = {}) {
  this.store = store;
  this.runCommand = runCommand;
  this.fetchRuntime = fetchRuntimeFn;
  this.challengeFactory = challengeFactory;
  this.runtimeService = runtimeService;
}
```

Update internal calls:

```javascript
const challenge = this.challengeFactory();
const health = await this.fetchRuntime(runtimeHealthPath(challenge));
await this.runCommand("docker", composeArgs("-f", COMPOSE_FILE, "--profile", "api", "up", "--build", "-d", this.runtimeService), {
  env: composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }),
});
await this.runCommand("docker", composeArgs("-f", COMPOSE_FILE, "--profile", "api", "stop", this.runtimeService), {
  env: composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }),
});
```

- [ ] **Step 5: Add an environment anchor and Compose service**

In `docker/compose.runtime-dev.yml`, split the common environment into a named anchor. Replace the current `x-beep-runtime-common` header with this structure, keeping the same environment values currently present:

```yaml
x-beep-runtime-env: &beep-runtime-env
  BEEP_NO_API_KEY: "1"
  BEEP_STATE_DIR: /state
  BEEP_WORKSPACE_DIR: /workspace
  BEEP_LCM_DIR: /lcm
  BEEP_LCM_ROOT: /opt/lossless-claw
  BEEP_LCM_DB: /lcm/beep-lcm.sqlite
  BEEP_HINDSIGHT_ENABLED: "1"
  BEEP_HINDSIGHT_API_URL: http://hindsight:8888
  BEEP_HINDSIGHT_BANK_ID_PREFIX: beep
  BEEP_HINDSIGHT_DEPLOYMENT_ID: local
  BEEP_HINDSIGHT_USER_ID: default-user
  BEEP_HINDSIGHT_PROJECT_ID: beep2
  BEEP_HINDSIGHT_RECALL_BUDGET: high
  BEEP_HINDSIGHT_RECALL_MAX_TOKENS: "4096"
  BEEP_HINDSIGHT_RETAIN_ASYNC: "1"
  BEEP_RUNTIME_API_TOKEN: "${BEEP_RUNTIME_API_TOKEN:-}"
  BEEP_MODEL_GATEWAY_CREDENTIAL_URL: "${BEEP_MODEL_GATEWAY_CREDENTIAL_URL:-}"
  BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN: "${BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN:-}"
  BEEP_ALLOW_RUNTIME_CODEX_AUTH: "${BEEP_ALLOW_RUNTIME_CODEX_AUTH:-0}"
  BEEP_CONTROL_PLANE_URL: "${BEEP_CONTROL_PLANE_URL:-}"
  BEEP_CONTROL_PLANE_RUNTIME_ID: "${BEEP_CONTROL_PLANE_RUNTIME_ID:-local}"
  BEEP_CONTROL_PLANE_RUNTIME_TOKEN: "${BEEP_CONTROL_PLANE_RUNTIME_TOKEN:-}"
  BEEP_CONTROL_PLANE_TOOLS_ENABLED: "${BEEP_CONTROL_PLANE_TOOLS_ENABLED:-0}"
  CODEX_HOME: /state/codex
  HOME: /state/home
  XDG_CACHE_HOME: /state/xdg-cache
  XDG_CONFIG_HOME: /state/xdg-config
  NPM_CONFIG_CACHE: /state/npm-cache

x-beep-runtime-common: &beep-runtime-common
  build:
    context: ..
    dockerfile: docker/runtime.Dockerfile
  environment:
    <<: *beep-runtime-env
```

Leave the existing common `volumes`, `read_only`, `tmpfs`, and `security_opt` under `x-beep-runtime-common`.

Then add this service next to `beep-runtime-api`:

```yaml
  beep-host-loop:
    <<: *beep-runtime-common
    command: ["/runtime/bin/beep-agentd"]
    profiles:
      - api
    restart: unless-stopped
    environment:
      <<: *beep-runtime-env
      BEEP_SANDBOX_TOOL_BACKEND: docker
      BEEP_SANDBOX_TOOL_PORTAL_ENABLED: "1"
      BEEP_SANDBOX_IMAGE: "${BEEP_SANDBOX_IMAGE:-beep-sandbox:local}"
      BEEP_SANDBOX_WORKSPACE_ROOT: /workspace/sandboxes
    volumes:
      - ../vendor:/vendor:ro
      - ../.beep-dev/workspace:/workspace
      - ../.beep-dev/lcm:/lcm
      - ../.beep-dev/history:/history
      - ../.beep-dev/state:/state
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "127.0.0.1:8787:8787"
      - "127.0.0.1:13000-13099:3000-3099"
    depends_on:
      hindsight:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8787/health"]
      interval: 10s
      timeout: 3s
      retries: 6
```

Keep `beep-runtime-api` temporarily for compatibility, but it should no longer be the default service started by the control plane.

- [ ] **Step 6: Run tests and Compose config validation**

Run:

```bash
node --test control-plane/test/runtime-manager.test.mjs
docker compose -f docker/compose.runtime-dev.yml config >/tmp/beep-compose-host-loop.yml
```

Expected: Node test PASS and Compose config PASS. This validation requires Docker Compose because YAML syntax alone does not prove merge keys and service configuration are valid.

- [ ] **Step 7: Commit**

Run:

```bash
git add docker/compose.runtime-dev.yml control-plane/src/config.mjs control-plane/src/runtime-manager.mjs control-plane/test/runtime-manager.test.mjs
git commit -m "feat: add trusted host loop compose service"
```

## Task 8: Build The Sandbox Image Before Host-Loop Startup

**Files:**
- Modify: `control-plane/src/runtime-manager.mjs`
- Test: `control-plane/test/runtime-manager.test.mjs`

- [ ] **Step 1: Add failing test for sandbox image build**

Append to `control-plane/test/runtime-manager.test.mjs`:

```javascript
test("runtime manager builds the sandbox image before starting host loop", async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "beep-runtime-manager-image-test-"));
  const store = new StateStore(dir);
  const { createRuntimeHealthProof } = await import("../../runtime/src/runtime-api-auth.mjs");
  try {
    const manager = new RuntimeManager({
      store,
      runCommand: async (command, args) => {
        calls.push({ command, args });
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

    const buildIndex = calls.findIndex((call) => call.args.includes("build") && call.args.includes("docker/sandbox.Dockerfile"));
    const upIndex = calls.findIndex((call) => call.args.includes("up"));
    assert.notEqual(buildIndex, -1);
    assert.notEqual(upIndex, -1);
    assert.ok(buildIndex < upIndex);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run focused test to verify it fails**

Run:

```bash
node --test control-plane/test/runtime-manager.test.mjs
```

Expected: FAIL because no sandbox image build command is issued.

- [ ] **Step 3: Add sandbox image build config and method**

In `control-plane/src/config.mjs`, add:

```javascript
export const SANDBOX_IMAGE = process.env.BEEP_SANDBOX_IMAGE || "beep-sandbox:local";
export const SANDBOX_DOCKERFILE = process.env.BEEP_SANDBOX_DOCKERFILE || join(ROOT_DIR, "docker/sandbox.Dockerfile");
```

In `control-plane/src/runtime-manager.mjs`, import both constants and add this method:

```javascript
async ensureSandboxImage() {
  await this.runCommand("docker", ["build", "-f", SANDBOX_DOCKERFILE, "-t", SANDBOX_IMAGE, "."], {
    cwd: ROOT_DIR,
    env: process.env,
  });
}
```

Call it inside `ensureRuntime` immediately before the Compose `up` command:

```javascript
await this.ensureSandboxImage();
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test control-plane/test/runtime-manager.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add control-plane/src/config.mjs control-plane/src/runtime-manager.mjs control-plane/test/runtime-manager.test.mjs
git commit -m "feat: build sandbox image for host loop"
```

## Task 9: Surface Host-Loop And Sandbox Health

**Files:**
- Modify: `runtime/src/beep-runtime-api.mjs`
- Modify: `control-plane/src/backend-status.mjs`
- Test: `control-plane/test/backend-status.test.mjs`
- Test: `test/runtime-sandbox-tool-route.test.mjs`

- [ ] **Step 1: Add runtime health fields test**

Append to `test/runtime-sandbox-tool-route.test.mjs`:

```javascript
test("runtime capabilities expose sandbox manager status route details", () => {
  assert.match(apiSource, /sandboxTools/u);
  assert.match(apiSource, /backend: SANDBOX_TOOL_BACKEND/u);
  assert.match(apiSource, /workspaceRoot: SANDBOX_WORKSPACE_ROOT/u);
});
```

- [ ] **Step 2: Add backend status sandbox test**

In `control-plane/test/backend-status.test.mjs`, add a test using the existing temporary `StateStore` pattern:

```javascript
test("backend status includes sanitized sandbox telemetry when runtime reports it", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      toolBroker: { manifest: () => ({ tools: [] }) },
      runtimeManager: {
        status: async () => ({ running: true, health: { service: "beep-agentd" } }),
      },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") {
          return {
            ok: true,
            summary: {
              sessionId: "agent_beep",
              sandbox: {
                backend: "docker",
                active: [
                  {
                    sessionId: "agent_beep",
                    generation: 2,
                    status: "running",
                    workspacePath: "/workspace/sandboxes/agent_beep",
                  },
                ],
              },
            },
          };
        }
        if (path === "/agent/lcm/status") return { ok: true, lcm: { available: true } };
        return { ok: true };
      },
    });

    assert.equal(status.agent.summary.sandbox.backend, "docker");
    assert.equal(status.agent.summary.sandbox.active[0].generation, 2);
    assert.equal(status.agent.summary.sandbox.active[0].workspacePath, undefined);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 3: Run tests to verify failures**

Run:

```bash
node --test test/runtime-sandbox-tool-route.test.mjs control-plane/test/backend-status.test.mjs
```

Expected: FAIL until summary and sanitization include sandbox telemetry.

- [ ] **Step 4: Add sandbox telemetry to agent summary**

In `runtime/src/beep-runtime-api.mjs`, add to `AgentSupervisor.status()`:

```javascript
sandbox: {
  backend: SANDBOX_TOOL_BACKEND,
  active: defaultSandboxManager.status(),
},
```

In `PiRpcSession.writeSummary()`, add:

```javascript
sandbox: {
  backend: SANDBOX_TOOL_BACKEND,
  active: defaultSandboxManager.status(this.id),
},
```

- [ ] **Step 5: Sanitize sandbox telemetry in backend status**

In `control-plane/src/backend-status.mjs`, extend `safeAgentSummary` after the LCM block:

```javascript
if (isPlainObject(summary.sandbox)) {
  safe.sandbox = sanitizeOperationalObject(summary.sandbox);
}
```

The existing unsafe suffix filters remove path-like keys such as `workspacePath`.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test test/runtime-sandbox-tool-route.test.mjs control-plane/test/backend-status.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add runtime/src/beep-runtime-api.mjs control-plane/src/backend-status.mjs test/runtime-sandbox-tool-route.test.mjs control-plane/test/backend-status.test.mjs
git commit -m "feat: report host loop sandbox health"
```

## Task 10: Add Host-Loop Sandbox Smoke

**Files:**
- Create: `scripts/smoke-test-host-loop-sandbox.sh`
- Modify: `package.json`

- [ ] **Step 1: Create the smoke script**

Create `scripts/smoke-test-host-loop-sandbox.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${TMPDIR:-/tmp}/beep-host-loop-sandbox-smoke"
mkdir -p "$OUT_DIR"

export BEEP_RUNTIME_COMPOSE_SERVICE="${BEEP_RUNTIME_COMPOSE_SERVICE:-beep-host-loop}"
export BEEP_RUNTIME_AUTO_UPDATE="${BEEP_RUNTIME_AUTO_UPDATE:-0}"

"$ROOT_DIR/scripts/beep-control-plane.sh" start

operator_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" operator-token)"
runtime_api_token="$("$ROOT_DIR/scripts/beep-control-plane.sh" runtime-api-token)"

curl -fsS http://127.0.0.1:8788/api/backend/status \
  -H "authorization: Bearer $operator_token" \
  > "$OUT_DIR/status-before.json"

curl -fsS http://127.0.0.1:8787/internal/sandbox/tools/call \
  -H "authorization: Bearer $runtime_api_token" \
  -H "content-type: application/json" \
  -d '{"sessionId":"agent_beep","toolCallId":"smoke_write","toolName":"write","args":{"path":"proof.txt","content":"host-loop-sandbox-ok\n"},"timeoutMs":5000}' \
  > "$OUT_DIR/write.json"

grep -q host-loop-sandbox-ok "$OUT_DIR/write.json"

container_id="$(
  docker ps \
    --filter label=beep.sandbox.session=agent_beep \
    --format '{{.ID}}' \
    | head -n 1
)"

if [ -z "$container_id" ]; then
  echo "No sandbox container found for agent_beep" >&2
  exit 1
fi

docker kill "$container_id" >/dev/null

curl -fsS http://127.0.0.1:8788/api/backend/status \
  -H "authorization: Bearer $operator_token" \
  > "$OUT_DIR/status-after-kill.json"

grep -q '"ok":true' "$OUT_DIR/status-after-kill.json"

curl -fsS http://127.0.0.1:8787/internal/sandbox/tools/call \
  -H "authorization: Bearer $runtime_api_token" \
  -H "content-type: application/json" \
  -d '{"sessionId":"agent_beep","toolCallId":"smoke_read","toolName":"read","args":{"path":"proof.txt"},"timeoutMs":5000}' \
  > "$OUT_DIR/read-after-restart.json"

grep -q host-loop-sandbox-ok "$OUT_DIR/read-after-restart.json"

echo "host-loop sandbox smoke passed; outputs in $OUT_DIR"
```

- [ ] **Step 2: Make it executable and syntax-check it**

Run:

```bash
chmod +x scripts/smoke-test-host-loop-sandbox.sh
bash -n scripts/smoke-test-host-loop-sandbox.sh
```

Expected: PASS.

- [ ] **Step 3: Add npm script**

Modify `package.json` scripts to include:

```json
"test:host-loop": "npm run test:host-loop-static && bash -n scripts/smoke-test-host-loop-sandbox.sh"
```

- [ ] **Step 4: Run static host-loop test**

Run:

```bash
npm run test:host-loop
```

Expected: PASS. This does not run the live Docker smoke; it validates the script syntax.

- [ ] **Step 5: Run live smoke**

Run:

```bash
./scripts/smoke-test-host-loop-sandbox.sh
```

Expected: PASS. The key proof is that `/api/backend/status` still returns `ok: true` after the sandbox container is killed, and the next sandbox tool call succeeds in a new sandbox generation.

- [ ] **Step 6: Commit**

Run:

```bash
git add scripts/smoke-test-host-loop-sandbox.sh package.json
git commit -m "test: add host loop sandbox smoke"
```

## Task 11: Update Operator Documentation

**Files:**
- Modify: `docs/first-usable-backend-loop.md`
- Modify: `runtime/README.md`

- [ ] **Step 1: Update backend loop authority docs**

In `docs/first-usable-backend-loop.md`, replace the old authority sentence that says the runtime house owns the Pi loop with:

```markdown
- The trusted host-loop service owns `beep-agentd`, the Pi loop, request queue
  and events, LCM context assembly and ingest, Hindsight sidecar coordination,
  and Docker sandbox lifecycle.
- The sandbox containers own model-directed code execution and mutable workspace
  side effects only.
```

Add this paragraph under **Operational Notes**:

```markdown
The default local-dev runtime service is now `beep-host-loop`. It is still a
Docker container, but it is the trusted orchestrator container, not the
untrusted execution sandbox. Per-session sandbox containers are created
dynamically and are safe to restart without taking down the agent loop.
```

- [ ] **Step 2: Update runtime README**

In `runtime/README.md`, add a new section after **Local Control Plane**:

```markdown
### Containerized Host Loop

`beep-host-loop` is the trusted local-dev host-loop service. It runs the Beep
agent loop in Docker for local and Oracle parity, but model-directed work tools
execute in separate per-session sandbox containers through the sandbox tool
portal. Killing a sandbox container should not make `/health`,
`/agent/context`, or the control-plane backend status unavailable.

The trusted service has Docker authority and must be treated as host authority.
Sandbox containers must not receive model credentials, operator tokens, LCM
mounts, Hindsight mounts, or the Docker socket.
```

- [ ] **Step 3: Run doc/static tests**

Run:

```bash
npm run test:host-loop-static
bash -n scripts/smoke-test-host-loop-sandbox.sh
```

Expected: PASS.

- [ ] **Step 4: Commit**

Run:

```bash
git add docs/first-usable-backend-loop.md runtime/README.md
git commit -m "docs: describe containerized host loop"
```

## Task 12: Final Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run pure test suites**

Run:

```bash
npm run test:host-loop-static
npm run test:control-plane
npm test
```

Expected: PASS.

- [ ] **Step 2: Validate Compose**

Run:

```bash
docker compose -f docker/compose.runtime-dev.yml config >/tmp/beep-compose-host-loop.yml
```

Expected: PASS.

- [ ] **Step 3: Run live smoke**

Run:

```bash
./scripts/smoke-test-host-loop-sandbox.sh
```

Expected: PASS.

- [ ] **Step 4: Inspect dirty state**

Run:

```bash
git status --short
```

Expected: no uncommitted changes from this implementation. Pre-existing unrelated worktree edits should either be committed in their own prior commits or still clearly separated if they belonged to another active task.

- [ ] **Step 5: Record verification in final handoff**

Final handoff must include:

```text
Verified:
- npm run test:host-loop-static
- npm run test:control-plane
- npm test
- docker compose -f docker/compose.runtime-dev.yml config
- ./scripts/smoke-test-host-loop-sandbox.sh
```

If any command was skipped, state the exact command and the exact reason.
