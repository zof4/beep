import { randomUUID } from "node:crypto";
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
import { pathToFileURL } from "node:url";
import {
  defaultLcmService,
  lcmSessionIdForRuntimeSession,
  lcmSessionKeyForRuntimeSession,
  writeLcmSummaryFile,
} from "./lcm-service.mjs";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const EVENT_MEMORY_LIMIT = 2_000;
const EXTENSION_CONFIG_REGISTRY_KEY = "__BEEP_PI_EXTENSION_CONFIGS__";

let extensionEnvCriticalSection = Promise.resolve();

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

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "thinking") return part.thinking ? `[thinking] ${part.thinking}` : "[thinking]";
      if (part.type === "toolCall") return `[tool:${part.name || "unknown"}] ${JSON.stringify(part.arguments ?? {})}`;
      if (part.type === "image") return "[image]";
      if (part.type === "localImage") return `[image:${part.path || "local"}]`;
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

async function loadPiSdk(piRoot) {
  const codingAgentUrl = pathToFileURL(join(piRoot, "packages/coding-agent/dist/index.js")).href;
  const aiUrl = pathToFileURL(join(piRoot, "packages/ai/dist/index.js")).href;
  const codingAgent = await import(codingAgentUrl);
  const ai = await import(aiUrl);
  return { codingAgent, ai };
}

function extensionConfigRegistry() {
  if (!(globalThis[EXTENSION_CONFIG_REGISTRY_KEY] instanceof Map)) {
    Object.defineProperty(globalThis, EXTENSION_CONFIG_REGISTRY_KEY, {
      value: new Map(),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }
  return globalThis[EXTENSION_CONFIG_REGISTRY_KEY];
}

function registerExtensionConfig(id, config) {
  const registry = extensionConfigRegistry();
  registry.set(id, config);
  return () => {
    registry.delete(id);
  };
}

function normalizeExtensionConfig(config = {}) {
  return {
    STATE_DIR: config.STATE_DIR || "/state",
    WORKSPACE_DIR: config.WORKSPACE_DIR || "/workspace",
    CODEX_HOME: config.CODEX_HOME || "",
    RUNTIME_API_TOKEN: config.RUNTIME_API_TOKEN || "",
    LCM_CONTEXT_ENABLED: Boolean(config.LCM_CONTEXT_ENABLED),
    LCM_CONTEXT_EXTENSION_PATH: config.LCM_CONTEXT_EXTENSION_PATH || "/runtime/pi-extensions/lcm-context-extension.mjs",
    LCM_CONTEXT_URL: config.LCM_CONTEXT_URL || "",
    LCM_CONTEXT_TOKEN: config.LCM_CONTEXT_TOKEN || "",
    LCM_CONTEXT_TOKEN_BUDGET: config.LCM_CONTEXT_TOKEN_BUDGET || "128000",
    LCM_CONTEXT_TIMEOUT_MS: config.LCM_CONTEXT_TIMEOUT_MS || "15000",
    CODEX_WEB_SEARCH_EXTENSION_ENABLED: Boolean(config.CODEX_WEB_SEARCH_EXTENSION_ENABLED),
    CODEX_WEB_SEARCH_ENABLED: Boolean(config.CODEX_WEB_SEARCH_ENABLED),
    CODEX_WEB_SEARCH_EXTENSION_PATH:
      config.CODEX_WEB_SEARCH_EXTENSION_PATH || "/runtime/pi-extensions/codex-web-search-extension.mjs",
    CODEX_WEB_SEARCH_MODE: config.CODEX_WEB_SEARCH_MODE || "live",
    CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS: Array.isArray(config.CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS)
      ? config.CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS
      : [],
    CONTROL_PLANE_TOOLS_ENABLED: Boolean(config.CONTROL_PLANE_TOOLS_ENABLED),
    CONTROL_PLANE_TOOLS_EXTENSION_PATH:
      config.CONTROL_PLANE_TOOLS_EXTENSION_PATH || "/runtime/pi-extensions/control-plane-tools-extension.mjs",
    CONTROL_PLANE_URL: config.CONTROL_PLANE_URL || "",
    CONTROL_PLANE_RUNTIME_ID: config.CONTROL_PLANE_RUNTIME_ID || "local",
    CONTROL_PLANE_RUNTIME_TOKEN: config.CONTROL_PLANE_RUNTIME_TOKEN || "",
    CONTROL_PLANE_TOOL_TIMEOUT_MS: config.CONTROL_PLANE_TOOL_TIMEOUT_MS || "15000",
    SANDBOX_TOOL_PORTAL_ENABLED: Boolean(config.SANDBOX_TOOL_PORTAL_ENABLED),
    SANDBOX_TOOL_PORTAL_EXTENSION_PATH:
      config.SANDBOX_TOOL_PORTAL_EXTENSION_PATH || "/runtime/pi-extensions/sandbox-tool-portal-extension.mjs",
    SANDBOX_TOOL_PORTAL_URL: config.SANDBOX_TOOL_PORTAL_URL || "",
    SANDBOX_TOOL_PORTAL_TIMEOUT_MS: config.SANDBOX_TOOL_PORTAL_TIMEOUT_MS || "60000",
  };
}

function buildPiNativeExtensionEnv(session, { lcmContextExtensionAvailable, codexWebSearchExtensionAvailable, controlPlaneToolsExtensionAvailable, sandboxToolPortalExtensionAvailable }) {
  const {
    STATE_DIR,
    WORKSPACE_DIR,
    CODEX_HOME,
    RUNTIME_API_TOKEN,
    CODEX_WEB_SEARCH_ENABLED,
    CODEX_WEB_SEARCH_MODE,
    CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS,
    CONTROL_PLANE_TOOLS_EXTENSION_PATH,
    CONTROL_PLANE_URL,
    CONTROL_PLANE_RUNTIME_ID,
    CONTROL_PLANE_RUNTIME_TOKEN,
    CONTROL_PLANE_TOOL_TIMEOUT_MS,
    SANDBOX_TOOL_PORTAL_URL,
    SANDBOX_TOOL_PORTAL_TIMEOUT_MS,
  } = session.extensionConfig;

  const env = {
    CODEX_HOME,
    BEEP_STATE_DIR: STATE_DIR,
    BEEP_WORKSPACE_DIR: WORKSPACE_DIR,
    PI_CODING_AGENT_DIR: session.agentDir,
    PI_CODING_AGENT_SESSION_DIR: session.sessionDir,
    BEEP_PI_EXTENSION_CONFIG_ID: session.extensionConfigId,
    BEEP_LCM_CONTEXT_ENABLED: lcmContextExtensionAvailable ? "1" : "0",
    BEEP_CODEX_WEB_SEARCH_ENABLED: codexWebSearchExtensionAvailable && CODEX_WEB_SEARCH_ENABLED ? "1" : "0",
    BEEP_CONTROL_PLANE_TOOLS_ENABLED: controlPlaneToolsExtensionAvailable ? "1" : "0",
    BEEP_SANDBOX_TOOL_PORTAL_ENABLED: sandboxToolPortalExtensionAvailable ? "1" : "0",
  };

  if (codexWebSearchExtensionAvailable && CODEX_WEB_SEARCH_ENABLED) {
    env.BEEP_CODEX_WEB_SEARCH_MODE = CODEX_WEB_SEARCH_MODE;
    for (const key of CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }

  if (sandboxToolPortalExtensionAvailable) {
    env.BEEP_SANDBOX_TOOL_PORTAL_URL = SANDBOX_TOOL_PORTAL_URL;
    env.BEEP_SANDBOX_TOOL_PORTAL_TOKEN = RUNTIME_API_TOKEN;
    env.BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS = SANDBOX_TOOL_PORTAL_TIMEOUT_MS;
  }

  if (controlPlaneToolsExtensionAvailable) {
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
    if (value === undefined || value === null || value === "") delete env[key];
  }
  return env;
}

function extensionPathSet(extensionsResult) {
  const loadedExtensionPaths = new Set();
  for (const extension of extensionsResult?.extensions || []) {
    if (typeof extension?.path !== "string" || extension.path.length === 0) continue;
    loadedExtensionPaths.add(extension.path);
    loadedExtensionPaths.add(resolve(extension.path));
  }
  return loadedExtensionPaths;
}

function normalizeExtensionLoaderErrors(extensionsResult) {
  return (extensionsResult?.errors || []).map((entry) => {
    if (entry && typeof entry === "object") {
      return {
        path: typeof entry.path === "string" ? entry.path : null,
        error: typeof entry.error === "string" ? entry.error : JSON.stringify(entry.error ?? entry),
      };
    }
    return { path: null, error: String(entry) };
  });
}

function applyScopedEnv(env) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = String(value);
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withProcessEnvCriticalSection(env, callback) {
  const previous = extensionEnvCriticalSection;
  let release;
  extensionEnvCriticalSection = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  const restore = applyScopedEnv(env);
  try {
    return await callback();
  } finally {
    restore();
    release();
  }
}

function nativeContent(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input.map((part) => ({ ...part }));
}

function lastAssistantTextFromSession(piSession) {
  const messages = Array.isArray(piSession?.state?.messages) ? piSession.state.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return textFromContent(message.content);
  }
  return null;
}

function eventPhase(event) {
  if (event?.type === "agent_start") return "agent_running";
  if (event?.type === "turn_start") return "turn_running";
  if (event?.type === "turn_end") return "turn_complete";
  if (event?.type === "agent_end") return "idle";
  return null;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class PiNativeSession {
  constructor(options = {}) {
    this.id = options.id || `sess_${randomUUID().slice(0, 8)}`;
    this.model = options.model;
    this.thinking = options.thinking;
    this.rootDir = options.rootDir;
    this.workspace = options.workspace;
    this.sessionDir = options.sessionDir;
    this.piRoot = options.piRoot;
    this.codexHome = options.codexHome;
    this.resolveAccessToken = options.resolveAccessToken;
    this.resumeLatest = Boolean(options.resumeLatest);
    this.writeSummaryExtra = typeof options.writeSummaryExtra === "function" ? options.writeSummaryExtra : null;
    this.extensionConfig = normalizeExtensionConfig({ ...options.extensionConfig, CODEX_HOME: options.codexHome });
    this.agentDir = join(this.rootDir, "pi-agent");
    this.eventsPath = join(this.rootDir, "events.jsonl");
    this.stdoutPath = join(this.rootDir, "stdout.log");
    this.stderrPath = join(this.rootDir, "stderr.log");
    this.statusPath = join(this.rootDir, "status.json");
    this.summaryPath = join(this.rootDir, "summary.json");
    this.lcmSummaryPath = join(this.rootDir, "lcm-summary.json");
    this.lcmContextInjectionPath = join(this.rootDir, "lcm-context-injection.json");
    this.hindsightMemoryPath = join(this.rootDir, "hindsight-memory.json");
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
    this.agentEndWaiters = [];
    this.closed = false;
    this.stderrTail = "";
    this.extensionConfigId = randomUUID();
    this.unregisterExtensionConfig = null;
    this.extensionLoader = null;
    this.requestedExtensionPaths = [];
    this.unsubscribe = null;
    this.sdk = null;
    this.piSession = null;
    this.activePrompt = null;
  }

  static async start(options = {}) {
    const session = new PiNativeSession(options);
    await session.open();
    return session;
  }

  async open() {
    ensureDir(this.rootDir);
    ensureDir(this.workspace);
    ensureDir(this.sessionDir);
    ensureDir(this.agentDir);
    this.stdoutStream = createWriteStream(this.stdoutPath, { flags: "a" });
    this.stderrStream = createWriteStream(this.stderrPath, { flags: "a" });
    this.eventsStream = createWriteStream(this.eventsPath, { flags: "a" });

    const {
      LCM_CONTEXT_ENABLED,
      LCM_CONTEXT_EXTENSION_PATH,
      LCM_CONTEXT_URL,
      LCM_CONTEXT_TOKEN_BUDGET,
      LCM_CONTEXT_TIMEOUT_MS,
      CODEX_WEB_SEARCH_EXTENSION_ENABLED,
      CODEX_WEB_SEARCH_ENABLED,
      CODEX_WEB_SEARCH_EXTENSION_PATH,
      CODEX_WEB_SEARCH_MODE,
      CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS,
      CONTROL_PLANE_TOOLS_ENABLED,
      CONTROL_PLANE_TOOLS_EXTENSION_PATH,
      CONTROL_PLANE_URL,
      CONTROL_PLANE_RUNTIME_ID,
      CONTROL_PLANE_RUNTIME_TOKEN,
      CONTROL_PLANE_TOOL_TIMEOUT_MS,
      SANDBOX_TOOL_PORTAL_ENABLED,
      SANDBOX_TOOL_PORTAL_EXTENSION_PATH,
      SANDBOX_TOOL_PORTAL_URL,
      SANDBOX_TOOL_PORTAL_TIMEOUT_MS,
      RUNTIME_API_TOKEN,
    } = this.extensionConfig;

    const additionalExtensionPaths = [];
    const lcmContextExtensionAvailable = LCM_CONTEXT_ENABLED && existsSync(LCM_CONTEXT_EXTENSION_PATH);
    if (lcmContextExtensionAvailable) additionalExtensionPaths.push(LCM_CONTEXT_EXTENSION_PATH);
    const codexWebSearchExtensionAvailable = CODEX_WEB_SEARCH_EXTENSION_ENABLED && existsSync(CODEX_WEB_SEARCH_EXTENSION_PATH);
    if (codexWebSearchExtensionAvailable) additionalExtensionPaths.push(CODEX_WEB_SEARCH_EXTENSION_PATH);
    const sandboxToolPortalExtensionAvailable =
      SANDBOX_TOOL_PORTAL_ENABLED && Boolean(RUNTIME_API_TOKEN) && existsSync(SANDBOX_TOOL_PORTAL_EXTENSION_PATH);
    if (sandboxToolPortalExtensionAvailable) additionalExtensionPaths.push(SANDBOX_TOOL_PORTAL_EXTENSION_PATH);
    const controlPlaneToolsExtensionAvailable =
      CONTROL_PLANE_TOOLS_ENABLED &&
      Boolean(CONTROL_PLANE_URL) &&
      Boolean(CONTROL_PLANE_RUNTIME_TOKEN) &&
      existsSync(CONTROL_PLANE_TOOLS_EXTENSION_PATH);
    if (controlPlaneToolsExtensionAvailable) additionalExtensionPaths.push(CONTROL_PLANE_TOOLS_EXTENSION_PATH);
    this.requestedExtensionPaths = additionalExtensionPaths.slice();
    const extensionAvailability = {
      lcmContextExtensionAvailable,
      codexWebSearchExtensionAvailable,
      sandboxToolPortalExtensionAvailable,
      controlPlaneToolsExtensionAvailable,
    };

    const resumedFrom = this.resumeLatest ? listSessionFiles(this.sessionDir)[0]?.path || null : null;
    const env = buildPiNativeExtensionEnv(this, {
      lcmContextExtensionAvailable,
      codexWebSearchExtensionAvailable,
      controlPlaneToolsExtensionAvailable,
      sandboxToolPortalExtensionAvailable,
    });
    this.unregisterExtensionConfig = registerExtensionConfig(this.extensionConfigId, {
      lcmContext: {
        enabled: lcmContextExtensionAvailable,
        url: LCM_CONTEXT_URL,
        token: this.extensionConfig.LCM_CONTEXT_TOKEN,
        runtimeSessionId: this.id,
        tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
        timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
      },
    });

    try {
      const accessToken = await this.resolveAccessToken();
      const sdk = await loadPiSdk(this.piRoot);
      this.sdk = sdk;
      sdk.ai.registerBuiltInApiProviders?.();
      const authStorage = sdk.codingAgent.AuthStorage.inMemory();
      authStorage.setRuntimeApiKey("openai-codex", accessToken);
      const modelRegistry = sdk.codingAgent.ModelRegistry.create(authStorage, join(this.agentDir, "models.json"));
      const model = sdk.ai.getModel("openai-codex", this.model);
      if (!model) throw new Error(`Pi model not found: openai-codex/${this.model}`);
      const settingsManager = sdk.codingAgent.SettingsManager.create(this.workspace, this.agentDir);
      const sessionManager = resumedFrom
        ? sdk.codingAgent.SessionManager.open(resumedFrom, this.sessionDir, this.workspace)
        : sdk.codingAgent.SessionManager.create(this.workspace, this.sessionDir);
      const resourceLoader = new sdk.codingAgent.DefaultResourceLoader({
        cwd: this.workspace,
        agentDir: this.agentDir,
        settingsManager,
        additionalExtensionPaths,
      });
      let result;
      await withProcessEnvCriticalSection(env, async () => {
        await resourceLoader.reload();
        result = await sdk.codingAgent.createAgentSession({
          cwd: this.workspace,
          agentDir: this.agentDir,
          authStorage,
          modelRegistry,
          model,
          thinkingLevel: this.thinking,
          settingsManager,
          sessionManager,
          resourceLoader,
        });
        this.piSession = result.session;
        this.unsubscribe = this.piSession.subscribe((event) => this.handleNativeEvent(event));
        await this.piSession.bindExtensions({});
      });
      const extensionsResult = result.extensionsResult || resourceLoader.getExtensions();
      const loadedExtensionPaths = extensionPathSet(extensionsResult);
      const extensionLoaderErrors = normalizeExtensionLoaderErrors(extensionsResult);
      this.unregisterExtensionConfig?.();
      this.unregisterExtensionConfig = null;
      this.extensionLoader = {
        requestedPaths: this.requestedExtensionPaths,
        loadedPaths: [...loadedExtensionPaths],
        errors: extensionLoaderErrors,
      };
      this.runConfig = this.buildRunConfig({
        resumedFrom,
        extensionAvailability,
        loadedExtensionPaths,
        extensionLoaderErrors,
      });
      writeJsonFile(join(this.rootDir, "run-config.json"), this.runConfig);
      const lcmContextExtensionLoaded = loadedExtensionPaths.has(LCM_CONTEXT_EXTENSION_PATH);
      if (lcmContextExtensionLoaded && typeof this.piSession.setAutoCompactionEnabled === "function") {
        this.piSession.setAutoCompactionEnabled(false);
        this.recordLcmContextInjection({
          kind: "pi_auto_compaction",
          ok: true,
          at: nowIso(),
          detail: "Pi native auto-compaction disabled so Beep LCM owns context assembly.",
        });
      }
      this.phase = "running";
      this.updatedAt = nowIso();
      this.writeStatus();
      this.writeSummary();
    } catch (error) {
      this.lastError = errorMessage(error);
      if (!this.extensionLoader) {
        const extensionLoaderErrors = [{ path: null, error: this.lastError }];
        const loadedExtensionPaths = new Set();
        this.extensionLoader = {
          requestedPaths: this.requestedExtensionPaths,
          loadedPaths: [],
          errors: extensionLoaderErrors,
        };
        this.runConfig = this.buildRunConfig({
          resumedFrom,
          extensionAvailability,
          loadedExtensionPaths,
          extensionLoaderErrors,
        });
        writeJsonFile(join(this.rootDir, "run-config.json"), this.runConfig);
      }
      this.stderrTail = `${this.stderrTail}${this.lastError}\n`.slice(-8_000);
      this.stderrStream?.write(`${this.lastError}\n`);
      this.phase = "failed";
      this.updatedAt = nowIso();
      this.writeStatus();
      this.writeSummary();
      this.unregisterExtensionConfig?.();
      this.unregisterExtensionConfig = null;
      this.closeStreams();
      throw error;
    }
  }

  handleNativeEvent(event) {
    const raw = event && typeof event === "object" ? event : { type: "event", value: event };
    this.eventsStream?.write(`${JSON.stringify(raw)}\n`);
    this.eventCount += 1;
    this.recentEvents.push(raw);
    if (this.recentEvents.length > EVENT_MEMORY_LIMIT) this.recentEvents.shift();

    const phase = eventPhase(raw);
    if (phase) this.phase = phase;
    if (raw.type === "agent_end") {
      this.agentEndCount += 1;
      this.resolveAgentEndWaiters();
      this.writeSummary();
    }
    if ((raw.type === "message_end" || raw.type === "turn_end") && raw.message?.role === "assistant") {
      this.lastAssistantText = textFromContent(raw.message.content) || this.lastAssistantText;
    }
    const stateText = lastAssistantTextFromSession(this.piSession);
    if (stateText) this.lastAssistantText = stateText;
    this.updatedAt = nowIso();
    this.writeStatus();
  }

  async prompt(input, options = {}) {
    if (!Array.isArray(input) || input.length === 0) {
      throw new Error("Prompt input is required.");
    }
    if (!this.piSession || this.closed) throw new Error(`Pi native session ${this.id} is not running.`);
    if (this.activePrompt) {
      throw Object.assign(new Error(`Pi native session ${this.id} is already processing a prompt.`), { statusCode: 409 });
    }
    const waitForCompletion = Boolean(options.waitForCompletion);
    const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_PROMPT_TIMEOUT_MS;
    const beforeAgentEndCount = this.agentEndCount;
    const promptPromise = this.runPromptWithTimeout(input, options, timeoutMs);
    this.trackBackgroundPrompt(promptPromise);
    if (!waitForCompletion) {
      return {
        response: { success: true },
        completed: null,
        finalText: this.lastAssistantText,
        summary: this.writeSummary(),
      };
    }
    await promptPromise;
    await this.waitForAgentEndAfter(beforeAgentEndCount, timeoutMs);
    this.lastAssistantText = lastAssistantTextFromSession(this.piSession) || this.lastAssistantText;
    return {
      response: { success: true },
      completed: waitForCompletion ? this.agentEndCount > beforeAgentEndCount || this.closed : null,
      finalText: this.lastAssistantText,
      summary: this.writeSummary(),
    };
  }

  async steer(input) {
    if (!this.piSession || this.closed) throw new Error(`Pi native session ${this.id} is not running.`);
    await this.piSession.steer(nativeContent(input));
    return { success: true };
  }

  async followUp(input) {
    if (!this.piSession || this.closed) throw new Error(`Pi native session ${this.id} is not running.`);
    await this.piSession.followUp(nativeContent(input));
    return { success: true };
  }

  async abort() {
    if (!this.piSession || this.closed) return { success: true };
    await this.piSession.abort();
    this.phase = "idle";
    this.updatedAt = nowIso();
    this.writeStatus();
    return { success: true };
  }

  async runPromptWithTimeout(input, options, timeoutMs) {
    const nativePrompt = this.piSession.prompt(nativeContent(input), {
      expandPromptTemplates: options.expandPromptTemplates ?? true,
      ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      source: "interactive",
    });
    let timeout;
    let timedOut = false;
    const timeoutPromise = new Promise((_, rejectPromise) => {
      timeout = setTimeout(() => {
        timedOut = true;
        Promise.resolve()
          .then(async () => {
            await this.abort();
            this.lastError = `Timed out waiting for Pi native prompt in session ${this.id}.`;
            this.phase = "failed";
            this.updatedAt = nowIso();
            this.writeStatus();
          })
          .catch((error) => {
            this.stderrTail = `${this.stderrTail}${errorMessage(error)}\n`.slice(-8_000);
            this.lastError = `Timed out waiting for Pi native prompt in session ${this.id}; abort failed: ${errorMessage(error)}`;
            this.phase = "failed";
            this.updatedAt = nowIso();
            this.writeStatus();
          })
          .finally(() => {
            rejectPromise(new Error(`Timed out waiting for Pi native prompt in session ${this.id}.`));
          });
      }, timeoutMs);
    });
    nativePrompt.catch((error) => {
      if (timedOut) {
        this.stderrTail = `${this.stderrTail}${errorMessage(error)}\n`.slice(-8_000);
      }
    });
    try {
      return await Promise.race([nativePrompt, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  }

  trackBackgroundPrompt(promptPromise) {
    this.activePrompt = promptPromise;
    promptPromise
      .catch((error) => {
        this.lastError = errorMessage(error);
        this.stderrTail = `${this.stderrTail}${this.lastError}\n`.slice(-8_000);
        this.updatedAt = nowIso();
        this.writeStatus();
        this.writeSummary();
      })
      .finally(() => {
        if (this.activePrompt === promptPromise) this.activePrompt = null;
      });
  }

  buildRunConfig({ resumedFrom, extensionAvailability, loadedExtensionPaths, extensionLoaderErrors }) {
    const {
      LCM_CONTEXT_ENABLED,
      LCM_CONTEXT_EXTENSION_PATH,
      LCM_CONTEXT_URL,
      LCM_CONTEXT_TOKEN_BUDGET,
      LCM_CONTEXT_TIMEOUT_MS,
      CODEX_WEB_SEARCH_EXTENSION_ENABLED,
      CODEX_WEB_SEARCH_ENABLED,
      CODEX_WEB_SEARCH_EXTENSION_PATH,
      CODEX_WEB_SEARCH_MODE,
      CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS,
      CONTROL_PLANE_TOOLS_ENABLED,
      CONTROL_PLANE_TOOLS_EXTENSION_PATH,
      CONTROL_PLANE_URL,
      CONTROL_PLANE_RUNTIME_ID,
      CONTROL_PLANE_RUNTIME_TOKEN,
      CONTROL_PLANE_TOOL_TIMEOUT_MS,
      SANDBOX_TOOL_PORTAL_ENABLED,
      SANDBOX_TOOL_PORTAL_EXTENSION_PATH,
      SANDBOX_TOOL_PORTAL_URL,
      SANDBOX_TOOL_PORTAL_TIMEOUT_MS,
    } = this.extensionConfig;
    const {
      lcmContextExtensionAvailable,
      codexWebSearchExtensionAvailable,
      sandboxToolPortalExtensionAvailable,
      controlPlaneToolsExtensionAvailable,
    } = extensionAvailability;

    return {
      schemaVersion: 1,
      id: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      workspace: this.workspace,
      sessionDir: this.sessionDir,
      piRoot: this.piRoot,
      codexHome: this.codexHome,
      transport: "pi-native",
      resumeLatest: this.resumeLatest,
      resumedFrom,
      extensionLoader: {
        requestedPaths: this.requestedExtensionPaths,
        loadedPaths: [...loadedExtensionPaths],
        errors: extensionLoaderErrors,
      },
      lcmContext: {
        enabled: LCM_CONTEXT_ENABLED,
        extensionPath: LCM_CONTEXT_EXTENSION_PATH,
        extensionAvailable: lcmContextExtensionAvailable,
        extensionLoaded: loadedExtensionPaths.has(LCM_CONTEXT_EXTENSION_PATH),
        url: LCM_CONTEXT_URL,
        tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
        timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
      },
      codexWebSearch: {
        enabled: CODEX_WEB_SEARCH_ENABLED,
        extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED,
        extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH,
        extensionAvailable: codexWebSearchExtensionAvailable,
        extensionLoaded: loadedExtensionPaths.has(CODEX_WEB_SEARCH_EXTENSION_PATH),
        effectiveEnabled: CODEX_WEB_SEARCH_ENABLED && loadedExtensionPaths.has(CODEX_WEB_SEARCH_EXTENSION_PATH),
        mode: CODEX_WEB_SEARCH_MODE,
        allowedDomainsConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
        contextSizeConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
        contentTypesConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
        userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS.some((key) => key.startsWith("BEEP_CODEX_WEB_SEARCH_LOCATION_") && Boolean(process.env[key])),
      },
      sandboxToolPortal: {
        enabled: SANDBOX_TOOL_PORTAL_ENABLED,
        extensionPath: SANDBOX_TOOL_PORTAL_EXTENSION_PATH,
        extensionAvailable: sandboxToolPortalExtensionAvailable,
        extensionLoaded: loadedExtensionPaths.has(SANDBOX_TOOL_PORTAL_EXTENSION_PATH),
        url: SANDBOX_TOOL_PORTAL_URL,
        timeoutMs: Number(SANDBOX_TOOL_PORTAL_TIMEOUT_MS),
      },
      controlPlaneTools: {
        enabled: CONTROL_PLANE_TOOLS_ENABLED,
        extensionPath: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
        extensionAvailable: controlPlaneToolsExtensionAvailable,
        extensionLoaded: loadedExtensionPaths.has(CONTROL_PLANE_TOOLS_EXTENSION_PATH),
        url: CONTROL_PLANE_URL || null,
        runtimeId: CONTROL_PLANE_RUNTIME_ID,
        runtimeTokenConfigured: Boolean(CONTROL_PLANE_RUNTIME_TOKEN),
        timeoutMs: Number(CONTROL_PLANE_TOOL_TIMEOUT_MS),
      },
      createdAt: this.createdAt,
      updatedAt: nowIso(),
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

  rejectAgentEndWaiters(error) {
    for (const waiter of this.agentEndWaiters) waiter.reject(error);
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

  readLcmContextInjection() {
    return readJsonFile(this.lcmContextInjectionPath, {
      schemaVersion: 1,
      enabled: this.extensionConfig.LCM_CONTEXT_ENABLED,
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
      enabled: this.extensionConfig.LCM_CONTEXT_ENABLED,
      extensionPath: this.extensionConfig.LCM_CONTEXT_EXTENSION_PATH,
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

  lcmIdentity() {
    return {
      sessionId: lcmSessionIdForRuntimeSession(this.id),
      sessionKey: lcmSessionKeyForRuntimeSession(this.id),
    };
  }

  async resolvePiSessionFile() {
    await this.flushEvents();
    const eventLineCount = readTextLines(this.eventsPath).map((line) => line.trim()).filter(Boolean).length;
    let sessionStats = null;
    let sessionFile = null;
    try {
      sessionStats = typeof this.piSession?.getSessionStats === "function" ? this.piSession.getSessionStats() : null;
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

  writeStatus() {
    writeJsonFile(this.statusPath, this.status());
  }

  writeSummary(extra = {}) {
    const events = parseJsonl(this.eventsPath);
    const summaryExtra = this.writeSummaryExtra ? this.writeSummaryExtra(this) : {};
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
      runConfig: this.runConfig || null,
      lcm: readJsonFile(this.lcmSummaryPath, null),
      lcmContextInjection: this.readLcmContextInjection(),
      hindsightMemory: this.readHindsightMemory(),
      ...summaryExtra,
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
      pendingResponseCount: 0,
      lastAssistantText: this.lastAssistantText,
      lastError: this.lastError,
      stderrTail: this.stderrTail,
      transport: "pi-native",
      extensionLoader: this.extensionLoader,
    };
  }

  closeStreams() {
    this.stdoutStream?.end();
    this.stderrStream?.end();
    this.eventsStream?.end();
  }

  async stop() {
    if (this.closed) return this.status();
    this.phase = "stopping";
    this.updatedAt = nowIso();
    this.writeStatus();
    try {
      if (this.piSession) await this.abort();
      this.unsubscribe?.();
      this.piSession?.dispose?.();
      this.exitCode = 0;
      this.phase = "closed";
    } catch (error) {
      this.exitCode = 1;
      this.phase = "failed";
      this.lastError = errorMessage(error);
      this.rejectAgentEndWaiters(error);
    } finally {
      this.closed = true;
      this.unregisterExtensionConfig?.();
      this.unregisterExtensionConfig = null;
      this.updatedAt = nowIso();
      this.writeSummary();
      this.writeStatus();
      this.resolveAgentEndWaiters();
      this.closeStreams();
    }
    return this.status();
  }
}
