import { join } from "node:path";
import {
  defaultLcmService,
  lcmSessionIdForRuntimeSession,
  lcmSessionKeyForRuntimeSession,
  writeLcmSummaryFile,
} from "./lcm-service.mjs";
import { LCM_CONTEXT_TOKEN_BUDGET, nowIso, parseJsonl, readJsonFile, summarizeEvents, writeJsonFile } from "./runtime-common.mjs";

function currentTokenCountFromUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.input || 0);
  const cacheRead = Number(usage.cacheRead || 0);
  const cacheWrite = Number(usage.cacheWrite || 0);
  const total = input + cacheRead + cacheWrite;
  return Number.isFinite(total) && total > 0 ? Math.floor(total) : undefined;
}

export class LcmController {
  constructor(service = defaultLcmService) {
    this.service = service;
  }

  identityForRuntimeSession(runtimeSessionId) {
    return {
      sessionId: lcmSessionIdForRuntimeSession(runtimeSessionId),
      sessionKey: lcmSessionKeyForRuntimeSession(runtimeSessionId),
    };
  }

  async recordPiSession(session, { force = false } = {}) {
    const checkpointPath = join(session.rootDir, "lcm-checkpoint.json");
    const checkpoint = force ? { messageEntryCount: 0 } : readJsonFile(checkpointPath, { messageEntryCount: 0 });
    const { sessionFile, sessionStats, eventLineCount } = await session.resolvePiSessionFile();
    const checkpointSessionFile = typeof checkpoint?.sessionFile === "string" ? checkpoint.sessionFile : null;
    const fromMessageCount =
      !force && checkpointSessionFile === sessionFile
        ? Math.max(0, Number(checkpoint?.messageEntryCount || 0))
        : 0;
    const eventSummary = summarizeEvents(parseJsonl(session.eventsPath));
    const lastUsage = eventSummary.lastUsage || null;
    const summary = await this.service.ingestPiSession({
      sessionPath: sessionFile,
      workspacePath: session.workspace,
      runtimeSessionId: session.id,
      proofDir: session.rootDir,
      fromMessageCount,
      tokenBudget: LCM_CONTEXT_TOKEN_BUDGET,
      currentTokenCount: currentTokenCountFromUsage(lastUsage),
      usage: lastUsage,
      sessionStats,
      runtimeContext: {
        source: "beep-agentd",
        requestCount: session.agentEndCount,
        eventLineCount,
      },
    });

    writeLcmSummaryFile(session.lcmSummaryPath, summary);
    writeJsonFile(checkpointPath, {
      messageEntryCount: Number(summary?.session?.nextMessageEntryCount ?? fromMessageCount),
      sessionFile,
      eventLineCount,
      updatedAt: nowIso(),
      latestSessionStats: sessionStats,
      latestSummary: summary,
    });
    session.writeSummary();
    return summary;
  }

  async currentSessionContext(session) {
    const resolved = await session.resolvePiSessionFile();
    return {
      session,
      ...resolved,
      ...this.identityForRuntimeSession(session.id),
    };
  }

  async statusForRuntimeSession(runtimeSessionId) {
    return this.service.status(this.identityForRuntimeSession(runtimeSessionId));
  }

  async compactForSession(session, options = {}) {
    const context = await this.currentSessionContext(session);
    return this.service.compact({
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

  async assemblePreviewForSession(session, options = {}) {
    const context = await this.currentSessionContext(session);
    return this.service.assemblePreview({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      sessionPath: context.sessionFile,
      tokenBudget: options.tokenBudget,
      prompt: options.prompt,
      includeMessages: options.includeMessages !== false,
    });
  }

  async maintainForSession(session, options = {}) {
    const context = await this.currentSessionContext(session);
    return this.service.maintain({
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

  async rotateForSession(session, options = {}) {
    const context = await this.currentSessionContext(session);
    return this.service.rotate({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
      sessionFile: context.sessionFile,
      lockTimeoutMs: options.lockTimeoutMs,
    });
  }

  async backup(options = {}) {
    return this.service.backup({
      label: options.label || "backup",
      replaceLatest: Boolean(options.replaceLatest),
    });
  }

  async doctorForRuntimeSession(runtimeSessionId) {
    return this.service.doctor(this.identityForRuntimeSession(runtimeSessionId));
  }

  async assembleLiveMessages({ runtimeSessionId, messages, tokenBudget, prompt, includeMessages = true }) {
    const identity = this.identityForRuntimeSession(runtimeSessionId);
    return this.service.assembleMessages({
      ...identity,
      messages,
      tokenBudget,
      prompt,
      includeMessages,
    });
  }

  async callRecallTool({ runtimeSessionId, toolName, params, expansionGrant, delegateExpandQuery }) {
    const identity = this.identityForRuntimeSession(runtimeSessionId);
    return this.service.callRecallTool({
      ...identity,
      toolName,
      params,
      expansionGrant,
      delegateExpandQuery,
    });
  }

  async handleBeforeReset({ runtimeSessionId, reason }) {
    const identity = this.identityForRuntimeSession(runtimeSessionId);
    return this.service.handleBeforeReset({
      ...identity,
      reason,
    });
  }

  async handleSessionEnd({ runtimeSessionId, reason, nextRuntimeSessionId }) {
    const identity = this.identityForRuntimeSession(runtimeSessionId);
    const nextIdentity = nextRuntimeSessionId ? this.identityForRuntimeSession(nextRuntimeSessionId) : {};
    return this.service.handleSessionEnd({
      ...identity,
      reason,
      nextSessionId: nextIdentity.sessionId,
      nextSessionKey: nextIdentity.sessionKey,
    });
  }

  async close() {
    await this.service.close();
  }
}
