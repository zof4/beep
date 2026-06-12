import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveCodexAccessToken } from "./codex-auth-for-pi.mjs";
import { DockerSandboxManager } from "./docker-sandbox-manager.mjs";
import { authorizeRuntimeApiRequest, createRuntimeHealthProof } from "./runtime-api-auth.mjs";
import { executeSandboxTool } from "./sandbox-tool-executor.mjs";
import { normalizeSandboxToolRequest } from "./sandbox-tool-protocol.mjs";
import {
  defaultLcmService,
  lcmSessionIdForRuntimeSession,
  lcmSessionKeyForRuntimeSession,
  writeLcmSummaryFile,
} from "./lcm-service.mjs";
import { defaultMemoryCoordinator } from "./memory-coordinator.mjs";

const STATE_DIR = process.env.BEEP_STATE_DIR || "/state";
const WORKSPACE_DIR = process.env.BEEP_WORKSPACE_DIR || "/workspace";
const CODEX_HOME = process.env.CODEX_HOME || join(STATE_DIR, "codex");
const PI_ROOT = process.env.BEEP_PI_ROOT || "/opt/pi";
const API_HOST = process.env.BEEP_RUNTIME_API_HOST || "0.0.0.0";
const API_PORT = Number.parseInt(process.env.BEEP_RUNTIME_API_PORT || "8787", 10);
const API_STATE_DIR = process.env.BEEP_RUNTIME_API_STATE_DIR || join(STATE_DIR, "api");
const API_SESSIONS_DIR = join(API_STATE_DIR, "sessions");
const API_AGENTS_DIR = join(API_STATE_DIR, "agents");
const API_WORKSPACE_DIR = process.env.BEEP_RUNTIME_API_WORKSPACE_DIR || join(WORKSPACE_DIR, "api-sessions");
const RUNTIME_STATE_PATH = process.env.BEEP_RUNTIME_STATE || join(STATE_DIR, "beep-runtime-state.json");
const DEFAULT_MODEL = process.env.BEEP_PI_CODEX_MODEL || "gpt-5.5";
const DEFAULT_THINKING = process.env.BEEP_PI_THINKING || "low";
const DEFAULT_AGENT_ID = process.env.BEEP_AGENT_ID || "beep";
const RUNTIME_API_TOKEN = process.env.BEEP_RUNTIME_API_TOKEN || "";
const AGENT_AUTOSTART = process.env.BEEP_AGENT_AUTOSTART !== "0" && process.env.BEEP_AGENT_AUTOSTART !== "false";
const LCM_CONTEXT_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_LCM_CONTEXT_ENABLED || "1").toLowerCase());
const LCM_CONTEXT_EXTENSION_PATH =
  process.env.BEEP_LCM_CONTEXT_EXTENSION_PATH || "/runtime/pi-extensions/lcm-context-extension.mjs";
const LCM_CONTEXT_URL = process.env.BEEP_LCM_CONTEXT_URL || `http://127.0.0.1:${API_PORT}/internal/lcm/context`;
const LCM_CONTEXT_TOKEN = process.env.BEEP_LCM_CONTEXT_TOKEN || randomUUID();
const LCM_CONTEXT_TOKEN_BUDGET = process.env.BEEP_LCM_CONTEXT_TOKEN_BUDGET || "128000";
const LCM_CONTEXT_TIMEOUT_MS = process.env.BEEP_LCM_CONTEXT_TIMEOUT_MS || "15000";
const CODEX_WEB_SEARCH_EXTENSION_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_CODEX_WEB_SEARCH_EXTENSION_ENABLED || "1").toLowerCase());
const CODEX_WEB_SEARCH_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_CODEX_WEB_SEARCH_ENABLED || "1").toLowerCase());
const CODEX_WEB_SEARCH_EXTENSION_PATH =
  process.env.BEEP_CODEX_WEB_SEARCH_EXTENSION_PATH || "/runtime/pi-extensions/codex-web-search-extension.mjs";
const CODEX_WEB_SEARCH_MODE = process.env.BEEP_CODEX_WEB_SEARCH_MODE || "live";
const CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS = [
  "BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS",
  "BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE",
  "BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_COUNTRY",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_REGION",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_CITY",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_TIMEZONE",
];
const CONTROL_PLANE_TOOLS_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_CONTROL_PLANE_TOOLS_ENABLED || "0").toLowerCase());
const CONTROL_PLANE_TOOLS_EXTENSION_PATH =
  process.env.BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH || "/runtime/pi-extensions/control-plane-tools-extension.mjs";
const CONTROL_PLANE_URL = process.env.BEEP_CONTROL_PLANE_URL || "";
const CONTROL_PLANE_RUNTIME_ID = process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || "local";
const CONTROL_PLANE_RUNTIME_TOKEN = process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN || "";
const CONTROL_PLANE_TOOL_TIMEOUT_MS = process.env.BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS || "15000";
const SANDBOX_TOOL_PORTAL_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_SANDBOX_TOOL_PORTAL_ENABLED || "1").toLowerCase());
const SANDBOX_TOOL_PORTAL_EXTENSION_PATH =
  process.env.BEEP_SANDBOX_TOOL_PORTAL_EXTENSION_PATH || "/runtime/pi-extensions/sandbox-tool-portal-extension.mjs";
const SANDBOX_TOOL_PORTAL_URL =
  process.env.BEEP_SANDBOX_TOOL_PORTAL_URL || `http://127.0.0.1:${API_PORT}/internal/sandbox/tools/call`;
const SANDBOX_TOOL_PORTAL_TIMEOUT_MS = process.env.BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS || "60000";
const SANDBOX_TOOL_BACKEND = process.env.BEEP_SANDBOX_TOOL_BACKEND || "docker";
const SANDBOX_LOCAL_BACKEND_ENABLED =
  ["1", "true", "yes", "on"].includes(String(process.env.BEEP_SANDBOX_LOCAL_BACKEND_ENABLED || "0").toLowerCase());
const SANDBOX_WORKSPACE_ROOT = process.env.BEEP_SANDBOX_WORKSPACE_ROOT || join(WORKSPACE_DIR, "sandboxes");
const SANDBOX_DOCKER_WORKSPACE_ROOT = process.env.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT || SANDBOX_WORKSPACE_ROOT;
const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RPC_TIMEOUT_MS = 60 * 1000;
const MAX_REQUEST_BYTES = Number.parseInt(process.env.BEEP_MAX_REQUEST_BYTES || `${8 * 1024 * 1024}`, 10);
const EVENT_MEMORY_LIMIT = 2_000;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const sessions = new Map();
const defaultSandboxManager = new DockerSandboxManager({
  workspaceRoot: SANDBOX_WORKSPACE_ROOT,
  dockerWorkspaceRoot: SANDBOX_DOCKER_WORKSPACE_ROOT,
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJsonFile(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      __readError: error instanceof Error ? error.message : String(error),
      __path: path,
    };
  }
}

function writeJsonFile(path, value, mode = 0o600) {
  ensureDir(dirname(path));
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, next, { mode });
  renameSync(tmpPath, path);
}

function safeRecordHindsightMemory(session, event) {
  if (!session) return null;
  try {
    return session.recordHindsightMemory(event);
  } catch (error) {
    return {
      ok: false,
      telemetryDropped: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function loadRuntimeConfig() {
  const state = readJsonFile(RUNTIME_STATE_PATH, {});
  return {
    provider: "openai-codex",
    model: state?.model || DEFAULT_MODEL,
    thinking: state?.thinking || DEFAULT_THINKING,
  };
}

function newSessionId(prefix = "sess") {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("T", "t").replace("Z", "z");
  return `${prefix}_${stamp}_${randomUUID().slice(0, 8)}`;
}

function newRequestId(prefix = "req") {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function readTextLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/u);
}

function listSessionFiles(sessionDir) {
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const path = join(sessionDir, name);
      const stats = statSync(path);
      return { name, path, modifiedAtMs: stats.mtimeMs };
    })
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
}

function parseJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return {
          type: "parse_error",
          line: index + 1,
          message: error instanceof Error ? error.message : String(error),
          raw: line,
        };
      }
    });
}

function listDirectory(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .map((name) => {
      const fullPath = join(path, name);
      const stats = statSync(fullPath);
      return {
        name,
        type: stats.isDirectory() ? "directory" : "file",
        bytes: stats.isFile() ? stats.size : null,
        modifiedAt: new Date(stats.mtimeMs).toISOString(),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "thinking") return part.thinking ? `[thinking] ${part.thinking}` : "[thinking]";
      if (part.type === "toolCall") return `[tool:${part.name || "unknown"}] ${JSON.stringify(part.arguments ?? {})}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeEvents(events) {
  const byType = {};
  let responses = 0;
  let failedResponses = 0;
  let parseErrors = 0;
  let finalAssistantText = null;
  let lastUsage = null;
  for (const event of events) {
    const type = event?.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
    if (type === "parse_error") parseErrors += 1;
    if (type === "response") {
      responses += 1;
      if (event.success === false) failedResponses += 1;
    }
    const message = event?.message;
    if ((type === "message_end" || type === "turn_end") && message?.role === "assistant") {
      finalAssistantText = textFromContent(message.content) || finalAssistantText;
      if (message.usage) lastUsage = message.usage;
    }
  }
  return {
    total: events.length,
    byType,
    responses,
    failedResponses,
    parseErrors,
    finalAssistantText,
    lastUsage,
  };
}

function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function textResponse(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function routeError(res, status, message, details = undefined) {
  jsonResponse(res, status, { ok: false, error: message, ...(details ? { details } : {}) });
}

async function readRequestJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`), {
      statusCode: 400,
    });
  }
}

function commandPath() {
  return {
    tsxBin: join(PI_ROOT, "node_modules/.bin/tsx"),
    piCli: join(PI_ROOT, "packages/coding-agent/src/cli.ts"),
  };
}

function validateRuntimeReady() {
  const { tsxBin, piCli } = commandPath();
  if (!existsSync(tsxBin)) {
    throw new Error(`Pi dependencies are not installed at ${tsxBin}. Rebuild the runtime image.`);
  }
  if (!existsSync(piCli)) {
    throw new Error(`Vendored Pi CLI source is missing at ${piCli}.`);
  }
}

function validateThinking(thinking) {
  if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking)) {
    throw new Error(`Invalid thinking level: ${thinking}`);
  }
}

function buildPiChildEnv(session, { lcmContextExtensionLoaded, codexWebSearchExtensionLoaded, controlPlaneToolsExtensionLoaded, sandboxToolPortalExtensionLoaded }) {
  const env = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || join(STATE_DIR, "home"),
    TMPDIR: process.env.TMPDIR || "/tmp",
    CODEX_HOME,
    BEEP_STATE_DIR: STATE_DIR,
    BEEP_WORKSPACE_DIR: WORKSPACE_DIR,
    PI_CODING_AGENT_DIR: join(session.rootDir, "pi-agent"),
    PI_CODING_AGENT_SESSION_DIR: session.sessionDir,
    BEEP_LCM_CONTEXT_ENABLED: lcmContextExtensionLoaded ? "1" : "0",
    BEEP_LCM_CONTEXT_URL: LCM_CONTEXT_URL,
    BEEP_LCM_CONTEXT_TOKEN: LCM_CONTEXT_TOKEN,
    BEEP_LCM_RUNTIME_SESSION_ID: session.id,
    BEEP_LCM_CONTEXT_TOKEN_BUDGET: LCM_CONTEXT_TOKEN_BUDGET,
    BEEP_LCM_CONTEXT_TIMEOUT_MS: LCM_CONTEXT_TIMEOUT_MS,
    BEEP_CODEX_WEB_SEARCH_ENABLED: codexWebSearchExtensionLoaded && CODEX_WEB_SEARCH_ENABLED ? "1" : "0",
    BEEP_CONTROL_PLANE_TOOLS_ENABLED: controlPlaneToolsExtensionLoaded ? "1" : "0",
    BEEP_SANDBOX_TOOL_PORTAL_ENABLED: sandboxToolPortalExtensionLoaded ? "1" : "0",
  };

  if (codexWebSearchExtensionLoaded) {
    env.BEEP_CODEX_WEB_SEARCH_MODE = CODEX_WEB_SEARCH_MODE;
    for (const key of CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }

  if (sandboxToolPortalExtensionLoaded) {
    env.BEEP_SANDBOX_TOOL_PORTAL_URL = SANDBOX_TOOL_PORTAL_URL;
    env.BEEP_SANDBOX_TOOL_PORTAL_TOKEN = RUNTIME_API_TOKEN;
    env.BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS = SANDBOX_TOOL_PORTAL_TIMEOUT_MS;
  }

  if (controlPlaneToolsExtensionLoaded) {
    env.BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH = CONTROL_PLANE_TOOLS_EXTENSION_PATH;
    env.BEEP_CONTROL_PLANE_URL = CONTROL_PLANE_URL;
    env.BEEP_CONTROL_PLANE_RUNTIME_ID = CONTROL_PLANE_RUNTIME_ID;
    env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN = CONTROL_PLANE_RUNTIME_TOKEN;
    env.BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS = CONTROL_PLANE_TOOL_TIMEOUT_MS;
  }

  delete env.BEEP_MODEL_GATEWAY_CREDENTIAL_URL;
  delete env.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN;
  delete env.BEEP_RUNTIME_API_TOKEN;
  delete env.BEEP_CONTROL_PLANE_OPERATOR_TOKEN;
  delete env.BEEP_OPERATOR_TOKEN;
  delete env.BEEP_MODEL_CREDENTIAL_TOKEN;
  delete env.BEEP_MODEL_GATEWAY_TOKEN;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete env[key];
  }
  return env;
}

class PiRpcSession {
  constructor({ id, model, thinking, rootDir, workspace, sessionDir, resumeLatest = false }) {
    this.id = id;
    this.model = model;
    this.thinking = thinking;
    this.rootDir = rootDir;
    this.workspace = workspace;
    this.sessionDir = sessionDir;
    this.resumeLatest = resumeLatest;
    this.eventsPath = join(rootDir, "events.jsonl");
    this.stdoutPath = join(rootDir, "stdout.log");
    this.stderrPath = join(rootDir, "stderr.log");
    this.statusPath = join(rootDir, "status.json");
    this.summaryPath = join(rootDir, "summary.json");
    this.lcmSummaryPath = join(rootDir, "lcm-summary.json");
    this.lcmContextInjectionPath = join(rootDir, "lcm-context-injection.json");
    this.hindsightMemoryPath = join(rootDir, "hindsight-memory.json");
    const existingEvents = parseJsonl(this.eventsPath);
    const existingSummary = summarizeEvents(existingEvents);
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.phase = "starting";
    this.exitCode = null;
    this.signal = null;
    this.pid = null;
    this.lastError = null;
    this.lastAssistantText = existingSummary.finalAssistantText;
    this.eventCount = existingEvents.length;
    this.agentEndCount = existingSummary.byType.agent_end || 0;
    this.recentEvents = [];
    this.pendingResponses = new Map();
    this.agentEndWaiters = [];
    this.closed = false;
    this.stdoutBuffer = "";
    this.stderrTail = "";
  }

  static async start(options = {}) {
    validateRuntimeReady();
    const runtimeConfig = loadRuntimeConfig();
    const model = String(options.model || runtimeConfig.model || DEFAULT_MODEL);
    const thinking = String(options.thinking || runtimeConfig.thinking || DEFAULT_THINKING);
    validateThinking(thinking);

    const id = options.id || newSessionId(options.prefix || "sess");
    const rootDir = join(API_SESSIONS_DIR, id);
    const workspace = resolve(join(API_WORKSPACE_DIR, id));
    const sessionDir = join(rootDir, "pi-sessions");
    ensureDir(rootDir);
    ensureDir(workspace);
    ensureDir(sessionDir);

    const session = new PiRpcSession({
      id,
      model,
      thinking,
      rootDir,
      workspace,
      sessionDir,
      resumeLatest: Boolean(options.resumeLatest),
    });
    await session.spawn();
    sessions.set(id, session);
    return session;
  }

  async spawn() {
    const accessToken = await resolveCodexAccessToken(CODEX_HOME, {
      provider: "openai-codex",
      model: this.model,
      runtimeSessionId: this.id,
    });
    const { tsxBin, piCli } = commandPath();
    const args = [
      piCli,
      "--provider",
      "openai-codex",
      "--model",
      this.model,
      "--thinking",
      this.thinking,
      "--api-key",
      accessToken,
      "--mode",
      "rpc",
      "--session-dir",
      this.sessionDir,
    ];
    const resumedFrom = this.resumeLatest ? listSessionFiles(this.sessionDir)[0]?.path || null : null;
    if (resumedFrom) {
      args.push("--continue");
    }
    const lcmContextExtensionLoaded = LCM_CONTEXT_ENABLED && existsSync(LCM_CONTEXT_EXTENSION_PATH);
    if (lcmContextExtensionLoaded) {
      args.push("--extension", LCM_CONTEXT_EXTENSION_PATH);
    }
    const codexWebSearchExtensionLoaded = CODEX_WEB_SEARCH_EXTENSION_ENABLED && existsSync(CODEX_WEB_SEARCH_EXTENSION_PATH);
    if (codexWebSearchExtensionLoaded) {
      args.push("--extension", CODEX_WEB_SEARCH_EXTENSION_PATH);
    }
    const sandboxToolPortalExtensionLoaded =
      SANDBOX_TOOL_PORTAL_ENABLED && Boolean(RUNTIME_API_TOKEN) && existsSync(SANDBOX_TOOL_PORTAL_EXTENSION_PATH);
    if (sandboxToolPortalExtensionLoaded) {
      args.push("--extension", SANDBOX_TOOL_PORTAL_EXTENSION_PATH);
    }
    const controlPlaneToolsExtensionLoaded =
      CONTROL_PLANE_TOOLS_ENABLED &&
      Boolean(CONTROL_PLANE_URL) &&
      Boolean(CONTROL_PLANE_RUNTIME_TOKEN) &&
      existsSync(CONTROL_PLANE_TOOLS_EXTENSION_PATH);
    if (controlPlaneToolsExtensionLoaded) {
      args.push("--extension", CONTROL_PLANE_TOOLS_EXTENSION_PATH);
    }

    writeJsonFile(join(this.rootDir, "run-config.json"), {
      schemaVersion: 1,
      id: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      workspace: this.workspace,
      sessionDir: this.sessionDir,
      piRoot: PI_ROOT,
      codexHome: CODEX_HOME,
      resumeLatest: this.resumeLatest,
      resumedFrom,
      lcmContext: {
        enabled: LCM_CONTEXT_ENABLED,
        extensionPath: LCM_CONTEXT_EXTENSION_PATH,
        extensionLoaded: lcmContextExtensionLoaded,
        url: LCM_CONTEXT_URL,
        tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
        timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
      },
      codexWebSearch: {
        enabled: CODEX_WEB_SEARCH_ENABLED,
        extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED,
        extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH,
        extensionLoaded: codexWebSearchExtensionLoaded,
        mode: CODEX_WEB_SEARCH_MODE,
        allowedDomainsConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
        contextSizeConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
        contentTypesConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
        userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS.some((key) => key.startsWith("BEEP_CODEX_WEB_SEARCH_LOCATION_") && Boolean(process.env[key])),
      },
      sandboxToolPortal: {
        enabled: SANDBOX_TOOL_PORTAL_ENABLED,
        extensionPath: SANDBOX_TOOL_PORTAL_EXTENSION_PATH,
        extensionLoaded: sandboxToolPortalExtensionLoaded,
        url: SANDBOX_TOOL_PORTAL_URL,
        timeoutMs: Number(SANDBOX_TOOL_PORTAL_TIMEOUT_MS),
      },
      controlPlaneTools: {
        enabled: CONTROL_PLANE_TOOLS_ENABLED,
        extensionPath: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
        extensionLoaded: controlPlaneToolsExtensionLoaded,
        url: CONTROL_PLANE_URL || null,
        runtimeId: CONTROL_PLANE_RUNTIME_ID,
        runtimeTokenConfigured: Boolean(CONTROL_PLANE_RUNTIME_TOKEN),
        timeoutMs: Number(CONTROL_PLANE_TOOL_TIMEOUT_MS),
      },
      createdAt: this.createdAt,
    });

    const env = buildPiChildEnv(this, {
      lcmContextExtensionLoaded,
      codexWebSearchExtensionLoaded,
      controlPlaneToolsExtensionLoaded,
      sandboxToolPortalExtensionLoaded,
    });

    this.stdoutStream = createWriteStream(this.stdoutPath, { flags: "a" });
    this.stderrStream = createWriteStream(this.stderrPath, { flags: "a" });
    this.eventsStream = createWriteStream(this.eventsPath, { flags: "a" });
    this.child = spawn(tsxBin, args, {
      cwd: this.workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid ?? null;
    this.phase = "running";
    this.updatedAt = nowIso();
    this.writeStatus();

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.phase = "failed";
      this.updatedAt = nowIso();
      this.writeStatus();
      this.rejectPending(error);
    });
    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.signal = signal;
      if (this.stdoutBuffer.trim()) {
        this.handleLine(this.stdoutBuffer.trim());
        this.stdoutBuffer = "";
      }
      this.phase = code === 0 ? "closed" : this.phase === "stopping" ? "closed" : "failed";
      this.updatedAt = nowIso();
      this.writeSummary();
      this.writeStatus();
      this.rejectPending(new Error(`Pi RPC session closed with code ${code ?? "null"} signal ${signal ?? "none"}.`));
      this.resolveAgentEndWaiters();
      this.stdoutStream?.end();
      this.stderrStream?.end();
      this.eventsStream?.end();
    });

    if (lcmContextExtensionLoaded) {
      try {
        const response = await this.send({ type: "set_auto_compaction", enabled: false }, DEFAULT_RPC_TIMEOUT_MS);
        this.recordLcmContextInjection({
          kind: "pi_auto_compaction",
          ok: response.success !== false,
          at: nowIso(),
          detail: "Pi native auto-compaction disabled so Beep LCM owns context assembly.",
        });
      } catch (error) {
        this.lastError = `Failed to disable Pi auto-compaction: ${error instanceof Error ? error.message : String(error)}`;
        this.recordLcmContextInjection({
          kind: "pi_auto_compaction",
          ok: false,
          at: nowIso(),
          error: this.lastError,
        });
      }
      this.writeStatus();
    }
  }

  handleStdout(chunk) {
    this.stdoutStream.write(chunk);
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  handleStderr(chunk) {
    this.stderrStream.write(chunk);
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
    this.updatedAt = nowIso();
    this.writeStatus();
  }

  handleLine(line) {
    this.eventsStream.write(`${line}\n`);
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      event = {
        type: "parse_error",
        message: error instanceof Error ? error.message : String(error),
        raw: line,
      };
    }

    this.eventCount += 1;
    this.recentEvents.push(event);
    if (this.recentEvents.length > EVENT_MEMORY_LIMIT) this.recentEvents.shift();

    if (event.type === "agent_start") {
      this.phase = "agent_running";
    } else if (event.type === "agent_end") {
      this.agentEndCount += 1;
      this.phase = "idle";
      this.resolveAgentEndWaiters();
      this.writeSummary();
    } else if (event.type === "turn_start") {
      this.phase = "turn_running";
    } else if (event.type === "turn_end") {
      this.phase = "turn_complete";
    }

    if ((event.type === "message_end" || event.type === "turn_end") && event.message?.role === "assistant") {
      this.lastAssistantText = textFromContent(event.message.content) || this.lastAssistantText;
    }

    if (event.type === "response" && event.id && this.pendingResponses.has(event.id)) {
      const pending = this.pendingResponses.get(event.id);
      this.pendingResponses.delete(event.id);
      clearTimeout(pending.timeout);
      pending.resolve(event);
    }

    this.updatedAt = nowIso();
    this.writeStatus();
  }

  writeStatus() {
    writeJsonFile(this.statusPath, this.status());
  }

  writeSummary(extra = {}) {
    const events = parseJsonl(this.eventsPath);
    const summary = {
      ok: this.exitCode === null || this.exitCode === 0,
      sessionId: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      phase: this.phase,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      workspace: {
        path: this.workspace,
        entries: listDirectory(this.workspace),
      },
      events: {
        path: this.eventsPath,
        ...summarizeEvents(events),
      },
      lastAssistantText: this.lastAssistantText,
      lcm: readJsonFile(this.lcmSummaryPath, null),
      lcmContextInjection: this.readLcmContextInjection(),
      hindsightMemory: this.readHindsightMemory(),
      sandbox: {
        backend: SANDBOX_TOOL_BACKEND,
        active: defaultSandboxManager.status(this.id),
      },
      ...extra,
    };
    writeJsonFile(this.summaryPath, summary);
    return summary;
  }

  status() {
    return {
      id: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      phase: this.phase,
      pid: this.pid,
      closed: this.closed,
      exitCode: this.exitCode,
      signal: this.signal,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      workspace: this.workspace,
      rootDir: this.rootDir,
      sessionDir: this.sessionDir,
      eventsPath: this.eventsPath,
      summaryPath: this.summaryPath,
      lcmContextInjectionPath: this.lcmContextInjectionPath,
      lcmContextInjection: this.readLcmContextInjection(),
      hindsightMemoryPath: this.hindsightMemoryPath,
      hindsightMemory: this.readHindsightMemory(),
      eventCount: this.eventCount,
      agentEndCount: this.agentEndCount,
      pendingResponseCount: this.pendingResponses.size,
      lastAssistantText: this.lastAssistantText,
      lastError: this.lastError,
      stderrTail: this.stderrTail,
    };
  }

  readLcmContextInjection() {
    return readJsonFile(this.lcmContextInjectionPath, {
      schemaVersion: 1,
      enabled: LCM_CONTEXT_ENABLED,
      total: 0,
      failures: 0,
      history: [],
    });
  }

  recordLcmContextInjection(event) {
    const current = this.readLcmContextInjection();
    const history = Array.isArray(current.history) ? current.history : [];
    const nextEvent = {
      ...event,
      at: event.at || nowIso(),
    };
    const byKind = { ...(current.byKind && typeof current.byKind === "object" ? current.byKind : {}) };
    const kind = nextEvent.kind || "unknown";
    byKind[kind] = Number(byKind[kind] || 0) + 1;
    const next = {
      schemaVersion: 1,
      enabled: LCM_CONTEXT_ENABLED,
      extensionPath: LCM_CONTEXT_EXTENSION_PATH,
      total: Number(current.total || 0) + 1,
      byKind,
      failures: Number(current.failures || 0) + (nextEvent.ok === false ? 1 : 0),
      latest: nextEvent,
      history: [...history, nextEvent].slice(-50),
    };
    writeJsonFile(this.lcmContextInjectionPath, next);
    return next;
  }

  readHindsightMemory() {
    return readJsonFile(this.hindsightMemoryPath, {
      schemaVersion: 1,
      enabled: false,
      total: 0,
      failures: 0,
      history: [],
    });
  }

  recordHindsightMemory(event) {
    const current = this.readHindsightMemory();
    const history = Array.isArray(current.history) ? current.history : [];
    const nextEvent = {
      ...event,
      kind: event.kind || "unknown",
      at: event.at || nowIso(),
    };
    const byKind = { ...(current.byKind && typeof current.byKind === "object" ? current.byKind : {}) };
    const kind = nextEvent.kind || "unknown";
    byKind[kind] = Number(byKind[kind] || 0) + 1;
    const next = {
      schemaVersion: 1,
      enabled: Boolean(current.enabled || nextEvent.enabled),
      total: Number(current.total || 0) + 1,
      byKind,
      failures: Number(current.failures || 0) + (nextEvent.ok === false ? 1 : 0),
      latest: nextEvent,
      history: [...history, nextEvent].slice(-50),
    };
    writeJsonFile(this.hindsightMemoryPath, next);
    return next;
  }

  send(command, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    if (this.closed || !this.child || !this.child.stdin.writable) {
      throw new Error(`Pi RPC session ${this.id} is not running.`);
    }
    const id = command.id || `cmd_${randomUUID()}`;
    const rpcCommand = { ...command, id };
    const line = `${JSON.stringify(rpcCommand)}\n`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(id);
        rejectPromise(new Error(`Timed out waiting for Pi RPC response to ${rpcCommand.type}.`));
      }, timeoutMs);
      this.pendingResponses.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
      this.child.stdin.write(line, "utf8", (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pendingResponses.delete(id);
        rejectPromise(error);
      });
    });
  }

  async prompt(message, options = {}) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new Error("Prompt message is required.");
    }
    const waitForCompletion = Boolean(options.waitForCompletion);
    const timeoutMs = safeNumber(options.timeoutMs, DEFAULT_PROMPT_TIMEOUT_MS);
    const beforeAgentEndCount = this.agentEndCount;
    const response = await this.send(
      {
        type: "prompt",
        message,
        ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      },
      Math.min(timeoutMs, DEFAULT_RPC_TIMEOUT_MS),
    );
    if (response.success === false) {
      return { response, completed: false, finalText: this.lastAssistantText, summary: this.writeSummary() };
    }
    if (waitForCompletion) {
      await this.waitForAgentEndAfter(beforeAgentEndCount, timeoutMs);
    }
    let finalText = this.lastAssistantText;
    if (waitForCompletion) {
      const finalResponse = await this.send({ type: "get_last_assistant_text" });
      finalText = finalResponse?.data?.text || finalText;
      this.lastAssistantText = finalText;
    }
    return {
      response,
      completed: waitForCompletion ? this.agentEndCount > beforeAgentEndCount || this.closed : null,
      finalText,
      summary: this.writeSummary(),
    };
  }

  waitForAgentEndAfter(agentEndCount, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS) {
    if (this.agentEndCount > agentEndCount || this.closed) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.agentEndWaiters = this.agentEndWaiters.filter((waiter) => waiter.resolve !== resolvePromise);
        rejectPromise(new Error(`Timed out waiting for Pi agent completion in session ${this.id}.`));
      }, timeoutMs);
      this.agentEndWaiters.push({
        after: agentEndCount,
        resolve: () => {
          clearTimeout(timeout);
          resolvePromise();
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
    });
  }

  resolveAgentEndWaiters() {
    const remaining = [];
    for (const waiter of this.agentEndWaiters) {
      if (this.closed || this.agentEndCount > waiter.after) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.agentEndWaiters = remaining;
  }

  rejectPending(error) {
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingResponses.clear();
    for (const waiter of this.agentEndWaiters) {
      waiter.reject(error);
    }
    this.agentEndWaiters = [];
  }

  flushEvents() {
    if (!this.eventsStream || this.eventsStream.destroyed || this.eventsStream.closed) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.eventsStream.write("", (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  lcmIdentity() {
    return {
      sessionId: lcmSessionIdForRuntimeSession(this.id),
      sessionKey: lcmSessionKeyForRuntimeSession(this.id),
    };
  }

  async resolvePiSessionFile() {
    await this.flushEvents();
    const eventLineCount = readTextLines(this.eventsPath).map((line) => line.trim()).filter(Boolean).length;
    let sessionFile = null;
    let sessionStats = null;
    try {
      const statsResponse = await this.send({ type: "get_session_stats" });
      sessionStats = statsResponse?.data ?? null;
      sessionFile = typeof sessionStats?.sessionFile === "string" ? sessionStats.sessionFile : null;
    } catch {
      sessionStats = null;
    }
    if (!sessionFile) {
      sessionFile = listSessionFiles(this.sessionDir)[0]?.path || null;
    }
    if (!sessionFile) {
      throw new Error(`LCM operation failed: no Pi session file found in ${this.sessionDir}.`);
    }
    return { sessionFile, sessionStats, eventLineCount };
  }

  async recordLcm({ force = false } = {}) {
    const checkpointPath = join(this.rootDir, "lcm-checkpoint.json");
    const checkpoint = force ? { messageEntryCount: 0 } : readJsonFile(checkpointPath, { messageEntryCount: 0 });
    const { sessionFile, sessionStats, eventLineCount } = await this.resolvePiSessionFile();
    const fromMessageCount = Math.max(0, Number(checkpoint?.messageEntryCount || 0));
    const summary = await defaultLcmService.ingestPiSession({
      sessionPath: sessionFile,
      workspacePath: this.workspace,
      runtimeSessionId: this.id,
      proofDir: this.rootDir,
      fromMessageCount,
    });
    writeLcmSummaryFile(this.lcmSummaryPath, summary);
    writeJsonFile(checkpointPath, {
      messageEntryCount: Number(summary?.session?.nextMessageEntryCount ?? fromMessageCount),
      sessionFile,
      eventLineCount,
      updatedAt: nowIso(),
      latestSessionStats: sessionStats,
      latestSummary: summary,
    });
    return summary;
  }

  async stop() {
    if (this.closed) return this.status();
    this.phase = "stopping";
    this.updatedAt = nowIso();
    this.writeStatus();
    this.child.stdin.end();
    await new Promise((resolvePromise) => {
      const timeout = setTimeout(() => {
        if (!this.closed) this.child.kill("SIGTERM");
        resolvePromise();
      }, 2_000);
      this.child.once("close", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });
    return this.status();
  }
}

class AgentSupervisor {
  constructor({ id = DEFAULT_AGENT_ID } = {}) {
    this.id = id;
    this.rootDir = join(API_AGENTS_DIR, id);
    this.statePath = join(this.rootDir, "agent-state.json");
    this.sessionId = `agent_${id}`;
    this.session = null;
    this.starting = null;
    this.draining = false;
    this.waiters = new Map();
    ensureDir(this.rootDir);
    this.state = this.loadState();
    this.persistState();
  }

  defaultState() {
    return {
      schemaVersion: 1,
      id: this.id,
      sessionId: this.sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      paused: false,
      lastError: null,
      sequence: 0,
      activeRequestId: null,
      requests: {},
    };
  }

  loadState() {
    const existing = readJsonFile(this.statePath, null);
    const state = existing && !existing.__readError ? { ...this.defaultState(), ...existing } : this.defaultState();
    state.requests = state.requests && typeof state.requests === "object" ? state.requests : {};
    state.activeRequestId = null;
    for (const request of Object.values(state.requests)) {
      if (request.status === "running") {
        request.status = "interrupted";
        request.completedAt = nowIso();
        request.error = "Agent daemon restarted before this request completed.";
      }
    }
    state.updatedAt = nowIso();
    return state;
  }

  persistState() {
    this.state.updatedAt = nowIso();
    writeJsonFile(this.statePath, this.state);
  }

  async start() {
    if (this.session && !this.session.closed) return this.session;
    if (this.starting) return this.starting;
    this.starting = PiRpcSession.start({
      id: this.sessionId,
      resumeLatest: true,
    })
      .then((session) => {
        this.session = session;
        this.state.lastError = null;
        this.persistState();
        return session;
      })
      .catch((error) => {
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.persistState();
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  status() {
    const requests = Object.values(this.state.requests);
    const byStatus = {};
    for (const request of requests) {
      byStatus[request.status] = (byStatus[request.status] || 0) + 1;
    }
    return {
      id: this.id,
      statePath: this.statePath,
      paused: Boolean(this.state.paused),
      autostart: AGENT_AUTOSTART,
      activeRequestId: this.state.activeRequestId,
      queueDepth: this.queuedRequests().length,
      requests: {
        total: requests.length,
        byStatus,
        recent: requests
          .slice()
          .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
          .slice(0, 20)
          .map((request) => this.publicRequest(request)),
      },
      sandbox: {
        backend: SANDBOX_TOOL_BACKEND,
        active: defaultSandboxManager.status(),
      },
      session: this.session && !this.session.closed ? this.session.status() : readSessionStatus(this.sessionId),
      lastError: this.state.lastError,
      updatedAt: this.state.updatedAt,
    };
  }

  queuedRequests() {
    return Object.values(this.state.requests)
      .filter((request) => request.status === "queued")
      .sort((left, right) => left.sequence - right.sequence);
  }

  getRequest(id) {
    const request = this.state.requests[id];
    return request ? this.publicRequest(request) : null;
  }

  publicRequest(request) {
    return {
      id: request.id,
      sequence: request.sequence,
      status: request.status,
      createdAt: request.createdAt,
      startedAt: request.startedAt || null,
      completedAt: request.completedAt || null,
      message: request.message,
      finalText: request.finalText || null,
      error: request.error || null,
      memoryError: request.memoryError || null,
      lcm: request.lcm || null,
      hindsight: request.hindsight || null,
      promptResult: request.promptResult || null,
    };
  }

  enqueuePrompt({ message, timeoutMs, recordLcm = true, streamingBehavior = undefined } = {}) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw Object.assign(new Error("Agent submit requires a message or prompt string."), { statusCode: 400 });
    }
    this.state.sequence += 1;
    const request = {
      id: newRequestId("agent_req"),
      sequence: this.state.sequence,
      status: "queued",
      type: "prompt",
      message,
      timeoutMs: safeNumber(timeoutMs, DEFAULT_PROMPT_TIMEOUT_MS),
      recordLcm: recordLcm !== false,
      streamingBehavior,
      createdAt: nowIso(),
    };
    this.state.requests[request.id] = request;
    this.persistState();
    this.drainQueueSoon();
    return this.publicRequest(request);
  }

  drainQueueSoon() {
    setImmediate(() => {
      this.drainQueue().catch((error) => {
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.persistState();
      });
    });
  }

  async drainQueue() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.state.paused) {
        const request = this.queuedRequests()[0];
        if (!request) break;
        await this.runRequest(request);
      }
    } finally {
      this.draining = false;
    }
  }

  async runRequest(request) {
    request.status = "running";
    request.startedAt = nowIso();
    request.error = null;
    request.memoryError = null;
    this.state.activeRequestId = request.id;
    this.persistState();
    this.notifyRequest(request);

    try {
      const session = await this.start();
      const promptResult = await session.prompt(request.message, {
        waitForCompletion: true,
        timeoutMs: request.timeoutMs,
        streamingBehavior: request.streamingBehavior,
      });
      request.promptResult = {
        completed: promptResult.completed,
        finalText: promptResult.finalText,
        response: promptResult.response,
      };
      request.finalText = promptResult.finalText || null;
      if (request.recordLcm) {
        try {
          request.lcm = await session.recordLcm();
          request.hindsight = await defaultMemoryCoordinator.retainPiSessionSpan({
            runtimeSessionId: session.id,
            requestId: request.id,
            sessionPath: request.lcm.session.path,
            fromMessageEntry: request.lcm.session.fromMessageEntry,
            nextMessageEntryCount: request.lcm.session.nextMessageEntryCount,
            queuePath: join(session.rootDir, "hindsight-retain-queue.jsonl"),
          });
          safeRecordHindsightMemory(session, {
            kind: "hindsight_retain",
            ok: request.hindsight.ok,
            enabled: request.hindsight.enabled,
            requestId: request.id,
            bankId: request.hindsight.bankId || null,
            documentId: request.hindsight.documentId || null,
            queued: request.hindsight.queued === true,
            error: request.hindsight.error || null,
          });
        } catch (memoryError) {
          const memoryErrorMessage = memoryError instanceof Error ? memoryError.message : String(memoryError);
          request.memoryError = memoryErrorMessage;
          if (!request.lcm) {
            request.lcm = {
              ok: false,
              error: memoryErrorMessage,
            };
          } else if (!request.hindsight) {
            request.hindsight = {
              ok: false,
              error: memoryErrorMessage,
            };
          }
        }
      }
      request.status = "completed";
      request.completedAt = nowIso();
    } catch (error) {
      request.status = "failed";
      request.completedAt = nowIso();
      request.error = error instanceof Error ? error.message : String(error);
      this.state.lastError = request.error;
    } finally {
      if (this.state.activeRequestId === request.id) {
        this.state.activeRequestId = null;
      }
      this.persistState();
      this.notifyRequest(request);
    }
  }

  waitForRequest(id, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS) {
    const request = this.state.requests[id];
    if (!request) {
      throw Object.assign(new Error(`Unknown agent request: ${id}`), { statusCode: 404 });
    }
    if (["completed", "failed", "interrupted", "cancelled"].includes(request.status)) {
      return Promise.resolve(this.publicRequest(request));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(id, waiter);
        rejectPromise(new Error(`Timed out waiting for agent request ${id}.`));
      }, timeoutMs);
      const waiter = {
        resolve: (updated) => {
          clearTimeout(timeout);
          resolvePromise(this.publicRequest(updated));
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      };
      const waiters = this.waiters.get(id) || [];
      waiters.push(waiter);
      this.waiters.set(id, waiters);
    });
  }

  removeWaiter(id, waiter) {
    const waiters = this.waiters.get(id) || [];
    const next = waiters.filter((candidate) => candidate !== waiter);
    if (next.length > 0) this.waiters.set(id, next);
    else this.waiters.delete(id);
  }

  notifyRequest(request) {
    if (!["completed", "failed", "interrupted", "cancelled"].includes(request.status)) return;
    const waiters = this.waiters.get(request.id) || [];
    this.waiters.delete(request.id);
    for (const waiter of waiters) {
      waiter.resolve(request);
    }
  }

  pause() {
    this.state.paused = true;
    this.persistState();
    return this.status();
  }

  resume() {
    this.state.paused = false;
    this.persistState();
    this.drainQueueSoon();
    return this.status();
  }

  async steer(message) {
    const session = await this.start();
    return session.send({ type: "steer", message });
  }

  async followUp(message) {
    const session = await this.start();
    return session.send({ type: "follow_up", message });
  }

  async abort() {
    const session = await this.start();
    return session.send({ type: "abort" });
  }

  async recordLcm(options = {}) {
    const session = await this.start();
    const lcm = await session.recordLcm(options);
    return { lcm, summary: session.writeSummary() };
  }

  async lcmStatus() {
    const identity = {
      sessionId: lcmSessionIdForRuntimeSession(this.sessionId),
      sessionKey: lcmSessionKeyForRuntimeSession(this.sessionId),
    };
    return defaultLcmService.status(identity);
  }

  async currentLcmContext() {
    const session = await this.start();
    const resolved = await session.resolvePiSessionFile();
    return {
      session,
      ...resolved,
      ...session.lcmIdentity(),
    };
  }

  async compactLcm(options = {}) {
    const context = await this.currentLcmContext();
    return defaultLcmService.compact({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      sessionFile: context.sessionFile,
      tokenBudget: options.tokenBudget,
      currentTokenCount: options.currentTokenCount,
      compactionTarget: options.compactionTarget,
      force: Boolean(options.force),
      customInstructions: options.customInstructions,
    });
  }

  async assembleLcmPreview(options = {}) {
    const context = await this.currentLcmContext();
    return defaultLcmService.assemblePreview({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      sessionPath: context.sessionFile,
      tokenBudget: options.tokenBudget,
      prompt: options.prompt,
      includeMessages: options.includeMessages !== false,
    });
  }

  async maintainLcm(options = {}) {
    const context = await this.currentLcmContext();
    return defaultLcmService.maintain({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      sessionFile: context.sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: Boolean(options.allowDeferredCompactionExecution),
        ...(options.tokenBudget ? { tokenBudget: Number(options.tokenBudget) } : {}),
        ...(options.currentTokenCount ? { currentTokenCount: Number(options.currentTokenCount) } : {}),
      },
    });
  }

  async rotateLcm(options = {}) {
    const context = await this.currentLcmContext();
    return defaultLcmService.rotate({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      sessionFile: context.sessionFile,
      lockTimeoutMs: options.lockTimeoutMs,
    });
  }

  async backupLcm(options = {}) {
    return defaultLcmService.backup({
      label: options.label || "backup",
      replaceLatest: Boolean(options.replaceLatest),
    });
  }

  async doctorLcm() {
    const identity = {
      sessionId: lcmSessionIdForRuntimeSession(this.sessionId),
      sessionKey: lcmSessionKeyForRuntimeSession(this.sessionId),
    };
    return defaultLcmService.doctor(identity);
  }

  async stop() {
    if (this.session && !this.session.closed) {
      await this.session.stop();
    }
    return this.status();
  }
}

const agentSupervisor = new AgentSupervisor();

function getSession(id) {
  return sessions.get(id) || null;
}

function readSessionStatus(id) {
  const active = getSession(id);
  if (active) return active.status();
  const path = join(API_SESSIONS_DIR, id, "status.json");
  return readJsonFile(path, null);
}

function listSessionStatuses() {
  const seen = new Set();
  const active = [...sessions.values()].map((session) => {
    seen.add(session.id);
    return session.status();
  });
  const inactive = existsSync(API_SESSIONS_DIR)
    ? readdirSync(API_SESSIONS_DIR)
        .filter((id) => !seen.has(id))
        .map((id) => readSessionStatus(id))
        .filter(Boolean)
    : [];
  return [...active, ...inactive].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function handleHealth(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${API_HOST}:${API_PORT}`}`);
  const challenge = url.searchParams.get("challenge");
  const agent = agentSupervisor.status();
  const managedProof =
    challenge && RUNTIME_API_TOKEN
      ? createRuntimeHealthProof({ challenge, runtimeApiToken: RUNTIME_API_TOKEN })
      : null;
  jsonResponse(res, 200, {
    ok: true,
    service: "beep-agentd",
    runtimeId: CONTROL_PLANE_RUNTIME_ID,
    ...(managedProof ? { managedProof } : {}),
    time: nowIso(),
    agent: {
      id: agent.id,
      paused: agent.paused,
      queueDepth: agent.queueDepth,
      activeRequestId: agent.activeRequestId,
      sessionPhase: agent.session?.phase || null,
      lastError: agent.lastError,
    },
  });
}

async function handleCapabilities(_req, res) {
  const runtimeConfig = loadRuntimeConfig();
  jsonResponse(res, 200, {
    ok: true,
    schemaVersion: 1,
    runner: {
      harness: "pi",
      transport: "pi-rpc",
      provider: "openai-codex",
      auth: "chatgpt-codex-oauth",
      codexEndpoint: "https://chatgpt.com/backend-api/codex/responses",
    },
    daemon: {
      name: "beep-agentd",
      agentId: agentSupervisor.id,
      autostart: AGENT_AUTOSTART,
      role: "Long-running Beep agent supervisor inside the runtime container.",
    },
    lcmContext: {
      enabled: LCM_CONTEXT_ENABLED,
      extensionPath: LCM_CONTEXT_EXTENSION_PATH,
      tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
      timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
      route: "POST /internal/lcm/context",
    },
    codexWebSearch: {
      enabled: CODEX_WEB_SEARCH_ENABLED,
      extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED,
      extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH,
      mode: CODEX_WEB_SEARCH_MODE,
      allowedDomainsConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
      contextSizeConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
      contentTypesConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
      userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS.some((key) => key.startsWith("BEEP_CODEX_WEB_SEARCH_LOCATION_") && Boolean(process.env[key])),
    },
    controlPlaneTools: {
      enabled: CONTROL_PLANE_TOOLS_ENABLED,
      extensionPath: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
      url: CONTROL_PLANE_URL || null,
      runtimeId: CONTROL_PLANE_RUNTIME_ID,
      runtimeTokenConfigured: Boolean(CONTROL_PLANE_RUNTIME_TOKEN),
      timeoutMs: Number(CONTROL_PLANE_TOOL_TIMEOUT_MS),
      route: "POST /internal/tools/call",
    },
    sandboxTools: {
      enabled: true,
      backend: SANDBOX_TOOL_BACKEND,
      route: "POST /internal/sandbox/tools/call",
      tools: ["bash", "read", "write", "edit", "ls", "grep", "find"],
      auth: "runtime-api-token",
      localBackendEnabled: SANDBOX_LOCAL_BACKEND_ENABLED,
      workspaceRootConfigured: Boolean(process.env.BEEP_SANDBOX_WORKSPACE_ROOT),
      dockerWorkspaceRootConfigured: Boolean(process.env.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT),
    },
    current: runtimeConfig,
    paths: {
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      apiStateDir: API_STATE_DIR,
      apiSessionsDir: API_SESSIONS_DIR,
      apiWorkspaceDir: API_WORKSPACE_DIR,
      piRoot: PI_ROOT,
      codexHome: CODEX_HOME,
    },
    endpoints: [
      "GET /health",
      "GET /capabilities",
      "GET /agent",
      "POST /agent/start",
      "POST /agent/submit",
      "GET /agent/requests",
      "GET /agent/requests/:id",
      "GET /agent/events",
      "GET /agent/summary",
      "POST /agent/steer",
      "POST /agent/follow-up",
      "POST /agent/abort",
      "POST /agent/pause",
      "POST /agent/resume",
      "POST /agent/lcm",
      "GET /agent/lcm/status",
      "POST /agent/lcm/compact",
      "POST /agent/lcm/assemble-preview",
      "POST /agent/lcm/maintain",
      "POST /agent/lcm/rotate",
      "POST /agent/lcm/backup",
      "GET /agent/lcm/doctor",
      "POST /agent/stop",
      "GET /sessions",
      "POST /sessions",
      "GET /sessions/:id",
      "GET /sessions/:id/events",
      "GET /sessions/:id/summary",
      "POST /sessions/:id/prompt",
      "POST /sessions/:id/steer",
      "POST /sessions/:id/follow-up",
      "POST /sessions/:id/abort",
      "POST /sessions/:id/rpc",
      "POST /sessions/:id/lcm",
      "DELETE /sessions/:id",
      "POST /internal/sandbox/tools/call",
      "POST /runs",
    ],
    piRpcCommands: [
      "prompt",
      "steer",
      "follow_up",
      "abort",
      "get_state",
      "set_model",
      "get_available_models",
      "set_thinking_level",
      "compact",
      "set_auto_compaction",
      "bash",
      "get_session_stats",
      "get_messages",
      "get_last_assistant_text",
      "get_commands",
    ],
  });
}

async function handleCreateSession(req, res) {
  const body = await readRequestJson(req);
  const session = await PiRpcSession.start({
    model: body.model,
    thinking: body.thinking,
    prefix: body.prefix,
  });
  jsonResponse(res, 201, { ok: true, session: session.status() });
}

async function handleRun(req, res) {
  const body = await readRequestJson(req);
  const prompt = body.prompt || body.message;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    routeError(res, 400, "POST /runs requires a prompt string.");
    return;
  }
  const session = await PiRpcSession.start({
    model: body.model,
    thinking: body.thinking,
    prefix: body.prefix || "run",
  });
  let promptResult;
  let lcm = null;
  let hindsight = null;
  try {
    promptResult = await session.prompt(prompt, {
      waitForCompletion: true,
      timeoutMs: body.timeoutMs,
      streamingBehavior: body.streamingBehavior,
    });
    if (body.recordLcm !== false) {
      lcm = await session.recordLcm({ force: Boolean(body.forceLcm) });
      hindsight = await defaultMemoryCoordinator.retainPiSessionSpan({
        runtimeSessionId: session.id,
        requestId: session.id,
        sessionPath: lcm.session.path,
        fromMessageEntry: lcm.session.fromMessageEntry,
        nextMessageEntryCount: lcm.session.nextMessageEntryCount,
        queuePath: join(session.rootDir, "hindsight-retain-queue.jsonl"),
      });
      safeRecordHindsightMemory(session, {
        kind: "hindsight_retain",
        ok: hindsight.ok,
        enabled: hindsight.enabled,
        requestId: session.id,
        bankId: hindsight.bankId || null,
        documentId: hindsight.documentId || null,
        queued: hindsight.queued === true,
        error: hindsight.error || null,
      });
    }
  } finally {
    if (body.closeOnComplete !== false) {
      await session.stop();
      sessions.delete(session.id);
    }
  }
  jsonResponse(res, 200, {
    ok: true,
    runId: session.id,
    session: readSessionStatus(session.id) || session.status(),
    prompt: promptResult,
    lcm,
    hindsight,
  });
}

function sandboxRouteSessionId(value) {
  if (value === undefined || value === null || value === "") return agentSupervisor.sessionId;
  if (typeof value !== "string") {
    throw Object.assign(new Error("sessionId must be a string."), { status: 400 });
  }
  if (value.length > 256) {
    throw Object.assign(new Error("sessionId must be 256 characters or fewer."), { status: 400 });
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw Object.assign(new Error("sessionId must not contain control characters."), { status: 400 });
  }
  return value;
}

async function handleSandboxToolRoute(req, res) {
  try {
    const body = await readRequestJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw Object.assign(new Error("Sandbox tool request body must be an object."), { status: 400 });
    }
    const sessionId = sandboxRouteSessionId(body.sessionId);
    const request = normalizeSandboxToolRequest({
      ...body,
      cwd: SANDBOX_TOOL_BACKEND === "local" ? WORKSPACE_DIR : "/workspace",
    });
    let result;
    if (SANDBOX_TOOL_BACKEND === "local") {
      if (!SANDBOX_LOCAL_BACKEND_ENABLED) {
        throw Object.assign(new Error("Local sandbox tool backend is disabled."), { status: 503 });
      }
      result = await executeSandboxTool(request);
    } else {
      result = await defaultSandboxManager.executeTool(sessionId, request);
    }
    jsonResponse(res, result.ok ? 200 : 422, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error?.statusCode || error?.status || 500;
    routeError(res, status, message);
  }
}

function internalTokenAuthorized(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization === `Bearer ${LCM_CONTEXT_TOKEN}`;
}

async function handleInternalRoute(req, res, _url, parts) {
  const resource = parts[1] || "";
  const action = parts[2] || "";

  if (resource === "sandbox" && action === "tools" && parts[3] === "call" && parts.length === 4) {
    if (req.method !== "POST") {
      routeError(res, 405, "Unsupported method for POST /internal/sandbox/tools/call route.");
      return;
    }
    await handleSandboxToolRoute(req, res);
    return;
  }

  if (resource !== "lcm" || action !== "context") {
    routeError(res, 404, `Unknown internal route: ${req.method} /${parts.join("/")}`);
    return;
  }
  if (req.method !== "POST") {
    routeError(res, 405, "Unsupported method for internal LCM context route.");
    return;
  }
  if (!internalTokenAuthorized(req)) {
    routeError(res, 403, "Internal LCM context route requires runtime authorization.");
    return;
  }

  const startedAtMs = Date.now();
  const body = await readRequestJson(req);
  const runtimeSessionId = typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : "";
  if (!runtimeSessionId) {
    routeError(res, 400, "runtimeSessionId is required.");
    return;
  }
  if (!Array.isArray(body.messages)) {
    routeError(res, 400, "messages must be an array.");
    return;
  }

  const session = sessions.get(runtimeSessionId) || null;
  const sessionId = lcmSessionIdForRuntimeSession(runtimeSessionId);
  const sessionKey = lcmSessionKeyForRuntimeSession(runtimeSessionId);

  try {
    const memory = await defaultMemoryCoordinator.recallForContext({
      runtimeSessionId,
      prompt: body.prompt,
      messages: body.messages,
    });
    safeRecordHindsightMemory(session, {
      ...memory.telemetry,
      at: nowIso(),
      durationMs: Date.now() - startedAtMs,
      runtimeSessionId,
    });
    const result = await defaultLcmService.assembleMessages({
      sessionId,
      sessionKey,
      messages: body.messages,
      tokenBudget: body.tokenBudget,
      prompt: body.prompt,
      includeMessages: true,
      externalMemoryHints: memory.externalMemoryHints,
    });
    const assemble = result.assemble;
    const telemetry = {
      kind: "assemble",
      ok: true,
      at: nowIso(),
      durationMs: Date.now() - startedAtMs,
      runtimeSessionId,
      inputMessageCount: result.source.inputMessageCount,
      outputMessageCount: assemble.messageCount,
      estimatedTokens: assemble.estimatedTokens,
      contextProjection: assemble.contextProjection,
      tokenBudget: Number(body.tokenBudget || LCM_CONTEXT_TOKEN_BUDGET),
    };
    session?.recordLcmContextInjection(telemetry);
    jsonResponse(res, 200, {
      ok: true,
      messages: assemble.messages,
      context: {
        ...telemetry,
        lcmLogTail: result.lcmLogTail,
        hindsight: {
          ok: memory.ok,
          enabled: memory.enabled,
          error: memory.error || null,
          memoryCount: memory.externalMemoryHints?.memories?.length || 0,
          bankId: memory.externalMemoryHints?.bankId || null,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session?.recordLcmContextInjection({
      kind: "assemble",
      ok: false,
      at: nowIso(),
      durationMs: Date.now() - startedAtMs,
      runtimeSessionId,
      inputMessageCount: body.messages.length,
      error: message,
    });
    routeError(res, 500, message);
  }
}

async function handleAgentRoute(req, res, url, parts) {
  const action = parts[1] || "";
  const id = parts[2] || "";

  if (req.method === "GET" && action === "") {
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.status() });
    return;
  }

  if (req.method === "GET" && action === "requests" && !id) {
    const requests = Object.values(agentSupervisor.state.requests)
      .sort((left, right) => right.sequence - left.sequence)
      .map((request) => agentSupervisor.publicRequest(request));
    jsonResponse(res, 200, { ok: true, requests });
    return;
  }

  if (req.method === "GET" && action === "requests" && id) {
    const request = agentSupervisor.getRequest(id);
    if (!request) {
      routeError(res, 404, `Unknown agent request: ${id}`);
      return;
    }
    jsonResponse(res, 200, { ok: true, request });
    return;
  }

  if (req.method === "GET" && action === "events") {
    const status = readSessionStatus(agentSupervisor.sessionId);
    if (!status) {
      routeError(res, 404, "The Beep agent session has not started yet.");
      return;
    }
    const events = parseJsonl(status.eventsPath);
    const limit = safeNumber(url.searchParams.get("limit"), events.length);
    const selected = events.slice(Math.max(0, events.length - limit));
    if (url.searchParams.get("format") === "ndjson") {
      textResponse(res, 200, `${selected.map((event) => JSON.stringify(event)).join("\n")}\n`, {
        "content-type": "application/x-ndjson; charset=utf-8",
      });
      return;
    }
    jsonResponse(res, 200, { ok: true, sessionId: agentSupervisor.sessionId, total: events.length, events: selected });
    return;
  }

  if (req.method === "GET" && action === "summary") {
    if (agentSupervisor.session && !agentSupervisor.session.closed) {
      jsonResponse(res, 200, { ok: true, summary: agentSupervisor.session.writeSummary() });
      return;
    }
    const summary = readJsonFile(join(API_SESSIONS_DIR, agentSupervisor.sessionId, "summary.json"), null);
    if (!summary) {
      routeError(res, 404, "The Beep agent session has no summary yet.");
      return;
    }
    jsonResponse(res, 200, { ok: true, summary });
    return;
  }

  if (action === "lcm" && id) {
    if (req.method === "GET" && id === "status") {
      jsonResponse(res, 200, { ok: true, lcm: await agentSupervisor.lcmStatus() });
      return;
    }
    if (req.method === "GET" && id === "doctor") {
      jsonResponse(res, 200, { ok: true, doctor: await agentSupervisor.doctorLcm() });
      return;
    }
    if (req.method !== "POST") {
      routeError(res, 405, "Unsupported method for agent LCM route.");
      return;
    }
    const body = await readRequestJson(req);
    if (id === "compact") {
      const compact = await agentSupervisor.compactLcm(body);
      jsonResponse(res, compact.ok ? 200 : 409, { ok: compact.ok, compact });
      return;
    }
    if (id === "assemble-preview") {
      jsonResponse(res, 200, { ok: true, preview: await agentSupervisor.assembleLcmPreview(body) });
      return;
    }
    if (id === "maintain") {
      jsonResponse(res, 200, { ok: true, maintain: await agentSupervisor.maintainLcm(body) });
      return;
    }
    if (id === "rotate") {
      const rotate = await agentSupervisor.rotateLcm(body);
      jsonResponse(res, rotate.ok ? 200 : 409, { ok: rotate.ok, rotate });
      return;
    }
    if (id === "backup") {
      const backup = await agentSupervisor.backupLcm(body);
      jsonResponse(res, backup.ok ? 200 : 500, { ok: backup.ok, backup });
      return;
    }
    routeError(res, 404, `Unknown agent LCM action: ${id}`);
    return;
  }

  if (req.method !== "POST") {
    routeError(res, 405, "Unsupported method for agent route.");
    return;
  }

  const body = await readRequestJson(req);

  if (action === "start") {
    const session = await agentSupervisor.start();
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.status(), session: session.status() });
    return;
  }

  if (action === "submit") {
    const request = agentSupervisor.enqueuePrompt({
      message: body.message || body.prompt,
      timeoutMs: body.timeoutMs,
      recordLcm: body.recordLcm,
      streamingBehavior: body.streamingBehavior,
    });
    if (body.waitForCompletion) {
      const completed = await agentSupervisor.waitForRequest(request.id, body.timeoutMs);
      jsonResponse(res, completed.status === "completed" ? 200 : 500, {
        ok: completed.status === "completed",
        request: completed,
        agent: agentSupervisor.status(),
      });
      return;
    }
    jsonResponse(res, 202, { ok: true, request, agent: agentSupervisor.status() });
    return;
  }

  if (action === "pause") {
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.pause() });
    return;
  }

  if (action === "resume") {
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.resume() });
    return;
  }

  if (action === "steer") {
    const response = await agentSupervisor.steer(body.message || body.prompt);
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "follow-up") {
    const response = await agentSupervisor.followUp(body.message || body.prompt);
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "abort") {
    const response = await agentSupervisor.abort();
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "lcm") {
    const result = await agentSupervisor.recordLcm({ force: Boolean(body.force) });
    jsonResponse(res, 200, { ok: true, ...result });
    return;
  }

  if (action === "stop") {
    jsonResponse(res, 200, { ok: true, agent: await agentSupervisor.stop() });
    return;
  }

  routeError(res, 404, `Unknown agent action: ${action}`);
}

async function handleSessionRoute(req, res, url, parts) {
  const id = parts[1];
  const action = parts[2] || "";
  if (!id) {
    routeError(res, 404, "Missing session id.");
    return;
  }

  if (req.method === "GET" && action === "") {
    const status = readSessionStatus(id);
    if (!status) {
      routeError(res, 404, `Unknown session: ${id}`);
      return;
    }
    jsonResponse(res, 200, { ok: true, session: status });
    return;
  }

  if (req.method === "GET" && action === "events") {
    const status = readSessionStatus(id);
    if (!status) {
      routeError(res, 404, `Unknown session: ${id}`);
      return;
    }
    const events = parseJsonl(status.eventsPath);
    const limit = safeNumber(url.searchParams.get("limit"), events.length);
    const selected = events.slice(Math.max(0, events.length - limit));
    if (url.searchParams.get("format") === "ndjson") {
      textResponse(res, 200, selected.map((event) => JSON.stringify(event)).join("\n") + "\n", {
        "content-type": "application/x-ndjson; charset=utf-8",
      });
      return;
    }
    jsonResponse(res, 200, { ok: true, sessionId: id, total: events.length, events: selected });
    return;
  }

  if (req.method === "GET" && action === "summary") {
    const active = getSession(id);
    if (active) {
      jsonResponse(res, 200, { ok: true, summary: active.writeSummary() });
      return;
    }
    const summary = readJsonFile(join(API_SESSIONS_DIR, id, "summary.json"), null);
    if (!summary) {
      routeError(res, 404, `No summary for session: ${id}`);
      return;
    }
    jsonResponse(res, 200, { ok: true, summary });
    return;
  }

  const session = getSession(id);
  if (!session) {
    routeError(res, 404, `Session is not active: ${id}`);
    return;
  }

  if (req.method === "DELETE" && action === "") {
    const status = await session.stop();
    sessions.delete(id);
    jsonResponse(res, 200, { ok: true, session: status });
    return;
  }

  if (req.method !== "POST") {
    routeError(res, 405, "Unsupported method for session route.");
    return;
  }

  const body = await readRequestJson(req);

  if (action === "prompt") {
    const result = await session.prompt(body.message || body.prompt, {
      waitForCompletion: Boolean(body.waitForCompletion),
      timeoutMs: body.timeoutMs,
      streamingBehavior: body.streamingBehavior,
    });
    jsonResponse(res, result.response?.success === false ? 422 : 200, { ok: result.response?.success !== false, result });
    return;
  }

  if (action === "steer") {
    const response = await session.send({ type: "steer", message: body.message, images: body.images });
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "follow-up") {
    const response = await session.send({ type: "follow_up", message: body.message, images: body.images });
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "abort") {
    const response = await session.send({ type: "abort" });
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "rpc") {
    const command = body.command || body;
    if (!command || typeof command.type !== "string") {
      routeError(res, 400, "POST /sessions/:id/rpc requires a command object with type.");
      return;
    }
    const response = await session.send(command, body.timeoutMs);
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "lcm") {
    const lcm = await session.recordLcm({ force: Boolean(body.force) });
    jsonResponse(res, 200, { ok: true, lcm, summary: session.writeSummary() });
    return;
  }

  routeError(res, 404, `Unknown session action: ${action}`);
}

async function dispatch(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${API_HOST}:${API_PORT}`}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    await handleHealth(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/capabilities") {
    await handleCapabilities(req, res);
    return;
  }

  const runtimeApiAuth = authorizeRuntimeApiRequest({
    pathname: url.pathname,
    authorization: req.headers.authorization,
    runtimeApiToken: RUNTIME_API_TOKEN,
  });
  if (!runtimeApiAuth.ok) {
    routeError(res, runtimeApiAuth.status, runtimeApiAuth.error);
    return;
  }

  if (url.pathname === "/sessions" && req.method === "GET") {
    jsonResponse(res, 200, { ok: true, sessions: listSessionStatuses() });
    return;
  }
  if (url.pathname === "/sessions" && req.method === "POST") {
    await handleCreateSession(req, res);
    return;
  }
  if (url.pathname === "/runs" && req.method === "POST") {
    await handleRun(req, res);
    return;
  }
  if (parts[0] === "internal") {
    await handleInternalRoute(req, res, url, parts);
    return;
  }
  if (parts[0] === "agent") {
    await handleAgentRoute(req, res, url, parts);
    return;
  }
  if (parts[0] === "sessions") {
    await handleSessionRoute(req, res, url, parts);
    return;
  }
  routeError(res, 404, `Unknown route: ${req.method} ${url.pathname}`);
}

async function main() {
  ensureDir(API_STATE_DIR);
  ensureDir(API_SESSIONS_DIR);
  ensureDir(API_AGENTS_DIR);
  ensureDir(API_WORKSPACE_DIR);
  validateRuntimeReady();

  if (AGENT_AUTOSTART) {
    agentSupervisor
      .start()
      .then(() => agentSupervisor.drainQueueSoon())
      .catch((error) => {
        agentSupervisor.state.lastError = error instanceof Error ? error.message : String(error);
        agentSupervisor.persistState();
      });
  }

  const server = createServer((req, res) => {
    dispatch(req, res).catch((error) => {
      const status = error?.statusCode || 500;
      routeError(res, status, error instanceof Error ? error.message : String(error));
    });
  });

  const shutdown = async () => {
    server.close();
    await agentSupervisor.stop().catch(() => {});
    await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
    await defaultLcmService.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  server.listen(API_PORT, API_HOST, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : API_PORT;
    console.log(
      JSON.stringify({
        ok: true,
        service: "beep-agentd",
        listening: `http://${API_HOST}:${port}`,
        agentId: agentSupervisor.id,
        agentAutostart: AGENT_AUTOSTART,
        stateDir: API_STATE_DIR,
        workspaceDir: API_WORKSPACE_DIR,
      }),
    );
  });
}

await main();
