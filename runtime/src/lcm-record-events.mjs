import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [format, eventsPath, workspacePath, runId, outputPath, proofDirArg] = process.argv.slice(2);

if (!format || !eventsPath || !workspacePath || !runId || !outputPath) {
  console.error(
    "usage: lcm-record-events.mjs <pi|codex> <events.jsonl> <workspace> <run-id> <output.json> [proof-dir]",
  );
  process.exit(64);
}

if (!["pi", "codex"].includes(format)) {
  console.error(`unsupported LCM event format: ${format}`);
  process.exit(64);
}

const thisFile = fileURLToPath(import.meta.url);
const defaultLcmRoot = join(dirname(thisFile), "../../vendor/lossless-claw");
const lcmRoot = process.env.BEEP_LCM_ROOT || (existsSync(defaultLcmRoot) ? defaultLcmRoot : "/opt/lossless-claw");
const dbPath = process.env.BEEP_LCM_DB || join(process.env.BEEP_LCM_DIR || "/lcm", "beep-lcm.sqlite");
const proofDir = proofDirArg || dirname(eventsPath);

function moduleUrl(relativePath) {
  return pathToFileURL(join(lcmRoot, relativePath)).href;
}

const [{ createLcmDatabaseConnection, closeLcmConnection }, { runLcmMigrations }, { ConversationStore }] =
  await Promise.all([
    import(moduleUrl("src/db/connection.ts")),
    import(moduleUrl("src/db/migration.ts")),
    import(moduleUrl("src/store/conversation-store.ts")),
  ]);

function readJsonl(path) {
  if (!existsSync(path)) {
    throw new Error(`events file does not exist: ${path}`);
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line.length > 0)
    .map((entry) => {
      try {
        return {
          index: entry.index,
          raw: entry.line,
          event: JSON.parse(entry.line),
          parseError: null,
        };
      } catch (error) {
        return {
          index: entry.index,
          raw: entry.line,
          event: { type: "parse_error", message: error.message },
          parseError: error.message,
        };
      }
    });
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      if (part.type === "text") {
        return part.text || "";
      }
      if (part.type === "thinking") {
        return part.thinking ? `[thinking] ${part.thinking}` : "[thinking]";
      }
      if (part.type === "toolCall") {
        return `[tool:${part.name || "unknown"}] ${stableJson(part.arguments ?? {})}`;
      }
      return `[${part.type || "part"}] ${stableJson(part)}`;
    })
    .filter(Boolean)
    .join("\n");
}

function truncate(text, max = 8_000) {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function piRole(event) {
  const messageRole = event.message?.role;
  if (messageRole === "user" || messageRole === "assistant") {
    return messageRole;
  }
  if (messageRole === "toolResult" || event.type?.startsWith("tool_execution")) {
    return "tool";
  }
  return "system";
}

function codexRole(event) {
  const itemType = event.item?.type;
  if (itemType === "agent_message") {
    return "assistant";
  }
  if (itemType === "command_execution" || itemType === "file_change") {
    return "tool";
  }
  return "system";
}

function piPartType(event) {
  if (event.type === "turn_start") return "step_start";
  if (event.type === "turn_end" || event.type === "agent_end") return "step_finish";
  if (event.type === "agent_start" || event.type === "session") return "agent";
  if (event.type?.startsWith("tool_execution")) return "tool";
  const parts = event.message?.content;
  if (Array.isArray(parts) && parts.some((part) => part?.type === "thinking")) return "reasoning";
  return "text";
}

function codexPartType(event) {
  if (event.type === "turn.started") return "step_start";
  if (event.type === "turn.completed") return "step_finish";
  if (event.type === "thread.started") return "agent";
  if (event.item?.type === "command_execution") return "tool";
  if (event.item?.type === "file_change") return "patch";
  return "text";
}

function formatPiEvent(event) {
  if (event.type === "session") {
    return `Pi session ${event.id || "unknown"} cwd=${event.cwd || "unknown"}`;
  }
  if (event.type === "agent_start") {
    return "Pi agent started";
  }
  if (event.type === "agent_end") {
    return "Pi agent ended";
  }
  if (event.type === "turn_start") {
    return "Pi turn started";
  }
  if (event.type === "turn_end") {
    const stopReason = event.message?.stopReason ? ` stopReason=${event.message.stopReason}` : "";
    return `Pi turn ended${stopReason}`;
  }
  if (event.type?.startsWith("message_")) {
    const role = event.message?.role || "unknown";
    const body = textFromContent(event.message?.content);
    return truncate(`Pi ${event.type} ${role}\n${body}`.trim());
  }
  if (event.type?.startsWith("tool_execution")) {
    const args = event.args === undefined ? "" : ` args=${stableJson(event.args)}`;
    const result = event.result === undefined ? "" : ` result=${stableJson(event.result)}`;
    return truncate(`Pi ${event.type} ${event.toolName || "tool"} id=${event.toolCallId || "unknown"}${args}${result}`);
  }
  return truncate(`Pi ${event.type || "event"}\n${stableJson(event)}`);
}

function formatCodexEvent(event) {
  if (event.type === "thread.started") {
    return `Codex thread started ${event.thread_id || "unknown"}`;
  }
  if (event.type === "turn.started") {
    return "Codex turn started";
  }
  if (event.type === "turn.completed") {
    return `Codex turn completed\nusage=${stableJson(event.usage ?? {})}`;
  }
  if (event.type === "item.started" || event.type === "item.completed") {
    const item = event.item || {};
    if (item.type === "agent_message") {
      return truncate(`Codex agent message\n${item.text || ""}`);
    }
    if (item.type === "command_execution") {
      return truncate(
        [
          `Codex command ${item.status || event.type} exit=${item.exit_code ?? "pending"}`,
          item.command || "",
          item.aggregated_output || "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    if (item.type === "file_change") {
      return truncate(`Codex file change ${item.status || event.type}\n${stableJson(item.changes ?? [])}`);
    }
  }
  return truncate(`Codex ${event.type || "event"}\n${stableJson(event)}`);
}

function roleFor(event) {
  return format === "pi" ? piRole(event) : codexRole(event);
}

function partTypeFor(event) {
  return format === "pi" ? piPartType(event) : codexPartType(event);
}

function contentFor(event) {
  return format === "pi" ? formatPiEvent(event) : formatCodexEvent(event);
}

function collectStats(records) {
  const byType = {};
  const byRole = {};
  let parseErrors = 0;
  for (const record of records) {
    const type = record.event.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
    const role = roleFor(record.event);
    byRole[role] = (byRole[role] || 0) + 1;
    if (record.parseError) {
      parseErrors += 1;
    }
  }
  return { byType, byRole, parseErrors };
}

const records = readJsonl(eventsPath);
const stats = collectStats(records);
const db = createLcmDatabaseConnection(dbPath);
let summary;

try {
  runLcmMigrations(db, { log: { info: () => {} } });
  const store = new ConversationStore(db, { fts5Available: true });
  const sessionId = `beep-${format}-${runId}`;
  const sessionKey = `beep:${format}:${runId}`;
  const conversation = await store.getOrCreateConversation(sessionId, {
    sessionKey,
    title: `Beep ${format.toUpperCase()} run ${runId}`,
  });
  const lastMessage = await store.getLastMessage(conversation.conversationId);
  let nextSeq = (lastMessage?.seq ?? -1) + 1;

  await store.withTransaction(async () => {
    const metadataContent = [
      `Beep LCM ingest metadata`,
      `format=${format}`,
      `run_id=${runId}`,
      `events_path=${eventsPath}`,
      `workspace=${workspacePath}`,
      `proof_dir=${proofDir}`,
      `raw_events=${records.length}`,
      `raw_sha256=${sha256(records.map((record) => record.raw).join("\n"))}`,
    ].join("\n");
    const metadataMessage = await store.createMessage({
      conversationId: conversation.conversationId,
      seq: nextSeq,
      role: "system",
      content: metadataContent,
      tokenCount: estimateTokens(metadataContent),
      skipReplayTimestampFloodGuard: true,
    });
    await store.createMessageParts(metadataMessage.messageId, [
      {
        sessionId,
        partType: "snapshot",
        ordinal: 0,
        textContent: metadataContent,
        metadata: stableJson({ kind: "beep_lcm_ingest_metadata", format, runId, proofDir, workspacePath }),
      },
    ]);
    nextSeq += 1;

    for (const record of records) {
      const event = record.event;
      const rawHash = sha256(record.raw);
      const content = contentFor(event);
      const message = await store.createMessage({
        conversationId: conversation.conversationId,
        seq: nextSeq,
        role: roleFor(event),
        content,
        tokenCount: estimateTokens(`${content}\n${record.raw}`),
        skipReplayTimestampFloodGuard: true,
      });
      await store.createMessageParts(message.messageId, [
        {
          sessionId,
          partType: partTypeFor(event),
          ordinal: 0,
          textContent: content,
          toolCallId: event.toolCallId ?? event.item?.id ?? null,
          toolName: event.toolName ?? event.item?.type ?? null,
          toolInput: event.args === undefined ? null : stableJson(event.args),
          toolOutput: event.result === undefined ? event.item?.aggregated_output ?? null : stableJson(event.result),
          metadata: stableJson({
            eventIndex: record.index,
            eventType: event.type || "unknown",
            rawSha256: rawHash,
            parseError: record.parseError,
          }),
        },
        {
          sessionId,
          partType: "snapshot",
          ordinal: 1,
          textContent: record.raw,
          metadata: stableJson({
            eventIndex: record.index,
            eventType: event.type || "unknown",
            rawSha256: rawHash,
            raw: true,
          }),
        },
      ]);
      nextSeq += 1;
    }
  });

  const rowCounts = Object.fromEntries(
    ["conversations", "messages", "message_parts", "summaries"].map((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return [table, Number(row?.count ?? 0)];
    }),
  );

  summary = {
    ok: stats.parseErrors === 0,
    dbPath,
    lcmRoot,
    conversation: {
      conversationId: conversation.conversationId,
      sessionId,
      sessionKey,
      title: conversation.title,
      appendedMessages: records.length + 1,
      firstSeq: (lastMessage?.seq ?? -1) + 1,
      lastSeq: nextSeq - 1,
    },
    events: {
      format,
      path: eventsPath,
      total: records.length,
      ...stats,
    },
    rowCounts,
  };
} finally {
  closeLcmConnection(db);
}

writeFileSync(outputPath, `${stableJson(summary)}\n`);
console.log(stableJson(summary));
