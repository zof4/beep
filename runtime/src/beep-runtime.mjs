import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const STATE_DIR = process.env.BEEP_STATE_DIR || "/state";
const CODEX_HOME = process.env.CODEX_HOME || join(STATE_DIR, "codex");
const PI_ROOT = process.env.BEEP_PI_ROOT || "/opt/pi";
const RUNTIME_STATE_PATH = process.env.BEEP_RUNTIME_STATE || join(STATE_DIR, "beep-runtime-state.json");
const PROOFS_DIR = join(STATE_DIR, "proofs");
const DEFAULT_MODEL = process.env.BEEP_PI_CODEX_MODEL || "gpt-5.5";
const DEFAULT_THINKING = process.env.BEEP_PI_THINKING || "low";
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, code = 2, details = undefined) {
  printJson({ ok: false, error: message, ...(details ? { details } : {}) });
  process.exit(code);
}

function readJsonFile(path, fallback = undefined) {
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

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing !== next) {
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, next, { mode: 0o600 });
    renameSync(tmpPath, path);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsage(usage) {
  const inputTokens = numberValue(usage?.inputTokens ?? usage?.input_tokens ?? usage?.input);
  const cachedInputTokens = numberValue(
    usage?.cachedInputTokens ?? usage?.cached_input_tokens ?? usage?.cacheRead,
  );
  const outputTokens = numberValue(usage?.outputTokens ?? usage?.output_tokens ?? usage?.output);
  const reasoningOutputTokens = numberValue(usage?.reasoningOutputTokens ?? usage?.reasoning_output_tokens);
  const cacheWriteTokens = numberValue(usage?.cacheWrite);
  const totalTokens = numberValue(
    usage?.totalTokens ??
      usage?.total_tokens ??
      inputTokens + cachedInputTokens + outputTokens + cacheWriteTokens,
  );
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheWriteTokens,
    cost: {
      input: numberValue(usage?.cost?.input),
      output: numberValue(usage?.cost?.output),
      cacheRead: numberValue(usage?.cost?.cacheRead),
      cacheWrite: numberValue(usage?.cost?.cacheWrite),
      total: numberValue(usage?.cost?.total),
    },
  };
}

function addUsage(left, right) {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function zeroUsage() {
  return normalizeUsage({});
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    const key = rawKey.replaceAll("-", "_");
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function loadState() {
  const state = readJsonFile(RUNTIME_STATE_PATH, {});
  if (state?.__readError) {
    return defaultState({ stateReadError: state.__readError });
  }
  return {
    ...defaultState(),
    ...state,
    model: state?.model || process.env.BEEP_PI_CODEX_MODEL || DEFAULT_MODEL,
    thinking: state?.thinking || process.env.BEEP_PI_THINKING || DEFAULT_THINKING,
  };
}

function defaultState(extra = {}) {
  return {
    schemaVersion: 1,
    provider: "openai-codex",
    model: DEFAULT_MODEL,
    thinking: DEFAULT_THINKING,
    updatedAt: null,
    updatedBy: null,
    ...extra,
  };
}

function saveState(nextState, updatedBy) {
  const state = {
    ...defaultState(),
    ...nextState,
    updatedAt: nowIso(),
    updatedBy,
  };
  writeJsonFile(RUNTIME_STATE_PATH, state);
  return state;
}

function codexModelsCachePath() {
  return join(CODEX_HOME, "models_cache.json");
}

function loadCodexModelCache() {
  const path = codexModelsCachePath();
  const cache = readJsonFile(path, null);
  if (!cache || cache.__readError || !Array.isArray(cache.models)) {
    return {
      source: "codex-cache",
      path,
      available: false,
      error: cache?.__readError || "models_cache.json is missing or does not contain models[]",
      fetchedAt: null,
      etag: null,
      clientVersion: null,
      models: [],
    };
  }
  return {
    source: "codex-cache",
    path,
    available: true,
    fetchedAt: cache.fetched_at || null,
    etag: cache.etag || null,
    clientVersion: cache.client_version || null,
    models: cache.models.map(normalizeCodexModel),
  };
}

function normalizeCodexModel(model) {
  const supportedReasoningEfforts = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels.map((item) => ({
        reasoningEffort: item.effort,
        description: item.description || "",
      }))
    : [];
  const hidden = model.visibility ? model.visibility !== "list" : false;
  return {
    source: "codex-cache",
    id: model.slug || model.id || model.model,
    model: model.model || model.slug || model.id,
    displayName: model.display_name || model.slug || model.id,
    description: model.description || "",
    hidden,
    supportedReasoningEfforts,
    defaultReasoningEffort: model.default_reasoning_level || supportedReasoningEfforts[0]?.reasoningEffort || null,
    inputModalities: model.input_modalities || [],
    supportsPersonality: Boolean(model.supports_personality),
    serviceTiers: Array.isArray(model.service_tiers) ? model.service_tiers : [],
    additionalSpeedTiers: Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers : [],
    isDefault: Boolean(model.is_default),
    supportedInApi: model.supported_in_api ?? null,
    priority: model.priority ?? null,
  };
}

async function loadPiModels() {
  const candidates = [
    join(PI_ROOT, "packages/ai/dist/models.js"),
    join(PI_ROOT, "packages/ai/src/models.ts"),
  ];
  const errors = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const module = await import(pathToFileURL(candidate).href);
      if (typeof module.getModels !== "function") {
        errors.push(`${candidate}: getModels export not found`);
        continue;
      }
      const openaiCodexModels = module.getModels("openai-codex") || [];
      const models = openaiCodexModels.map((model) => normalizePiModel(model, module));
      return {
        source: "pi-registry",
        path: candidate,
        available: true,
        models,
        errors,
      };
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    source: "pi-registry",
    path: null,
    available: false,
    models: [],
    errors: errors.length ? errors : ["No usable Pi model registry found."],
  };
}

function normalizePiModel(model, module) {
  const supportedThinking = typeof module.getSupportedThinkingLevels === "function"
    ? module.getSupportedThinkingLevels(model).filter((level) => level !== "off")
    : THINKING_LEVELS;
  return {
    source: "pi-registry",
    id: model.id,
    model: model.id,
    displayName: model.name || model.id,
    description: model.description || "",
    hidden: false,
    supportedReasoningEfforts: supportedThinking.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
    defaultReasoningEffort: model.defaultThinkingLevel || null,
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxTokens ?? null,
    cost: model.cost ?? null,
    api: model.api,
    provider: model.provider,
    reasoning: Boolean(model.reasoning),
  };
}

async function loadModelCatalog() {
  const codex = loadCodexModelCache();
  const pi = await loadPiModels();
  const byId = new Map();
  for (const model of pi.models) {
    byId.set(model.id, { ...model, sources: ["pi-registry"] });
  }
  for (const model of codex.models) {
    const existing = byId.get(model.id);
    if (existing) {
      byId.set(model.id, {
        ...existing,
        ...model,
        contextWindow: existing.contextWindow ?? null,
        maxTokens: existing.maxTokens ?? null,
        cost: existing.cost ?? null,
        api: existing.api ?? null,
        provider: existing.provider ?? "openai-codex",
        reasoning: existing.reasoning ?? true,
        sources: [...new Set([...(existing.sources || []), "codex-cache"])],
      });
    } else {
      byId.set(model.id, {
        ...model,
        contextWindow: null,
        maxTokens: null,
        cost: null,
        api: null,
        provider: "openai-codex",
        reasoning: true,
        sources: ["codex-cache"],
      });
    }
  }
  const models = [...byId.values()].sort((left, right) => {
    const leftPriority = typeof left.priority === "number" ? left.priority : Number.POSITIVE_INFINITY;
    const rightPriority = typeof right.priority === "number" ? right.priority : Number.POSITIVE_INFINITY;
    const priorityDiff = leftPriority - rightPriority;
    if (priorityDiff !== 0) return priorityDiff;
    return left.id.localeCompare(right.id);
  });
  return { codex, pi, models };
}

function pickModelsForSource(catalog, source) {
  if (source === "codex") return catalog.codex.models;
  if (source === "pi") return catalog.pi.models;
  return catalog.models;
}

function findModel(catalog, modelId) {
  return catalog.models.find((model) => model.id === modelId || model.model === modelId) || null;
}

function reasoningEffortsForModel(model) {
  const efforts = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((item) => item.reasoningEffort).filter(Boolean)
    : [];
  return [...new Set(efforts.length ? efforts : THINKING_LEVELS)];
}

function validateThinkingForModel(model, thinking) {
  if (!THINKING_LEVELS.includes(thinking)) {
    return { ok: false, reason: `Unknown thinking level: ${thinking}` };
  }
  const efforts = reasoningEffortsForModel(model);
  if (model && efforts.length > 0 && !efforts.includes(thinking)) {
    return {
      ok: false,
      reason: `Thinking level ${thinking} is not supported by ${model.id}.`,
      supported: efforts,
    };
  }
  return { ok: true, supported: efforts };
}

function loadAuthStatus() {
  const path = join(CODEX_HOME, "auth.json");
  const auth = readJsonFile(path, null);
  if (!auth || auth.__readError) {
    return {
      available: false,
      path,
      error: auth?.__readError || "auth.json not found",
      authMode: null,
      hasAccessToken: false,
      hasRefreshToken: false,
      hasApiKeyLikeToken: false,
      accountIdPresent: false,
      accountIdHash: null,
      lastRefresh: null,
    };
  }
  const accountId = auth?.tokens?.account_id;
  return {
    available: true,
    path,
    authMode: auth.auth_mode || null,
    hasAccessToken: typeof auth?.tokens?.access_token === "string" && auth.tokens.access_token.length > 0,
    hasRefreshToken: typeof auth?.tokens?.refresh_token === "string" && auth.tokens.refresh_token.length > 0,
    hasApiKeyLikeToken: typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0,
    accountIdPresent: typeof accountId === "string" && accountId.length > 0,
    accountIdHash: typeof accountId === "string" ? hashValue(accountId) : null,
    lastRefresh: auth.last_refresh || null,
  };
}

function hashValue(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function latestProofFiles(limit = 50) {
  if (!existsSync(PROOFS_DIR)) return [];
  return readdirSync(PROOFS_DIR)
    .map((name) => join(PROOFS_DIR, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    })
    .map((path) => {
      const stats = statSync(path);
      return { path, name: basename(path), mtimeMs: stats.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit);
}

function iterJsonl(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean);
  const events = [];
  for (const [index, line] of lines.entries()) {
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      events.push({
        __parseError: error instanceof Error ? error.message : String(error),
        __line: index + 1,
      });
    }
  }
  return events;
}

function usageFromEvent(event) {
  if (event?.type === "turn.completed" && event.usage) {
    return {
      eventType: event.type,
      usage: normalizeUsage(event.usage),
      model: event.model || null,
      responseId: event.response_id || event.responseId || null,
      timestamp: event.timestamp || null,
    };
  }
  if (event?.type !== "turn_end" && event?.type !== "message_end") {
    return null;
  }
  const message = event?.message;
  if (
    message?.role === "assistant" &&
    message.usage &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "error"
  ) {
    return {
      eventType: event.type,
      usage: normalizeUsage(message.usage),
      model: message.model || null,
      responseId: message.responseId || null,
      timestamp: event.timestamp || message.timestamp || null,
    };
  }
  return null;
}

function summarizeRunUsage(run) {
  const piEvents = join(run.path, "pi-events.jsonl");
  const codexEvents = join(run.path, "events.jsonl");
  const format = existsSync(piEvents) ? "pi" : existsSync(codexEvents) ? "codex" : "unknown";
  const eventsPath = format === "pi" ? piEvents : format === "codex" ? codexEvents : null;
  const events = eventsPath ? iterJsonl(eventsPath) : [];
  let total = zeroUsage();
  let last = null;
  let assistantMessagesWithUsage = 0;
  const models = new Set();
  const seenUsageKeys = new Set();
  for (const [index, event] of events.entries()) {
    const item = usageFromEvent(event);
    if (!item) continue;
    const key = usageDedupeKey(item, index);
    if (seenUsageKeys.has(key)) continue;
    seenUsageKeys.add(key);
    total = addUsage(total, item.usage);
    last = item;
    assistantMessagesWithUsage += 1;
    if (item.model) models.add(item.model);
  }
  return {
    runId: run.name,
    format,
    path: run.path,
    eventsPath,
    eventCount: events.length,
    assistantMessagesWithUsage,
    models: [...models],
    total,
    last,
  };
}

function usageDedupeKey(item, index) {
  if (item.responseId) return `response:${item.responseId}`;
  const usage = item.usage;
  const stable = [
    item.eventType,
    item.model || "",
    item.timestamp || "",
    usage.totalTokens,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
  ].join(":");
  return stable === "::::0:0:0:0:0" ? `line:${index}` : stable;
}

function summarizeUsage(runsLimit = 20) {
  const runs = latestProofFiles(runsLimit).map(summarizeRunUsage);
  let aggregate = zeroUsage();
  let last = null;
  for (const run of [...runs].reverse()) {
    aggregate = addUsage(aggregate, run.total);
    if (run.last) last = { ...run.last, runId: run.runId, format: run.format };
  }
  return {
    source: "runtime-proof-events",
    proofsDir: PROOFS_DIR,
    runsScanned: runs.length,
    aggregate,
    last,
    runs,
  };
}

function contextUsageFor(state, model, usageSummary) {
  const modelContextWindow = model?.contextWindow ?? null;
  const lastUsage = usageSummary.last?.usage ?? null;
  const usedTokens = lastUsage?.totalTokens ?? null;
  if (!modelContextWindow || usedTokens == null) {
    return {
      model: state.model,
      modelContextWindow,
      usedTokens,
      remainingTokens: null,
      percentUsed: null,
      reason: modelContextWindow ? "No recent usage with token data." : "Selected model has no known context window.",
    };
  }
  return {
    model: state.model,
    modelContextWindow,
    usedTokens,
    remainingTokens: Math.max(0, modelContextWindow - usedTokens),
    percentUsed: Number(((usedTokens / modelContextWindow) * 100).toFixed(3)),
    reason: null,
  };
}

function loadRateLimitsSnapshot() {
  const path = join(STATE_DIR, "codex-rate-limits.json");
  const snapshot = readJsonFile(path, null);
  if (!snapshot || snapshot.__readError) {
    return {
      available: false,
      source: "none",
      path,
      error:
        snapshot?.__readError ||
        "No cached rate-limit snapshot exists yet. This requires the future Codex app-server/model-gateway adapter.",
    };
  }
  return {
    available: true,
    source: "cached",
    path,
    snapshot,
  };
}

async function commandCapabilities() {
  const catalog = await loadModelCatalog();
  const state = loadState();
  printJson({
    ok: true,
    schemaVersion: 1,
    runtime: {
      statePath: RUNTIME_STATE_PATH,
      codexHome: CODEX_HOME,
      piRoot: PI_ROOT,
      proofsDir: PROOFS_DIR,
    },
    current: {
      provider: state.provider,
      model: state.model,
      thinking: state.thinking,
    },
    sources: {
      codexModels: {
        available: catalog.codex.available,
        path: catalog.codex.path,
        fetchedAt: catalog.codex.fetchedAt,
        clientVersion: catalog.codex.clientVersion,
      },
      piModels: {
        available: catalog.pi.available,
        path: catalog.pi.path,
      },
      auth: loadAuthStatus(),
    },
    commands: [
      "capabilities",
      "models list [--source merged|codex|pi] [--include-hidden]",
      "models current",
      "models set <model>",
      "thinking get",
      "thinking set <minimal|low|medium|high|xhigh>",
      "usage status [--runs <n>]",
      "account status",
      "account rate-limits",
      "config get <model|thinking|provider>",
    ],
  });
}

async function commandModels(args) {
  const [action, maybeValue] = args.positional;
  const catalog = await loadModelCatalog();
  const state = loadState();
  if (action === "list") {
    const source = args.flags.source || "merged";
    if (!["merged", "codex", "pi"].includes(source)) {
      fail(`Unknown model source: ${source}`);
    }
    const includeHidden = Boolean(args.flags.include_hidden);
    const models = pickModelsForSource(catalog, source).filter((model) => includeHidden || !model.hidden);
    printJson({
      ok: true,
      source,
      count: models.length,
      selected: {
        model: state.model,
        thinking: state.thinking,
      },
      catalog: {
        codex: {
          available: catalog.codex.available,
          path: catalog.codex.path,
          fetchedAt: catalog.codex.fetchedAt,
          clientVersion: catalog.codex.clientVersion,
        },
        pi: {
          available: catalog.pi.available,
          path: catalog.pi.path,
          errors: catalog.pi.errors,
        },
      },
      models,
    });
    return;
  }
  if (action === "current") {
    const model = findModel(catalog, state.model);
    const thinkingCheck = validateThinkingForModel(model, state.thinking);
    printJson({
      ok: true,
      statePath: RUNTIME_STATE_PATH,
      selected: {
        provider: state.provider,
        model: state.model,
        thinking: state.thinking,
        updatedAt: state.updatedAt,
        updatedBy: state.updatedBy,
      },
      model,
      thinking: {
        valid: thinkingCheck.ok,
        supported: thinkingCheck.supported || [],
        reason: thinkingCheck.reason || null,
      },
    });
    return;
  }
  if (action === "set") {
    const nextModelId = maybeValue;
    if (!nextModelId) fail("Usage: beep-runtime models set <model>");
    const model = findModel(catalog, nextModelId);
    if (!model) {
      fail(`Unknown model: ${nextModelId}`, 2, {
        availableModels: catalog.models.map((item) => item.id),
      });
    }
    const thinking = state.thinking || model.defaultReasoningEffort || DEFAULT_THINKING;
    const thinkingCheck = validateThinkingForModel(model, thinking);
    const nextState = saveState(
      {
        ...state,
        model: model.id,
        thinking: thinkingCheck.ok ? thinking : model.defaultReasoningEffort || reasoningEffortsForModel(model)[0] || DEFAULT_THINKING,
      },
      "models set",
    );
    printJson({
      ok: true,
      statePath: RUNTIME_STATE_PATH,
      selected: {
        provider: nextState.provider,
        model: nextState.model,
        thinking: nextState.thinking,
        updatedAt: nextState.updatedAt,
      },
      model,
    });
    return;
  }
  fail("Usage: beep-runtime models <list|current|set>");
}

async function commandThinking(args) {
  const [action, maybeValue] = args.positional;
  const state = loadState();
  const catalog = await loadModelCatalog();
  const model = findModel(catalog, state.model);
  if (action === "get") {
    const thinkingCheck = validateThinkingForModel(model, state.thinking);
    printJson({
      ok: true,
      statePath: RUNTIME_STATE_PATH,
      selected: {
        model: state.model,
        thinking: state.thinking,
        updatedAt: state.updatedAt,
        updatedBy: state.updatedBy,
      },
      supported: thinkingCheck.supported || [],
      valid: thinkingCheck.ok,
      reason: thinkingCheck.reason || null,
    });
    return;
  }
  if (action === "set") {
    const nextThinking = maybeValue;
    if (!nextThinking) fail("Usage: beep-runtime thinking set <minimal|low|medium|high|xhigh>");
    const thinkingCheck = validateThinkingForModel(model, nextThinking);
    if (!thinkingCheck.ok) fail(thinkingCheck.reason, 2, { supported: thinkingCheck.supported || THINKING_LEVELS });
    const nextState = saveState({ ...state, thinking: nextThinking }, "thinking set");
    printJson({
      ok: true,
      statePath: RUNTIME_STATE_PATH,
      selected: {
        model: nextState.model,
        thinking: nextState.thinking,
        updatedAt: nextState.updatedAt,
      },
      supported: thinkingCheck.supported || [],
    });
    return;
  }
  fail("Usage: beep-runtime thinking <get|set>");
}

async function commandUsage(args) {
  const [action] = args.positional;
  if (action !== "status") fail("Usage: beep-runtime usage status [--runs <n>]");
  const runsLimit = Number.parseInt(args.flags.runs || "20", 10);
  const state = loadState();
  const catalog = await loadModelCatalog();
  const model = findModel(catalog, state.model);
  const usage = summarizeUsage(Number.isFinite(runsLimit) && runsLimit > 0 ? runsLimit : 20);
  printJson({
    ok: true,
    selected: {
      provider: state.provider,
      model: state.model,
      thinking: state.thinking,
    },
    context: contextUsageFor(state, model, usage),
    usage,
  });
}

function commandAccount(args) {
  const [action] = args.positional;
  if (action === "status") {
    printJson({
      ok: true,
      account: loadAuthStatus(),
    });
    return;
  }
  if (action === "rate-limits") {
    printJson({
      ok: true,
      rateLimits: loadRateLimitsSnapshot(),
    });
    return;
  }
  fail("Usage: beep-runtime account <status|rate-limits>");
}

async function commandConfig(args) {
  const [action, key] = args.positional;
  const state = loadState();
  if (action === "get") {
    if (!key) fail("Usage: beep-runtime config get <model|thinking|provider>");
    if (!["model", "thinking", "provider"].includes(key)) fail(`Unknown config key: ${key}`);
    process.stdout.write(`${state[key]}\n`);
    return;
  }
  if (action === "export") {
    printJson({
      ok: true,
      env: {
        BEEP_PI_CODEX_MODEL: state.model,
        BEEP_PI_THINKING: state.thinking,
      },
    });
    return;
  }
  fail("Usage: beep-runtime config <get|export>");
}

async function commandDebugBackupState() {
  const backupPath = `${RUNTIME_STATE_PATH}.${Date.now()}.bak`;
  if (existsSync(RUNTIME_STATE_PATH)) {
    copyFileSync(RUNTIME_STATE_PATH, backupPath);
  }
  printJson({ ok: true, backupPath: existsSync(backupPath) ? backupPath : null });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      await commandCapabilities();
      return;
    case "capabilities":
      await commandCapabilities();
      return;
    case "models":
      await commandModels(args);
      return;
    case "thinking":
      await commandThinking(args);
      return;
    case "usage":
      await commandUsage(args);
      return;
    case "account":
      commandAccount(args);
      return;
    case "config":
      await commandConfig(args);
      return;
    case "debug-backup-state":
      await commandDebugBackupState();
      return;
    default:
      fail(`Unknown command: ${command}`);
  }
}

await main();
