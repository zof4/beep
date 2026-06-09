import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeSandboxToolRequest, sandboxToolErrorResult } from "./sandbox-tool-protocol.mjs";

export const SANDBOX_RUNNER_PATH = "/runtime/bin/beep-sandbox-tool-runner";

const DEFAULT_WORKSPACE_ROOT = "/workspace/sandboxes";
const DEFAULT_IMAGE = "beep-sandbox:local";
const DEFAULT_NAME_PREFIX = "beep-sandbox";
const DEFAULT_MEMORY = "1024m";
const DEFAULT_CPUS = "2";
const DEFAULT_PIDS_LIMIT = "512";

function stringOption(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function validateSessionId(value) {
  const sessionId = String(value ?? "").trim();
  if (!sessionId) {
    throw Object.assign(new Error("sessionId is required."), { status: 400 });
  }
  if (sessionId.length > 256) {
    throw Object.assign(new Error("sessionId must be 256 characters or fewer."), { status: 400 });
  }
  if (/[\u0000-\u001f\u007f]/u.test(sessionId)) {
    throw Object.assign(new Error("sessionId must not contain control characters."), { status: 400 });
  }
  return sessionId;
}

function slug(value, fallback = "sandbox", maxLength = 80) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_.-]/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

function isPathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function containedPath(root, child) {
  const candidate = resolve(root, child);
  if (!isPathInside(resolve(root), candidate)) {
    throw Object.assign(new Error(`Sandbox workspace escapes root: ${child}`), { status: 400 });
  }
  return candidate;
}

function containerName(prefix, sessionSlug, generation) {
  return `${slug(prefix, DEFAULT_NAME_PREFIX, 48)}-${sessionSlug}-${generation}`;
}

function firstOutputLine(stdout) {
  return String(stdout || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}

function parseJsonObject(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function defaultRunDocker(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      error.stdout = stdout;
      error.stderr = stderr;
      settle(rejectPromise, error);
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        settle(resolvePromise, { stdout, stderr, code, signal });
        return;
      }
      const suffix = stderr || stdout || signal || code;
      const error = new Error(`${command} ${args.join(" ")} failed: ${suffix}`.trim());
      error.stdout = stdout;
      error.stderr = stderr;
      error.code = code;
      error.signal = signal;
      settle(rejectPromise, error);
    });

    child.stdin.end(options.input ?? "");
  });
}

export class DockerSandboxManager {
  constructor({
    workspaceRoot = process.env.BEEP_SANDBOX_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
    image = process.env.BEEP_SANDBOX_IMAGE || DEFAULT_IMAGE,
    namePrefix = process.env.BEEP_SANDBOX_NAME_PREFIX || DEFAULT_NAME_PREFIX,
    memory = process.env.BEEP_SANDBOX_MEMORY || DEFAULT_MEMORY,
    cpus = process.env.BEEP_SANDBOX_CPUS || DEFAULT_CPUS,
    pidsLimit = process.env.BEEP_SANDBOX_PIDS_LIMIT || DEFAULT_PIDS_LIMIT,
    runDocker = defaultRunDocker,
  } = {}) {
    this.workspaceRoot = resolve(stringOption(workspaceRoot, DEFAULT_WORKSPACE_ROOT));
    this.image = stringOption(image, DEFAULT_IMAGE);
    this.namePrefix = stringOption(namePrefix, DEFAULT_NAME_PREFIX);
    this.memory = stringOption(memory, DEFAULT_MEMORY);
    this.cpus = stringOption(cpus, DEFAULT_CPUS);
    this.pidsLimit = stringOption(pidsLimit, DEFAULT_PIDS_LIMIT);
    this.runDocker = runDocker;
    this.leases = new Map();
  }

  workspaceFor(sessionId) {
    const normalizedSessionId = validateSessionId(sessionId);
    return containedPath(this.workspaceRoot, slug(normalizedSessionId));
  }

  sandboxDiagnostics(lease, overrides = {}) {
    return {
      sessionId: lease?.sessionId ?? overrides.sessionId ?? null,
      sessionSlug: lease?.sessionSlug ?? overrides.sessionSlug ?? null,
      generation: lease?.generation ?? overrides.generation ?? null,
      containerId: lease?.containerId ?? overrides.containerId ?? null,
      containerName: lease?.name ?? overrides.containerName ?? null,
      workspacePath: lease?.workspacePath ?? overrides.workspacePath ?? null,
      status: overrides.status ?? lease?.status ?? "unavailable",
      image: this.image,
      runnerPath: SANDBOX_RUNNER_PATH,
      network: "none",
      readOnlyRoot: true,
      resourceLimits: {
        memory: this.memory,
        cpus: this.cpus,
        pidsLimit: this.pidsLimit,
      },
      lastHealthyAt: lease?.lastHealthyAt ?? null,
      lastError: overrides.lastError ?? lease?.lastError ?? null,
    };
  }

  leaseSnapshot(lease) {
    if (!lease) return null;
    return {
      sessionId: lease.sessionId,
      sessionSlug: lease.sessionSlug,
      generation: lease.generation,
      containerId: lease.containerId,
      name: lease.name,
      workspacePath: lease.workspacePath,
      status: lease.status,
      createdAt: lease.createdAt,
      startedAt: lease.startedAt,
      stoppedAt: lease.stoppedAt ?? null,
      lastHealthyAt: lease.lastHealthyAt,
      lastError: lease.lastError,
      diagnostics: this.sandboxDiagnostics(lease),
    };
  }

  async ensureSandbox(sessionId) {
    const normalizedSessionId = validateSessionId(sessionId);
    const existing = this.leases.get(normalizedSessionId);
    if (existing) {
      const inspection = await this.inspectContainer(existing.containerId);
      if (inspection.running) {
        existing.status = inspection.status || "running";
        existing.lastHealthyAt = nowIso();
        existing.lastError = null;
        return existing;
      }
      existing.status = inspection.status || "missing";
      existing.lastError = inspection.error || `sandbox is ${existing.status}`;
    }

    const sessionSlug = slug(normalizedSessionId);
    const generation = Number(existing?.generation || 0) + 1;
    const workspacePath = containedPath(this.workspaceRoot, sessionSlug);
    await mkdir(workspacePath, { recursive: true });

    const name = containerName(this.namePrefix, sessionSlug, generation);
    const create = await this.runDocker("docker", [
      "create",
      "--name",
      name,
      "--label",
      "beep.sandbox=1",
      "--label",
      `beep.sandbox.session=${normalizedSessionId}`,
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
    const containerId = firstOutputLine(create.stdout);
    if (!containerId) {
      throw new Error("Docker did not return a sandbox container id.");
    }

    await this.runDocker("docker", ["start", containerId]);
    const timestamp = nowIso();
    const lease = {
      sessionId: normalizedSessionId,
      sessionSlug,
      generation,
      containerId,
      name,
      workspacePath,
      status: "running",
      createdAt: timestamp,
      startedAt: timestamp,
      lastHealthyAt: timestamp,
      lastError: null,
    };
    this.leases.set(normalizedSessionId, lease);
    return lease;
  }

  async inspectContainer(containerId) {
    if (!containerId) return { exists: false, running: false, status: "missing", error: "missing container id" };
    try {
      const result = await this.runDocker("docker", ["inspect", containerId]);
      const payload = JSON.parse(result.stdout);
      const state = payload?.[0]?.State || {};
      return {
        exists: true,
        running: Boolean(state.Running),
        status: String(state.Status || (state.Running ? "running" : "stopped")),
        containerId: payload?.[0]?.Id || containerId,
      };
    } catch (error) {
      return {
        exists: false,
        running: false,
        status: "missing",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async isRunning(containerId) {
    const inspection = await this.inspectContainer(containerId);
    return inspection.running;
  }

  enrichResultWithDiagnostics(result, lease, extraDiagnostics = {}) {
    return {
      ...result,
      diagnostics: {
        ...(result.diagnostics || {}),
        sandbox: {
          ...this.sandboxDiagnostics(lease),
          ...extraDiagnostics,
        },
      },
    };
  }

  async executeTool(sessionId, input = {}) {
    let normalizedSessionId = null;
    let lease = null;
    try {
      normalizedSessionId = validateSessionId(sessionId);
      lease = await this.ensureSandbox(normalizedSessionId);
      const request = normalizeSandboxToolRequest({
        ...input,
        cwd: "/workspace",
        sandboxGeneration: lease.generation,
      });
      const result = await this.runDocker(
        "docker",
        ["exec", "-i", lease.containerId, SANDBOX_RUNNER_PATH],
        { input: `${JSON.stringify(request)}\n` },
      );
      lease.status = "running";
      lease.lastHealthyAt = nowIso();
      lease.lastError = null;

      const parsed = parseJsonObject(result.stdout);
      if (!parsed) {
        throw new Error("Sandbox runner returned malformed JSON.");
      }
      return this.enrichResultWithDiagnostics(parsed, lease, { runnerExitCode: result.code ?? 0 });
    } catch (error) {
      const runnerResult = parseJsonObject(error?.stdout);
      if (lease && runnerResult) {
        lease.status = "running";
        lease.lastHealthyAt = nowIso();
        lease.lastError = null;
        return this.enrichResultWithDiagnostics(runnerResult, lease, {
          runnerExitCode: error?.code ?? null,
          runnerStderr: error?.stderr || "",
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      if (lease) {
        lease.status = "failed";
        lease.lastError = message;
      }
      return sandboxToolErrorResult({
        toolCallId: input?.toolCallId,
        error: message,
        details: { interrupted: true },
        diagnostics: {
          sandbox: this.sandboxDiagnostics(lease, {
            sessionId: normalizedSessionId,
            status: "failed",
            lastError: message,
          }),
        },
      });
    }
  }

  status(sessionId = null) {
    if (sessionId) {
      return this.leaseSnapshot(this.leases.get(validateSessionId(sessionId)));
    }
    return [...this.leases.values()].map((lease) => this.leaseSnapshot(lease));
  }

  async stopSandbox(sessionId) {
    const normalizedSessionId = validateSessionId(sessionId);
    const lease = this.leases.get(normalizedSessionId);
    if (!lease) return null;
    try {
      await this.runDocker("docker", ["rm", "-f", lease.containerId]);
    } catch (error) {
      lease.lastError = error instanceof Error ? error.message : String(error);
    }
    lease.status = "stopped";
    lease.stoppedAt = nowIso();
    return this.leaseSnapshot(lease);
  }
}
