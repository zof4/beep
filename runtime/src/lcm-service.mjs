import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderExternalMemoryHintsAsMessages } from "./external-memory-hints.mjs";

const thisFile = fileURLToPath(import.meta.url);
const defaultLcmRoot = join(dirname(thisFile), "../../vendor/lossless-claw");

export const DEFAULT_LCM_ROOT = existsSync(defaultLcmRoot) ? defaultLcmRoot : "/opt/lossless-claw";
export const DEFAULT_LCM_DB = join(process.env.BEEP_LCM_DIR || "/lcm", "beep-lcm.sqlite");

export function lcmSessionIdForRuntimeSession(runtimeSessionId) {
  return `beep-pi-${runtimeSessionId}`;
}

export function lcmSessionKeyForRuntimeSession(runtimeSessionId) {
  return `beep:pi:${runtimeSessionId}`;
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function moduleUrl(lcmRoot, relativePath) {
  return pathToFileURL(join(lcmRoot, relativePath)).href;
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line.length > 0)
    .map((entry) => {
      try {
        return {
          ...entry,
          parsed: JSON.parse(entry.line),
          parseError: null,
        };
      } catch (error) {
        return {
          ...entry,
          parsed: null,
          parseError: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "toolCall") return `[tool:${part.name || "unknown"}] ${JSON.stringify(part.arguments ?? {})}`;
      if (part.type === "thinking") return part.thinking ? `[thinking] ${part.thinking}` : "[thinking]";
      return `[${part.type || "part"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function messageRole(message) {
  if (message?.role === "toolResult") return "tool";
  if (message?.role === "user" || message?.role === "assistant" || message?.role === "system") return message.role;
  return "unknown";
}

export function summarizeCanonicalMessages(messages) {
  const byRole = {};
  let assistantFinalText = "";
  let toolCallCount = 0;
  let toolResultCount = 0;
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };

  for (const message of messages) {
    const role = messageRole(message);
    byRole[role] = (byRole[role] || 0) + 1;
    if (message.role === "toolResult") {
      toolResultCount += 1;
    }
    if (Array.isArray(message.content)) {
      toolCallCount += message.content.filter((part) => part?.type === "toolCall").length;
    }
    if (message.role === "assistant") {
      const text = textFromContent(message.content);
      if (text) assistantFinalText = text;
      const nextUsage = message.usage;
      if (nextUsage && typeof nextUsage === "object") {
        usage.input += Number(nextUsage.input || 0);
        usage.output += Number(nextUsage.output || 0);
        usage.cacheRead += Number(nextUsage.cacheRead || 0);
        usage.cacheWrite += Number(nextUsage.cacheWrite || 0);
        usage.totalTokens += Number(nextUsage.totalTokens || 0);
        usage.cost += Number(nextUsage.cost?.total ?? nextUsage.cost ?? 0);
      }
    }
  }

  return {
    byRole,
    toolCallCount,
    toolResultCount,
    usage,
    assistantFinalText,
  };
}

export function extractPiSessionTranscript(path) {
  const records = readJsonl(path);
  const parseErrors = records.filter((record) => record.parseError);
  const messageEntries = [];
  let sessionHeader = null;
  let latestModel = null;
  let latestThinking = null;

  for (const record of records) {
    const entry = record.parsed;
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "session") {
      sessionHeader = entry;
    } else if (entry.type === "model_change") {
      latestModel = {
        provider: entry.provider,
        modelId: entry.modelId,
        timestamp: entry.timestamp,
      };
    } else if (entry.type === "thinking_level_change") {
      latestThinking = {
        thinkingLevel: entry.thinkingLevel,
        timestamp: entry.timestamp,
      };
    } else if (entry.type === "message" && entry.message && typeof entry.message === "object") {
      messageEntries.push({
        lineIndex: record.index,
        entryId: entry.id || null,
        parentId: entry.parentId || null,
        timestamp: entry.timestamp || null,
        message: entry.message,
        rawSha256: sha256(record.line),
      });
    }
  }

  return {
    records,
    parseErrors,
    sessionHeader,
    latestModel,
    latestThinking,
    messageEntries,
  };
}

export function canonicalMessagesFromEntries(entries) {
  return entries.map((entry) => {
    const message = cloneJson(entry.message);
    if (message && typeof message === "object") {
      if (message.timestamp === undefined && entry.timestamp) {
        message.timestamp = Date.parse(entry.timestamp);
      }
      message.beepSessionEntryId = entry.entryId;
      message.beepSessionParentId = entry.parentId;
      message.beepSessionLineIndex = entry.lineIndex;
      message.beepSessionRawSha256 = entry.rawSha256;
    }
    return message;
  });
}

export function messagesWithExternalMemoryHints(messages, externalMemoryHints = null) {
  const hintMessages = renderExternalMemoryHintsAsMessages(externalMemoryHints);
  return [...hintMessages, ...cloneJson(messages)];
}

function createLogSink(logs) {
  const push = (level, message) => {
    logs.push({ level, message: String(message), at: new Date().toISOString() });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };
  return {
    debug: (message) => push("debug", message),
    info: (message) => push("info", message),
    warn: (message) => push("warn", message),
    error: (message) => push("error", message),
  };
}

function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row?.name);
}

function tableCount(db, table) {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return Number(row?.count ?? 0);
}

function tableSum(db, table, column, where = "", args = []) {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COALESCE(SUM(${column}), 0) AS total FROM ${table} ${where}`).get(...args);
  return Number(row?.total ?? 0);
}

function rowCounts(db) {
  return Object.fromEntries(
    ["conversations", "messages", "message_parts", "summaries", "context_items", "large_files"].map((table) => [
      table,
      tableCount(db, table),
    ]),
  );
}

function safeStatSize(path) {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function serializeDoctorStats(stats) {
  return {
    total: stats.total,
    old: stats.old,
    truncated: stats.truncated,
    fallback: stats.fallback,
    candidates: stats.candidates,
    byConversation: Object.fromEntries(
      [...stats.byConversation.entries()].map(([conversationId, counts]) => [String(conversationId), counts]),
    ),
  };
}

export class LcmService {
  constructor({
    lcmRoot = process.env.BEEP_LCM_ROOT || DEFAULT_LCM_ROOT,
    dbPath = process.env.BEEP_LCM_DB || DEFAULT_LCM_DB,
    stateDir = process.env.BEEP_LCM_DIR || dirname(dbPath),
  } = {}) {
    this.lcmRoot = lcmRoot;
    this.dbPath = dbPath;
    this.stateDir = stateDir;
    this.largeFilesDir = process.env.LCM_LARGE_FILES_DIR || join(dirname(dbPath), "lcm-files");
    this.modules = null;
    this.db = null;
    this.engine = null;
    this.config = null;
    this.configDiagnostics = null;
    this.logs = [];
    this.queue = Promise.resolve();
  }

  async close() {
    if (this.db && this.modules?.closeLcmConnection) {
      this.modules.closeLcmConnection(this.db);
    }
    this.db = null;
    this.engine = null;
  }

  async exclusive(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async loadModules() {
    if (this.modules) return this.modules;
    const [
      { createLcmDatabaseConnection, closeLcmConnection },
      { resolveLcmConfigWithDiagnostics },
      { LcmContextEngine },
      { createLcmDatabaseBackup },
      { getDoctorSummaryStats },
    ] = await Promise.all([
      import(moduleUrl(this.lcmRoot, "src/db/connection.ts")),
      import(moduleUrl(this.lcmRoot, "src/db/config.ts")),
      import(moduleUrl(this.lcmRoot, "src/engine.ts")),
      import(moduleUrl(this.lcmRoot, "src/plugin/lcm-db-backup.ts")),
      import(moduleUrl(this.lcmRoot, "src/plugin/lcm-doctor-shared.ts")),
    ]);
    this.modules = {
      createLcmDatabaseConnection,
      closeLcmConnection,
      resolveLcmConfigWithDiagnostics,
      LcmContextEngine,
      createLcmDatabaseBackup,
      getDoctorSummaryStats,
    };
    return this.modules;
  }

  async ready() {
    const modules = await this.loadModules();
    if (this.engine && this.db) {
      return {
        modules,
        db: this.db,
        engine: this.engine,
        config: this.config,
        diagnostics: this.configDiagnostics,
      };
    }

    mkdirSync(dirname(this.dbPath), { recursive: true });
    mkdirSync(this.largeFilesDir, { recursive: true });

    const envForConfig = {
      ...process.env,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR || this.stateDir,
      LCM_DATABASE_PATH: this.dbPath,
      LCM_LARGE_FILES_DIR: this.largeFilesDir,
    };
    const { config, diagnostics } = modules.resolveLcmConfigWithDiagnostics(envForConfig, {});
    const db = modules.createLcmDatabaseConnection(this.dbPath);
    const engine = new modules.LcmContextEngine(
      {
        config,
        configDiagnostics: diagnostics,
        log: createLogSink(this.logs),
        resolveSessionIdFromSessionKey: async (sessionKey) => {
          if (typeof sessionKey === "string" && sessionKey.startsWith("beep:pi:")) {
            return lcmSessionIdForRuntimeSession(sessionKey.slice("beep:pi:".length));
          }
          return undefined;
        },
      },
      db,
    );

    this.config = config;
    this.configDiagnostics = diagnostics;
    this.db = db;
    this.engine = engine;
    return { modules, db, engine, config, diagnostics };
  }

  logTail(startIndex = 0, limit = 40) {
    return this.logs.slice(startIndex).slice(-limit);
  }

  buildSessionSummary(transcript, sessionPath, fromMessageCount, selectedEntries) {
    return {
      path: sessionPath,
      rawLines: transcript.records.length,
      parseErrors: transcript.parseErrors.length,
      totalMessageEntries: transcript.messageEntries.length,
      fromMessageEntry: fromMessageCount,
      selectedMessageEntries: selectedEntries.length,
      nextMessageEntryCount: transcript.messageEntries.length,
      header: transcript.sessionHeader
        ? {
            id: transcript.sessionHeader.id,
            cwd: transcript.sessionHeader.cwd,
            timestamp: transcript.sessionHeader.timestamp,
          }
        : null,
      model: transcript.latestModel,
      thinking: transcript.latestThinking,
    };
  }

  async ingestPiSession({
    sessionPath,
    workspacePath,
    runtimeSessionId,
    proofDir,
    fromMessageCount = 0,
    compact = null,
    assemble = null,
  }) {
    if (!sessionPath || !existsSync(sessionPath)) {
      throw new Error(`Pi session file does not exist: ${sessionPath}`);
    }
    const selectedFromMessageCount = Math.max(0, Number.parseInt(String(fromMessageCount || 0), 10) || 0);
    const transcript = extractPiSessionTranscript(sessionPath);
    const selectedEntries = transcript.messageEntries.slice(selectedFromMessageCount);
    const messages = canonicalMessagesFromEntries(selectedEntries);
    const allMessages = canonicalMessagesFromEntries(transcript.messageEntries);
    const sessionId = lcmSessionIdForRuntimeSession(runtimeSessionId);
    const sessionKey = lcmSessionKeyForRuntimeSession(runtimeSessionId);
    const logStart = this.logs.length;

    return this.exclusive(async () => {
      const { db, engine } = await this.ready();
      const beforeCounts = rowCounts(db);
      const ingestResult = messages.length > 0
        ? await engine.ingestBatch({ sessionId, sessionKey, messages })
        : { ingestedCount: 0 };

      let compactResult = null;
      if (compact) {
        compactResult = await engine.compact({
          sessionId,
          sessionKey,
          sessionFile: sessionPath,
          tokenBudget: normalizePositiveInteger(compact.tokenBudget, 2048),
          currentTokenCount: normalizeOptionalNumber(compact.currentTokenCount),
          compactionTarget: compact.compactionTarget || "threshold",
          force: compact.force === true,
          runtimeContext: compact.runtimeContext,
          legacyParams: compact.legacyParams,
          customInstructions: compact.customInstructions,
        });
      }

      let assembleResult = null;
      if (assemble) {
        assembleResult = await engine.assemble({
          sessionId,
          sessionKey,
          messages: allMessages,
          tokenBudget: normalizePositiveInteger(assemble.tokenBudget, 2048),
          prompt: assemble.prompt || "Assemble Beep runtime context from this Pi transcript.",
        });
      }

      const afterCounts = rowCounts(db);
      return {
        ok: transcript.parseErrors.length === 0,
        mode: "pi-session",
        dbPath: this.dbPath,
        lcmRoot: this.lcmRoot,
        session: this.buildSessionSummary(transcript, sessionPath, selectedFromMessageCount, selectedEntries),
        conversation: {
          sessionId,
          sessionKey,
        },
        ingest: {
          ingestedMessages: ingestResult.ingestedCount,
          skippedAsAlreadyCheckpointed: selectedEntries.length === 0,
          canonical: summarizeCanonicalMessages(messages),
          allCanonical: summarizeCanonicalMessages(allMessages),
        },
        compaction: compactResult,
        assemble: assembleResult ? this.serializeAssembleResult(assembleResult, true) : null,
        rowCounts: {
          before: beforeCounts,
          after: afterCounts,
          delta: Object.fromEntries(
            Object.keys(afterCounts).map((key) => [key, afterCounts[key] - (beforeCounts[key] ?? 0)]),
          ),
        },
        proof: {
          proofDir: proofDir || dirname(sessionPath),
          workspace: workspacePath,
          sessionSha256: sha256(transcript.records.map((record) => record.line).join("\n")),
        },
        lcmLogTail: this.logTail(logStart),
      };
    });
  }

  serializeAssembleResult(result, includeMessages = true) {
    return {
      messageCount: result.messages.length,
      estimatedTokens: result.estimatedTokens,
      contextProjection: result.contextProjection ?? null,
      ...(result.systemPromptAddition ? { systemPromptAddition: result.systemPromptAddition } : {}),
      ...(includeMessages ? { messages: result.messages } : {}),
    };
  }

  conversationStats(db, sessionId, sessionKey) {
    let conversation = null;
    if (sessionKey) {
      conversation = db
        .prepare(
          `SELECT conversation_id AS conversationId,
                  session_id AS sessionId,
                  session_key AS sessionKey,
                  active,
                  title,
                  archived_at AS archivedAt,
                  bootstrapped_at AS bootstrappedAt,
                  created_at AS createdAt,
                  updated_at AS updatedAt
             FROM conversations
            WHERE session_key = ?
            ORDER BY active DESC, updated_at DESC
            LIMIT 1`,
        )
        .get(sessionKey);
    }
    if (!conversation && sessionId) {
      conversation = db
        .prepare(
          `SELECT conversation_id AS conversationId,
                  session_id AS sessionId,
                  session_key AS sessionKey,
                  active,
                  title,
                  archived_at AS archivedAt,
                  bootstrapped_at AS bootstrappedAt,
                  created_at AS createdAt,
                  updated_at AS updatedAt
             FROM conversations
            WHERE session_id = ?
            ORDER BY active DESC, updated_at DESC
            LIMIT 1`,
        )
        .get(sessionId);
    }
    if (!conversation) return null;

    const conversationId = Number(conversation.conversationId);
    const summaryKinds = tableExists(db, "summaries")
      ? db
          .prepare(
            `SELECT kind, COUNT(*) AS count
               FROM summaries
              WHERE conversation_id = ?
              GROUP BY kind`,
          )
          .all(conversationId)
      : [];
    const contextKinds = tableExists(db, "context_items")
      ? db
          .prepare(
            `SELECT item_type AS itemType, COUNT(*) AS count
               FROM context_items
              WHERE conversation_id = ?
              GROUP BY item_type`,
          )
          .all(conversationId)
      : [];
    const maintenance = tableExists(db, "conversation_compaction_maintenance")
      ? db.prepare("SELECT * FROM conversation_compaction_maintenance WHERE conversation_id = ?").get(conversationId) ?? null
      : null;
    const telemetry = tableExists(db, "conversation_compaction_telemetry")
      ? db.prepare("SELECT * FROM conversation_compaction_telemetry WHERE conversation_id = ?").get(conversationId) ?? null
      : null;

    return {
      ...conversation,
      active: conversation.active === 1,
      conversationId,
      messages: tableCountWhere(db, "messages", "conversation_id = ?", [conversationId]),
      messageParts: tableCountWhere(db, "message_parts", "message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)", [conversationId]),
      summaries: tableCountWhere(db, "summaries", "conversation_id = ?", [conversationId]),
      summaryKinds: Object.fromEntries(summaryKinds.map((row) => [row.kind || "unknown", Number(row.count || 0)])),
      contextItems: tableCountWhere(db, "context_items", "conversation_id = ?", [conversationId]),
      contextItemKinds: Object.fromEntries(contextKinds.map((row) => [row.itemType || "unknown", Number(row.count || 0)])),
      messageTokens: tableSum(db, "messages", "token_count", "WHERE conversation_id = ?", [conversationId]),
      summaryTokens: tableSum(db, "summaries", "token_count", "WHERE conversation_id = ?", [conversationId]),
      summarizedSourceTokens: tableSum(db, "summaries", "source_message_token_count", "WHERE conversation_id = ?", [conversationId]),
      maintenance,
      telemetry,
    };
  }

  async status({ sessionId, sessionKey } = {}) {
    return this.exclusive(async () => {
      const { db, config, diagnostics } = await this.ready();
      const counts = rowCounts(db);
      const conversations = tableExists(db, "conversations")
        ? db
            .prepare(
              `SELECT conversation_id AS conversationId,
                      session_id AS sessionId,
                      session_key AS sessionKey,
                      active,
                      title,
                      archived_at AS archivedAt,
                      created_at AS createdAt,
                      updated_at AS updatedAt
                 FROM conversations
                ORDER BY active DESC, updated_at DESC
                LIMIT 20`,
            )
            .all()
            .map((conversation) => ({
              ...conversation,
              active: conversation.active === 1,
              conversationId: Number(conversation.conversationId),
            }))
        : [];
      return {
        ok: true,
        dbPath: this.dbPath,
        lcmRoot: this.lcmRoot,
        dbSizeBytes: safeStatSize(this.dbPath),
        rowCounts: counts,
        totals: {
          messageTokens: tableSum(db, "messages", "token_count"),
          summaryTokens: tableSum(db, "summaries", "token_count"),
          summarizedSourceTokens: tableSum(db, "summaries", "source_message_token_count"),
        },
        current: sessionId || sessionKey ? this.conversationStats(db, sessionId, sessionKey) : null,
        conversations,
        config: {
          databasePath: config.databasePath,
          largeFilesDir: config.largeFilesDir,
          freshTailCount: config.freshTailCount,
          freshTailMaxTokens: config.freshTailMaxTokens,
          leafChunkTokens: config.leafChunkTokens,
          leafTargetTokens: config.leafTargetTokens,
          condensedTargetTokens: config.condensedTargetTokens,
          proactiveThresholdCompactionMode: config.proactiveThresholdCompactionMode,
          transcriptGcEnabled: config.transcriptGcEnabled,
        },
        configDiagnostics: diagnostics,
        lcmLogTail: this.logTail(Math.max(0, this.logs.length - 40)),
      };
    });
  }

  async compact({ sessionId, sessionKey, sessionFile, tokenBudget, currentTokenCount, compactionTarget, force, customInstructions }) {
    return this.exclusive(async () => {
      const { db, engine } = await this.ready();
      const beforeCounts = rowCounts(db);
      const logStart = this.logs.length;
      const result = await engine.compact({
        sessionId,
        sessionKey,
        sessionFile,
        tokenBudget: normalizePositiveInteger(tokenBudget, 128_000),
        currentTokenCount: normalizeOptionalNumber(currentTokenCount),
        compactionTarget: compactionTarget || "threshold",
        force: force === true,
        customInstructions,
      });
      const afterCounts = rowCounts(db);
      return {
        ok: result.ok,
        result,
        rowCounts: {
          before: beforeCounts,
          after: afterCounts,
          delta: Object.fromEntries(
            Object.keys(afterCounts).map((key) => [key, afterCounts[key] - (beforeCounts[key] ?? 0)]),
          ),
        },
        lcmLogTail: this.logTail(logStart),
      };
    });
  }

  async assemblePreview({ sessionId, sessionKey, sessionPath, tokenBudget, prompt, includeMessages = true }) {
    const transcript = extractPiSessionTranscript(sessionPath);
    const messages = canonicalMessagesFromEntries(transcript.messageEntries);
    return this.exclusive(async () => {
      const { engine } = await this.ready();
      const logStart = this.logs.length;
      const result = await engine.assemble({
        sessionId,
        sessionKey,
        messages,
        tokenBudget: normalizePositiveInteger(tokenBudget, 128_000),
        prompt: prompt || "Preview Beep's next-turn LCM context projection.",
      });
      return {
        ok: true,
        source: this.buildSessionSummary(transcript, sessionPath, 0, transcript.messageEntries),
        assemble: this.serializeAssembleResult(result, includeMessages),
        lcmLogTail: this.logTail(logStart),
      };
    });
  }

  async assembleMessages({
    sessionId,
    sessionKey,
    messages,
    tokenBudget,
    prompt,
    includeMessages = true,
    externalMemoryHints = null,
  }) {
    if (!sessionId) {
      throw new Error("LCM assemble requires a sessionId.");
    }
    if (!Array.isArray(messages)) {
      throw new Error("LCM assemble requires a messages array.");
    }

    const canonicalMessages = cloneJson(messages);
    const messagesForAssembly = messagesWithExternalMemoryHints(canonicalMessages, externalMemoryHints);
    return this.exclusive(async () => {
      const { engine } = await this.ready();
      const logStart = this.logs.length;
      const result = await engine.assemble({
        sessionId,
        sessionKey,
        messages: messagesForAssembly,
        tokenBudget: normalizePositiveInteger(tokenBudget, 128_000),
        prompt: prompt || "Assemble Beep's next-turn LCM context projection.",
      });
      return {
        ok: true,
        source: {
          mode: "live-pi-context",
          inputMessageCount: canonicalMessages.length,
          assemblyInputMessageCount: messagesForAssembly.length,
          externalMemoryHints: externalMemoryHints
            ? {
                source: externalMemoryHints.source,
                bankId: externalMemoryHints.bankId,
                memoryCount: Array.isArray(externalMemoryHints.memories) ? externalMemoryHints.memories.length : 0,
                persist: externalMemoryHints.persist === true,
                stripOnRetain: externalMemoryHints.stripOnRetain === true,
              }
            : null,
          canonical: summarizeCanonicalMessages(canonicalMessages),
        },
        assemble: this.serializeAssembleResult(result, includeMessages),
        lcmLogTail: this.logTail(logStart),
      };
    });
  }

  async maintain({ sessionId, sessionKey, sessionFile, runtimeContext = {} }) {
    return this.exclusive(async () => {
      const { db, engine } = await this.ready();
      const beforeCounts = rowCounts(db);
      const logStart = this.logs.length;
      const result = await engine.maintain({
        sessionId,
        sessionKey,
        sessionFile,
        runtimeContext,
      });
      const afterCounts = rowCounts(db);
      return {
        ok: true,
        result,
        rowCounts: {
          before: beforeCounts,
          after: afterCounts,
          delta: Object.fromEntries(
            Object.keys(afterCounts).map((key) => [key, afterCounts[key] - (beforeCounts[key] ?? 0)]),
          ),
        },
        lcmLogTail: this.logTail(logStart),
      };
    });
  }

  async rotate({ sessionId, sessionKey, sessionFile, lockTimeoutMs = 30_000 }) {
    return this.exclusive(async () => {
      const { db, engine } = await this.ready();
      const beforeCounts = rowCounts(db);
      const logStart = this.logs.length;
      const result = await engine.rotateSessionStorageWithBackup({
        sessionId,
        sessionKey,
        sessionFile,
        lockTimeoutMs: normalizePositiveInteger(lockTimeoutMs, 30_000),
      });
      const afterCounts = rowCounts(db);
      return {
        ok: result.kind === "rotated",
        result,
        rowCounts: {
          before: beforeCounts,
          after: afterCounts,
          delta: Object.fromEntries(
            Object.keys(afterCounts).map((key) => [key, afterCounts[key] - (beforeCounts[key] ?? 0)]),
          ),
        },
        lcmLogTail: this.logTail(logStart),
      };
    });
  }

  async backup({ label = "backup", replaceLatest = false } = {}) {
    return this.exclusive(async () => {
      const { modules, db } = await this.ready();
      const backupPath = modules.createLcmDatabaseBackup(db, {
        databasePath: this.dbPath,
        label,
        replaceLatest,
      });
      return {
        ok: Boolean(backupPath),
        backupPath,
        dbPath: this.dbPath,
      };
    });
  }

  async doctor({ sessionId, sessionKey } = {}) {
    return this.exclusive(async () => {
      const { modules, db } = await this.ready();
      const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check || Object.values(row)[0]);
      const quick = db.prepare("PRAGMA quick_check").all().map((row) => row.quick_check || Object.values(row)[0]);
      const current = sessionId || sessionKey ? this.conversationStats(db, sessionId, sessionKey) : null;
      const doctorStats = modules.getDoctorSummaryStats(db, current?.conversationId);
      return {
        ok: integrity.length === 1 && integrity[0] === "ok" && quick.length === 1 && quick[0] === "ok",
        dbPath: this.dbPath,
        integrity,
        quick,
        summaryMarkers: serializeDoctorStats(doctorStats),
        current,
      };
    });
  }
}

function tableCountWhere(db, table, where, args = []) {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...args);
  return Number(row?.count ?? 0);
}

export function writeLcmSummaryFile(path, summary) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(summary)}\n`);
  return summary;
}

export const defaultLcmService = new LcmService();
