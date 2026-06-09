import { createHash } from "node:crypto";
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
const DEFAULT_DOCKER_TIMEOUT_MS = 30_000;
const DEFAULT_DOCKER_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_GRACE_MS = 5_000;

function stringOption(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function positiveIntegerOption(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function sessionComponent(sessionId) {
  return `${slug(sessionId, "session", 48)}-${shortHash(sessionId)}`;
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

function isDockerNameConflict(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /Conflict\.|already in use|container name/i.test(text);
}

function nowIso() {
  return new Date().toISOString();
}

function boundedAppend(current, chunk, maxBytes) {
  if (current.truncated) return current;
  const nextChunk = String(chunk);
  const remaining = maxBytes - current.bytes;
  if (remaining <= 0) return { ...current, truncated: true };
  const chunkBytes = Buffer.byteLength(nextChunk);
  if (chunkBytes <= remaining) {
    return {
      text: current.text + nextChunk,
      bytes: current.bytes + chunkBytes,
      truncated: false,
    };
  }
  return {
    text: current.text + nextChunk.slice(0, remaining),
    bytes: maxBytes,
    truncated: true,
  };
}

export function defaultRunDocker(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutMs = positiveIntegerOption(options.timeoutMs, DEFAULT_DOCKER_TIMEOUT_MS);
    const maxOutputBytes = positiveIntegerOption(options.maxOutputBytes, DEFAULT_DOCKER_MAX_OUTPUT_BYTES);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutState = { text: "", bytes: 0, truncated: false };
    let stderrState = { text: "", bytes: 0, truncated: false };
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      callback(value);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutState = boundedAppend(stdoutState, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderrState = boundedAppend(stderrState, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      error.stdout = stdoutState.text;
      error.stderr = stderrState.text;
      error.stdoutTruncated = stdoutState.truncated;
      error.stderrTruncated = stderrState.truncated;
      settle(rejectPromise, error);
    });
    child.on("close", (code, signal) => {
      const stdout = stdoutState.text;
      const stderr = stderrState.text;
      if (timedOut) {
        const error = new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.stdoutTruncated = stdoutState.truncated;
        error.stderrTruncated = stderrState.truncated;
        error.code = code;
        error.signal = signal;
        error.timedOut = true;
        settle(rejectPromise, error);
        return;
      }
      if (code === 0) {
        settle(resolvePromise, {
          stdout,
          stderr,
          stdoutTruncated: stdoutState.truncated,
          stderrTruncated: stderrState.truncated,
          code,
          signal,
        });
        return;
      }
      const suffix = stderr || stdout || signal || code;
      const error = new Error(`${command} ${args.join(" ")} failed: ${suffix}`.trim());
      error.stdout = stdout;
      error.stderr = stderr;
      error.stdoutTruncated = stdoutState.truncated;
      error.stderrTruncated = stderrState.truncated;
      error.code = code;
      error.signal = signal;
      settle(rejectPromise, error);
    });
    child.stdin.on("error", (error) => {
      if (error?.code === "EPIPE") return;
      error.stdout = stdoutState.text;
      error.stderr = stderrState.text;
      settle(rejectPromise, error);
    });

    child.stdin.end(options.input ?? "");
  });
}

export class DockerSandboxManager {
  constructor({
    workspaceRoot = process.env.BEEP_SANDBOX_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
    dockerWorkspaceRoot = process.env.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT || workspaceRoot,
    image = process.env.BEEP_SANDBOX_IMAGE || DEFAULT_IMAGE,
    namePrefix = process.env.BEEP_SANDBOX_NAME_PREFIX || DEFAULT_NAME_PREFIX,
    memory = process.env.BEEP_SANDBOX_MEMORY || DEFAULT_MEMORY,
    cpus = process.env.BEEP_SANDBOX_CPUS || DEFAULT_CPUS,
    pidsLimit = process.env.BEEP_SANDBOX_PIDS_LIMIT || DEFAULT_PIDS_LIMIT,
    dockerTimeoutMs = process.env.BEEP_SANDBOX_DOCKER_TIMEOUT_MS || DEFAULT_DOCKER_TIMEOUT_MS,
    dockerMaxOutputBytes = process.env.BEEP_SANDBOX_DOCKER_MAX_OUTPUT_BYTES || DEFAULT_DOCKER_MAX_OUTPUT_BYTES,
    execTimeoutGraceMs = process.env.BEEP_SANDBOX_EXEC_TIMEOUT_GRACE_MS || DEFAULT_EXEC_TIMEOUT_GRACE_MS,
    runDocker = defaultRunDocker,
  } = {}) {
    this.workspaceRoot = resolve(stringOption(workspaceRoot, DEFAULT_WORKSPACE_ROOT));
    this.dockerWorkspaceRoot = resolve(stringOption(dockerWorkspaceRoot, this.workspaceRoot));
    this.image = stringOption(image, DEFAULT_IMAGE);
    this.namePrefix = stringOption(namePrefix, DEFAULT_NAME_PREFIX);
    this.memory = stringOption(memory, DEFAULT_MEMORY);
    this.cpus = stringOption(cpus, DEFAULT_CPUS);
    this.pidsLimit = stringOption(pidsLimit, DEFAULT_PIDS_LIMIT);
    this.dockerTimeoutMs = positiveIntegerOption(dockerTimeoutMs, DEFAULT_DOCKER_TIMEOUT_MS);
    this.dockerMaxOutputBytes = positiveIntegerOption(dockerMaxOutputBytes, DEFAULT_DOCKER_MAX_OUTPUT_BYTES);
    this.execTimeoutGraceMs = positiveIntegerOption(execTimeoutGraceMs, DEFAULT_EXEC_TIMEOUT_GRACE_MS);
    this.runDocker = runDocker;
    this.leases = new Map();
    this.inflight = new Map();
  }

  workspaceFor(sessionId) {
    const normalizedSessionId = validateSessionId(sessionId);
    return containedPath(this.workspaceRoot, sessionComponent(normalizedSessionId));
  }

  dockerWorkspaceFor(sessionId) {
    const normalizedSessionId = validateSessionId(sessionId);
    return containedPath(this.dockerWorkspaceRoot, sessionComponent(normalizedSessionId));
  }

  runDockerCommand(args, options = {}) {
    return this.runDocker("docker", args, {
      timeoutMs: this.dockerTimeoutMs,
      maxOutputBytes: this.dockerMaxOutputBytes,
      ...options,
    });
  }

  sandboxDiagnostics(lease, overrides = {}) {
    return {
      sessionId: lease?.sessionId ?? overrides.sessionId ?? null,
      sessionSlug: lease?.sessionSlug ?? overrides.sessionSlug ?? null,
      generation: lease?.generation ?? overrides.generation ?? null,
      containerId: lease?.containerId ?? overrides.containerId ?? null,
      containerName: lease?.name ?? overrides.containerName ?? null,
      workspacePath: lease?.workspacePath ?? overrides.workspacePath ?? null,
      dockerWorkspacePath: lease?.dockerWorkspacePath ?? overrides.dockerWorkspacePath ?? null,
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
      dockerTimeoutMs: this.dockerTimeoutMs,
      execTimeoutGraceMs: this.execTimeoutGraceMs,
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
      dockerWorkspacePath: lease.dockerWorkspacePath,
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
    const pending = this.inflight.get(normalizedSessionId);
    if (pending) return pending;

    const promise = this.ensureSandboxUnlocked(normalizedSessionId);
    this.inflight.set(normalizedSessionId, promise);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(normalizedSessionId) === promise) this.inflight.delete(normalizedSessionId);
    }
  }

  async ensureSandboxUnlocked(normalizedSessionId) {
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
      await this.removeContainer(existing.containerId);
    }

    const sessionSlug = sessionComponent(normalizedSessionId);
    const workspacePath = containedPath(this.workspaceRoot, sessionSlug);
    const dockerWorkspacePath = containedPath(this.dockerWorkspaceRoot, sessionSlug);
    await mkdir(workspacePath, { recursive: true });

    const discovered = await this.discoverSessionContainers(normalizedSessionId, sessionSlug, workspacePath, dockerWorkspacePath);
    const running = discovered
      .filter((lease) => lease.status === "running")
      .sort((left, right) => right.generation - left.generation)[0];
    if (running) {
      this.leases.set(normalizedSessionId, running);
      return running;
    }
    const recoveredStopped = await this.recoverDiscoveredLease(discovered);
    if (recoveredStopped) {
      this.leases.set(normalizedSessionId, recoveredStopped);
      return recoveredStopped;
    }
    await Promise.all(discovered.map((lease) => this.removeContainer(lease.containerId)));

    const generation = Math.max(Number(existing?.generation || 0), ...discovered.map((lease) => lease.generation), 0) + 1;
    const name = containerName(this.namePrefix, sessionSlug, generation);
    let containerId = null;
    let create = null;
    try {
      create = await this.runDockerCommand([
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
        `type=bind,source=${dockerWorkspacePath},target=/workspace`,
        this.image,
      ]);
    } catch (error) {
      if (isDockerNameConflict(error)) {
        const recovered = await this.recoverFromNameConflict(normalizedSessionId, sessionSlug, workspacePath, dockerWorkspacePath);
        if (recovered) {
          this.leases.set(normalizedSessionId, recovered);
          return recovered;
        }
      }
      throw error;
    }
    containerId = firstOutputLine(create.stdout);
    if (!containerId) {
      throw new Error("Docker did not return a sandbox container id.");
    }

    try {
      await this.runDockerCommand(["start", containerId]);
    } catch (error) {
      const inspection = await this.inspectContainer(containerId);
      if (inspection.running) {
        const timestamp = nowIso();
        const recoveredLease = {
          sessionId: normalizedSessionId,
          sessionSlug,
          generation,
          containerId: inspection.containerId || containerId,
          name: inspection.name || name,
          workspacePath,
          dockerWorkspacePath,
          status: inspection.status || "running",
          createdAt: timestamp,
          startedAt: timestamp,
          lastHealthyAt: timestamp,
          lastError: null,
        };
        this.leases.set(normalizedSessionId, recoveredLease);
        return recoveredLease;
      }
      await this.removeContainer(containerId);
      throw error;
    }
    const timestamp = nowIso();
    const lease = {
      sessionId: normalizedSessionId,
      sessionSlug,
      generation,
      containerId,
      name,
      workspacePath,
      dockerWorkspacePath,
      status: "running",
      createdAt: timestamp,
      startedAt: timestamp,
      lastHealthyAt: timestamp,
      lastError: null,
    };
    this.leases.set(normalizedSessionId, lease);
    return lease;
  }

  async discoverSessionContainers(sessionId, sessionSlug, workspacePath, dockerWorkspacePath) {
    try {
      const result = await this.runDockerCommand([
        "ps",
        "-aq",
        "--filter",
        "label=beep.sandbox=1",
        "--filter",
        `label=beep.sandbox.session=${sessionId}`,
      ]);
      const ids = String(result.stdout || "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
      const leases = [];
      for (const id of ids) {
        const inspection = await this.inspectContainer(id);
        const labels = inspection.labels || {};
        if (labels["beep.sandbox"] !== "1" || labels["beep.sandbox.session"] !== sessionId) continue;
        const generation = Number.parseInt(labels["beep.sandbox.generation"] || "0", 10);
        if (!Number.isInteger(generation) || generation <= 0) continue;
        const timestamp = nowIso();
        leases.push({
          sessionId,
          sessionSlug,
          generation,
          containerId: inspection.containerId || id,
          name: inspection.name || containerName(this.namePrefix, sessionSlug, generation),
          workspacePath,
          dockerWorkspacePath,
          status: inspection.running ? "running" : inspection.status || "stopped",
          createdAt: timestamp,
          startedAt: timestamp,
          lastHealthyAt: inspection.running ? timestamp : null,
          lastError: inspection.running ? null : inspection.error || null,
        });
      }
      return leases;
    } catch {
      return [];
    }
  }

  async recoverFromNameConflict(sessionId, sessionSlug, workspacePath, dockerWorkspacePath) {
    const discovered = await this.discoverSessionContainers(sessionId, sessionSlug, workspacePath, dockerWorkspacePath);
    const running = discovered
      .sort((left, right) => right.generation - left.generation)
      .find((lease) => lease.status === "running");
    if (running) return running;
    return this.recoverDiscoveredLease(discovered);
  }

  async recoverDiscoveredLease(discovered) {
    const stopped = discovered.sort((left, right) => right.generation - left.generation)[0];
    if (!stopped) return null;
    try {
      await this.runDockerCommand(["start", stopped.containerId]);
      stopped.status = "running";
      stopped.startedAt = nowIso();
      stopped.lastHealthyAt = stopped.startedAt;
      stopped.lastError = null;
      return stopped;
    } catch {
      const inspection = await this.inspectContainer(stopped.containerId);
      if (inspection.running) {
        stopped.status = inspection.status || "running";
        stopped.lastHealthyAt = nowIso();
        stopped.lastError = null;
        return stopped;
      }
      return null;
    }
  }

  async inspectContainer(containerId) {
    if (!containerId) return { exists: false, running: false, status: "missing", error: "missing container id" };
    try {
      const result = await this.runDockerCommand(["inspect", containerId]);
      const payload = JSON.parse(result.stdout);
      const container = payload?.[0] || {};
      const state = container.State || {};
      return {
        exists: true,
        running: Boolean(state.Running),
        status: String(state.Status || (state.Running ? "running" : "stopped")),
        containerId: container.Id || containerId,
        name: String(container.Name || "").replace(/^\/+/u, ""),
        labels: container.Config?.Labels || {},
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

  async removeContainer(containerId) {
    if (!containerId) return;
    try {
      await this.runDockerCommand(["rm", "-f", containerId]);
    } catch {
      // Best-effort cleanup should not mask the original lifecycle error.
    }
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
      const request = normalizeSandboxToolRequest({
        ...input,
        cwd: "/workspace",
      });
      lease = await this.ensureSandbox(normalizedSessionId);
      request.sandboxGeneration = lease.generation;
      const result = await this.runDocker(
        "docker",
        ["exec", "-i", lease.containerId, SANDBOX_RUNNER_PATH],
        {
          timeoutMs: request.timeoutMs + this.execTimeoutGraceMs,
          maxOutputBytes: this.dockerMaxOutputBytes,
          input: `${JSON.stringify(request)}\n`,
        },
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
    await this.removeContainer(lease.containerId);
    lease.status = "stopped";
    lease.stoppedAt = nowIso();
    return this.leaseSnapshot(lease);
  }
}
