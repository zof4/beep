import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyRuntimeHealthProof } from "../../runtime/src/runtime-api-auth.mjs";
import {
  COMPOSE_FILE,
  CONTAINER_BASE_URL,
  ROOT_DIR,
  RUNTIME_COMPOSE_SERVICE,
  RUNTIME_API_URL,
  RUNTIME_ID,
  RUNTIME_START_TIMEOUT_MS,
  RUNTIME_UPDATE_ENV_PATH,
  SANDBOX_DOCKER_WORKSPACE_ROOT,
} from "./config.mjs";

function nowIso() {
  return new Date().toISOString();
}

function runtimeUpdateEpoch() {
  if (process.env.BEEP_RUNTIME_UPDATE_EPOCH) return process.env.BEEP_RUNTIME_UPDATE_EPOCH;
  if (!existsSync(RUNTIME_UPDATE_ENV_PATH)) return "manual";
  const match = readFileSync(RUNTIME_UPDATE_ENV_PATH, "utf8").match(/^BEEP_RUNTIME_UPDATE_EPOCH=(.+)$/m);
  return match?.[1]?.trim() || "manual";
}

function dockerSocketGroupId(socketPath = process.env.BEEP_DOCKER_SOCKET_PATH || "/var/run/docker.sock") {
  if (process.env.BEEP_DOCKER_GROUP_ID) return process.env.BEEP_DOCKER_GROUP_ID;
  try {
    const gid = statSync(socketPath).gid;
    if (Number.isInteger(gid) && gid >= 0) return String(gid);
  } catch {}
  return "0";
}

function run(command, args, { cwd = ROOT_DIR, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} ${args.join(" ")} failed with exit code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function composeArgs(...args) {
  const envFile = join(ROOT_DIR, "docker/hindsight-image.env");
  return existsSync(envFile) ? ["compose", "--env-file", envFile, ...args] : ["compose", ...args];
}

function composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }) {
  return {
    ...process.env,
    BEEP_RUNTIME_UPDATE_EPOCH: runtimeUpdateEpoch(),
    BEEP_RUNTIME_DEV_ENDPOINTS: process.env.BEEP_CONTROL_PLANE_RUNTIME_DEV_ENDPOINTS || "0",
    BEEP_RUNTIME_DEV_PROOF_TOOLS: process.env.BEEP_CONTROL_PLANE_RUNTIME_DEV_PROOF_TOOLS || "0",
    BEEP_ALLOW_RUNTIME_CODEX_AUTH: "0",
    BEEP_RUNTIME_API_TOKEN: runtimeApiToken,
    BEEP_MODEL_GATEWAY_CREDENTIAL_URL: `${CONTAINER_BASE_URL}/internal/model/credential`,
    BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN: modelCredentialToken,
    BEEP_CONTROL_PLANE_URL: CONTAINER_BASE_URL,
    BEEP_CONTROL_PLANE_RUNTIME_ID: RUNTIME_ID,
    BEEP_CONTROL_PLANE_RUNTIME_TOKEN: runtimeToken,
    BEEP_CONTROL_PLANE_TOOLS_ENABLED: process.env.BEEP_CONTROL_PLANE_TOOLS_ENABLED || "0",
    BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT: SANDBOX_DOCKER_WORKSPACE_ROOT,
    BEEP_DOCKER_GROUP_ID: dockerSocketGroupId(),
  };
}

async function fetchRuntime(path, options = {}) {
  const response = await fetch(`${RUNTIME_API_URL}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || response.statusText);
    error.status = response.status;
    error.upstreamStatus = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function runtimeHealthPath(challenge) {
  return `/health?challenge=${encodeURIComponent(challenge)}`;
}

function assertManagedRuntimeHealth(health, { challenge, runtimeApiToken }) {
  if (health?.service !== "beep-agentd") {
    throw new Error("Runtime health did not match the expected managed runtime identity.");
  }
  if (health?.runtimeId !== RUNTIME_ID) {
    throw new Error("Runtime health did not match the expected managed runtime identity.");
  }
  if (
    !verifyRuntimeHealthProof({
      challenge,
      runtimeApiToken,
      proof: health?.managedProof,
    })
  ) {
    throw new Error("Runtime health did not prove the expected managed runtime identity.");
  }
}

export class RuntimeManager {
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

  async verifiedHealth() {
    const runtimeApiToken = this.store.ensureRuntimeApiToken();
    const challenge = this.challengeFactory();
    const health = await this.fetchRuntime(runtimeHealthPath(challenge));
    assertManagedRuntimeHealth(health, { challenge, runtimeApiToken });
    return health;
  }

  async status() {
    const state = this.store.readState();
    try {
      const health = await this.verifiedHealth();
      return {
        runtimeId: RUNTIME_ID,
        running: true,
        apiUrl: RUNTIME_API_URL,
        health,
        state: state.runtimes[RUNTIME_ID] || null,
      };
    } catch (error) {
      return {
        runtimeId: RUNTIME_ID,
        running: false,
        apiUrl: RUNTIME_API_URL,
        error: error instanceof Error ? error.message : String(error),
        state: state.runtimes[RUNTIME_ID] || null,
      };
    }
  }

  async ensureRuntime({ rebuild = false } = {}) {
    const current = await this.status();
    if (!rebuild && current.running) {
      if (current.state?.status !== "running") {
        this.store.upsertRuntime(RUNTIME_ID, {
          status: "running",
          apiUrl: RUNTIME_API_URL,
          adoptedAt: nowIso(),
        });
        return this.status();
      }
      return current;
    }

    const runtimeToken = this.store.ensureRuntimeToken();
    const runtimeApiToken = this.store.ensureRuntimeApiToken();
    const modelCredentialToken = this.store.ensureModelCredentialToken();
    this.store.upsertRuntime(RUNTIME_ID, {
      status: "starting",
      controlPlaneUrl: CONTAINER_BASE_URL,
      apiUrl: RUNTIME_API_URL,
      startedAt: nowIso(),
    });

    await this.runCommand(
      "docker",
      composeArgs("-f", COMPOSE_FILE, "--profile", "api", "up", "--build", "-d", this.runtimeService),
      {
        env: composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }),
      },
    );
    await this.waitUntilReady();

    this.store.upsertRuntime(RUNTIME_ID, {
      status: "running",
      apiUrl: RUNTIME_API_URL,
      readyAt: nowIso(),
    });
    return this.status();
  }

  async stopRuntime() {
    const runtimeToken = this.store.ensureRuntimeToken();
    const runtimeApiToken = this.store.ensureRuntimeApiToken();
    const modelCredentialToken = this.store.ensureModelCredentialToken();
    await this.runCommand("docker", composeArgs("-f", COMPOSE_FILE, "--profile", "api", "stop", this.runtimeService), {
      env: composeEnv({ runtimeToken, runtimeApiToken, modelCredentialToken }),
    });
    this.store.upsertRuntime(RUNTIME_ID, {
      status: "stopped",
      stoppedAt: nowIso(),
    });
    return this.status();
  }

  async waitUntilReady(timeoutMs = RUNTIME_START_TIMEOUT_MS) {
    const started = Date.now();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        await this.verifiedHealth();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error(`Runtime did not become healthy within ${timeoutMs}ms: ${lastError?.message || "no response"}`);
  }

  async proxyToRuntime(path, options = {}) {
    await this.verifiedHealth();
    const headers = {
      ...(options.headers || {}),
      authorization: `Bearer ${this.store.ensureRuntimeApiToken()}`,
    };
    return this.fetchRuntime(path, { ...options, headers });
  }
}
