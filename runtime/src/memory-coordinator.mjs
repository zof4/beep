import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalMessagesFromEntries,
  extractPiSessionTranscript,
  textFromContent,
} from "./lcm-service.mjs";
import { buildExternalMemoryHints, cleanRetainText } from "./external-memory-hints.mjs";
import { defaultHindsightService, deriveHindsightBankId } from "./hindsight-service.mjs";

function tagSegment(value, fallback) {
  return String(value || fallback || "default").replace(/[^A-Za-z0-9._:-]+/g, "-");
}

function ensureFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
}

export function hindsightTags(config) {
  return [
    `deployment:${tagSegment(config.deploymentId, "local")}`,
    `user:${tagSegment(config.userId, "default-user")}`,
    `project:${tagSegment(config.projectId, "beep2")}`,
  ];
}

function recentText(messages, limit = 6) {
  return messages
    .slice(-limit)
    .map((message) => `${message.role}: ${textFromContent(message.content)}`)
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

export function buildRecallQuery({ prompt, messages }) {
  return [
    "Recall durable BeepBot memory relevant to the next agent action.",
    prompt ? `Latest prompt: ${prompt}` : "",
    "Recent live context:",
    recentText(Array.isArray(messages) ? messages : []),
  ]
    .filter(Boolean)
    .join("\n");
}

function retainContentFromMessages(messages) {
  return messages
    .map((message) => `${message.role}: ${cleanRetainText(textFromContent(message.content))}`)
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

export class MemoryCoordinator {
  constructor({ hindsightService = defaultHindsightService, now = () => new Date().toISOString() } = {}) {
    this.hindsightService = hindsightService;
    this.now = now;
  }

  async recallForContext({ runtimeSessionId, prompt, messages }) {
    const config = this.hindsightService.config;
    if (!config?.enabled) {
      return {
        ok: true,
        enabled: false,
        externalMemoryHints: null,
        telemetry: { kind: "hindsight_recall", enabled: false },
      };
    }
    const bankId = deriveHindsightBankId(config, { runtimeSessionId });
    const tags = hindsightTags(config);
    const query = buildRecallQuery({ prompt, messages });
    try {
      const recall = await this.hindsightService.recall({ bankId, query, tags });
      const externalMemoryHints = buildExternalMemoryHints({
        bankId,
        query,
        tags,
        generatedAt: this.now(),
        tokenBudget: config.recallMaxTokens,
        recall,
      });
      return {
        ok: true,
        enabled: true,
        externalMemoryHints,
        telemetry: {
          kind: "hindsight_recall",
          ok: true,
          bankId,
          memoryCount: externalMemoryHints.memories.length,
          tags,
        },
      };
    } catch (error) {
      return {
        ok: false,
        enabled: true,
        externalMemoryHints: null,
        error: error instanceof Error ? error.message : String(error),
        telemetry: {
          kind: "hindsight_recall",
          ok: false,
          bankId,
          tags,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  appendRetainFailure(queuePath, entry) {
    ensureFile(queuePath);
    appendFileSync(queuePath, `${JSON.stringify(entry)}\n`);
  }

  async retainPiSessionSpan({
    runtimeSessionId,
    requestId,
    sessionPath,
    fromMessageEntry,
    nextMessageEntryCount,
    queuePath,
  }) {
    const config = this.hindsightService.config;
    ensureFile(queuePath);
    if (!config?.enabled) {
      return { ok: true, enabled: false, retained: false };
    }
    const transcript = extractPiSessionTranscript(sessionPath);
    const selectedEntries = transcript.messageEntries.slice(fromMessageEntry, nextMessageEntryCount);
    const messages = canonicalMessagesFromEntries(selectedEntries);
    const content = retainContentFromMessages(messages);
    if (!content) {
      return { ok: true, enabled: true, retained: false, reason: "empty_content" };
    }
    const bankId = deriveHindsightBankId(config, { runtimeSessionId });
    const documentId = `beep-pi:${runtimeSessionId}:${fromMessageEntry}:${nextMessageEntryCount}`;
    const tags = [...hindsightTags(config), `session:${tagSegment(runtimeSessionId, "session")}`, "source:beep-pi"];
    const item = {
      content,
      context: "Beep Pi agent completed turn source transcript",
      timestamp: this.now(),
      document_id: documentId,
      tags,
      metadata: {
        deploymentId: config.deploymentId,
        userId: config.userId,
        projectId: config.projectId,
        runtimeSessionId,
        requestId,
        sessionPath,
        fromMessageEntry,
        nextMessageEntryCount,
        source: "beep-pi",
      },
    };
    try {
      const retain = await this.hindsightService.retain({ bankId, items: [item] });
      return { ok: true, enabled: true, retained: true, bankId, documentId, retain };
    } catch (error) {
      const failure = {
        at: this.now(),
        bankId,
        documentId,
        item,
        error: error instanceof Error ? error.message : String(error),
      };
      this.appendRetainFailure(queuePath, failure);
      return { ok: false, enabled: true, retained: false, bankId, documentId, queued: true, error: failure.error };
    }
  }
}

export const defaultMemoryCoordinator = new MemoryCoordinator();
