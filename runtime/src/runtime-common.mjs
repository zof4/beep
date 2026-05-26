import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const STATE_DIR = process.env.BEEP_STATE_DIR || "/state";
export const WORKSPACE_DIR = process.env.BEEP_WORKSPACE_DIR || "/workspace";
export const CODEX_HOME = process.env.CODEX_HOME || join(STATE_DIR, "codex");
export const PI_ROOT = process.env.BEEP_PI_ROOT || "/opt/pi";
export const API_HOST = process.env.BEEP_RUNTIME_API_HOST || "0.0.0.0";
export const API_PORT = Number.parseInt(process.env.BEEP_RUNTIME_API_PORT || "8787", 10);
export const API_STATE_DIR = process.env.BEEP_RUNTIME_API_STATE_DIR || join(STATE_DIR, "api");
export const API_SESSIONS_DIR = join(API_STATE_DIR, "sessions");
export const API_AGENTS_DIR = join(API_STATE_DIR, "agents");
export const API_WORKSPACE_DIR = process.env.BEEP_RUNTIME_API_WORKSPACE_DIR || join(WORKSPACE_DIR, "api-sessions");
export const RUNTIME_STATE_PATH = process.env.BEEP_RUNTIME_STATE || join(STATE_DIR, "beep-runtime-state.json");
export const DEFAULT_MODEL = process.env.BEEP_PI_CODEX_MODEL || "gpt-5.5";
export const DEFAULT_THINKING = process.env.BEEP_PI_THINKING || "low";
export const DEFAULT_AGENT_ID = process.env.BEEP_AGENT_ID || "beep";
export const AGENT_AUTOSTART = !["0", "false"].includes(String(process.env.BEEP_AGENT_AUTOSTART || "1").toLowerCase());
export const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_RPC_TIMEOUT_MS = 60 * 1000;
export const MAX_REQUEST_BYTES = Number.parseInt(process.env.BEEP_MAX_REQUEST_BYTES || `${8 * 1024 * 1024}`, 10);
export const EVENT_MEMORY_LIMIT = 2_000;
export const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const LCM_CONTEXT_ENABLED = boolEnv("BEEP_LCM_CONTEXT_ENABLED", true);
export const LCM_CONTEXT_EXTENSION_PATH =
  process.env.BEEP_LCM_CONTEXT_EXTENSION_PATH || "/runtime/pi-extensions/lcm-context-extension.mjs";
export const LCM_CONTEXT_URL = process.env.BEEP_LCM_CONTEXT_URL || `http://127.0.0.1:${API_PORT}/internal/lcm/context`;
export const LCM_LIFECYCLE_URL =
  process.env.BEEP_LCM_LIFECYCLE_URL || `http://127.0.0.1:${API_PORT}/internal/lcm/lifecycle`;
export const LCM_CONTEXT_TOKEN = process.env.BEEP_LCM_CONTEXT_TOKEN || randomUUID();
export const LCM_CONTEXT_TOKEN_BUDGET = process.env.BEEP_LCM_CONTEXT_TOKEN_BUDGET || "128000";
export const LCM_CONTEXT_TIMEOUT_MS = process.env.BEEP_LCM_CONTEXT_TIMEOUT_MS || "15000";
export const LCM_RECALL_TOOLS_ENABLED = boolEnv("BEEP_LCM_RECALL_TOOLS_ENABLED", true);
export const LCM_RECALL_TOOLS_EXTENSION_PATH =
  process.env.BEEP_LCM_RECALL_TOOLS_EXTENSION_PATH || "/runtime/pi-extensions/lcm-recall-tools-extension.mjs";
export const LCM_RECALL_TOOL_URL =
  process.env.BEEP_LCM_RECALL_TOOL_URL || `http://127.0.0.1:${API_PORT}/internal/lcm/tool`;
export const LCM_RECALL_TOOL_TIMEOUT_MS = process.env.BEEP_LCM_RECALL_TOOL_TIMEOUT_MS || "30000";

export const DEV_ENDPOINTS_ENABLED = boolEnv("BEEP_RUNTIME_DEV_ENDPOINTS", false);
export const RUNTIME_CODEX_AUTH_COMPAT_ENABLED = boolEnv("BEEP_ALLOW_RUNTIME_CODEX_AUTH", false);
export const MODEL_GATEWAY_CREDENTIAL_URL = process.env.BEEP_MODEL_GATEWAY_CREDENTIAL_URL || "";
export const MODEL_GATEWAY_CAPABILITY_TOKEN = process.env.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN || "";

export const CONTROL_PLANE_TOOLS_ENABLED = boolEnv("BEEP_CONTROL_PLANE_TOOLS_ENABLED", true);
export const CONTROL_PLANE_URL = process.env.BEEP_CONTROL_PLANE_URL || "";
export const CONTROL_PLANE_RUNTIME_ID = process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || "local";
export const CONTROL_PLANE_RUNTIME_TOKEN = process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN || "";
export const CONTROL_PLANE_TOOL_TIMEOUT_MS = process.env.BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS || "15000";
export const CONTROL_PLANE_TOOLS_EXTENSION_PATH =
  process.env.BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH || "/runtime/pi-extensions/control-plane-tools-extension.mjs";

export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJsonFile(path, fallback = null) {
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

export function writeJsonFile(path, value, mode = 0o600) {
  ensureDir(dirname(path));
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, next, { mode });
  renameSync(tmpPath, path);
}

export function safeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadRuntimeConfig() {
  const state = readJsonFile(RUNTIME_STATE_PATH, {});
  return {
    provider: "openai-codex",
    model: state?.model || DEFAULT_MODEL,
    thinking: state?.thinking || DEFAULT_THINKING,
  };
}

export function newSessionId(prefix = "sess") {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("T", "t").replace("Z", "z");
  return `${prefix}_${stamp}_${randomUUID().slice(0, 8)}`;
}

export function newRequestId(prefix = "req") {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

export function readTextLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/u);
}

export function listSessionFiles(sessionDir) {
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

export function parseJsonl(path) {
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

export function listDirectory(path) {
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

export function textFromContent(content) {
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

export function summarizeEvents(events) {
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

export function commandPath() {
  return {
    tsxBin: join(PI_ROOT, "node_modules/.bin/tsx"),
    piCli: join(PI_ROOT, "packages/coding-agent/src/cli.ts"),
  };
}

export function validateRuntimeReady() {
  const { tsxBin, piCli } = commandPath();
  if (!existsSync(tsxBin)) {
    throw new Error(`Pi dependencies are not installed at ${tsxBin}. Rebuild the runtime image.`);
  }
  if (!existsSync(piCli)) {
    throw new Error(`Vendored Pi CLI source is missing at ${piCli}.`);
  }
}

export function validateThinking(thinking) {
  if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking)) {
    throw new Error(`Invalid thinking level: ${thinking}`);
  }
}
