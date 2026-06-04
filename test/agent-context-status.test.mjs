import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentContextStatus,
  calculateContextPressure,
} from "../runtime/src/agent-context-status.mjs";

test("calculateContextPressure returns unknown without arguments", () => {
  assert.deepEqual(calculateContextPressure(), {
    pressure: "unknown",
    remainingTokens: null,
    ratio: null,
  });
});

test("calculateContextPressure returns unknown without usable numbers", () => {
  assert.deepEqual(calculateContextPressure({ estimatedTokens: null, tokenBudget: 128000 }), {
    pressure: "unknown",
    remainingTokens: null,
    ratio: null,
  });
  assert.deepEqual(calculateContextPressure({ estimatedTokens: 100, tokenBudget: 0 }), {
    pressure: "unknown",
    remainingTokens: null,
    ratio: null,
  });
});

test("calculateContextPressure classifies pressure thresholds", () => {
  assert.deepEqual(calculateContextPressure({ estimatedTokens: 59, tokenBudget: 100 }), {
    pressure: "low",
    remainingTokens: 41,
    ratio: 0.59,
  });
  assert.deepEqual(calculateContextPressure({ estimatedTokens: 60, tokenBudget: 100 }), {
    pressure: "medium",
    remainingTokens: 40,
    ratio: 0.6,
  });
  assert.deepEqual(calculateContextPressure({ estimatedTokens: 80, tokenBudget: 100 }), {
    pressure: "high",
    remainingTokens: 20,
    ratio: 0.8,
  });
  assert.deepEqual(calculateContextPressure({ estimatedTokens: 95, tokenBudget: 100 }), {
    pressure: "critical",
    remainingTokens: 5,
    ratio: 0.95,
  });
});

test("calculateContextPressure normalizes fractional token counts and stable ratio precision", () => {
  assert.deepEqual(calculateContextPressure({ estimatedTokens: 1.8, tokenBudget: 3.2 }), {
    pressure: "medium",
    remainingTokens: 1,
    ratio: 0.6667,
  });
});

test("buildAgentContextStatus returns healthy sanitized context status", () => {
  const status = buildAgentContextStatus({
    nowIso: () => "2026-06-04T12:00:00.000Z",
    runtimeConfig: { provider: "openai-codex", model: "gpt-5.5", thinking: "low" },
    agentStatus: { id: "beep", queueDepth: 0, activeRequestId: null, lastError: null },
    sessionStatus: {
      phase: "idle",
      model: "gpt-5.5",
      thinking: "low",
      lastAssistantText: "SECRET_ASSISTANT_TEXT",
      lcmContextInjection: {
        enabled: true,
        total: 3,
        failures: 0,
        latest: {
          kind: "assemble",
          ok: true,
          at: "2026-06-04T11:59:00.000Z",
          tokenBudget: 1000,
          estimatedTokens: 250,
          inputMessageCount: 4,
          outputMessageCount: 5,
        },
      },
      hindsightMemory: {
        enabled: true,
        total: 2,
        failures: 0,
        history: [
          { kind: "hindsight_recall", ok: true, at: "2026-06-04T11:58:00.000Z", bankId: "beep:local:user:project" },
          { kind: "hindsight_retain", ok: true, at: "2026-06-04T11:59:30.000Z", documentId: "doc-1" },
        ],
      },
    },
    requests: {
      req_1: {
        id: "req_1",
        sequence: 1,
        status: "completed",
        message: "SECRET_USER_TEXT",
        completedAt: "2026-06-04T11:59:40.000Z",
        lcm: { ok: true },
        hindsight: { ok: true, enabled: true },
      },
    },
    lcmStatus: {
      ok: true,
      rowCounts: { conversations: 1, messages: 57, message_parts: 73, summaries: 2, context_items: 59, large_files: 0 },
      totals: { messageTokens: 13485, summaryTokens: 900, summarizedSourceTokens: 4200 },
    },
    lcmContextEnabled: true,
    lcmContextTokenBudget: 1000,
    hindsightConfigured: true,
  });

  assert.equal(status.ok, true);
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.time, "2026-06-04T12:00:00.000Z");
  assert.equal(status.agent.id, "beep");
  assert.equal(status.agent.phase, "idle");
  assert.equal(status.agent.lastCompletedRequestId, "req_1");
  assert.equal(status.model.model, "gpt-5.5");
  assert.equal(status.context.pressure, "low");
  assert.equal(status.context.remainingTokens, 750);
  assert.equal(status.lcm.available, true);
  assert.equal(status.lcm.messageCount, 57);
  assert.equal(status.lcm.summaryCount, 2);
  assert.equal(status.lcm.lastIngestOk, true);
  assert.equal(status.hindsight.available, true);
  assert.equal(status.hindsight.latestRetainOk, true);
  assert.equal(status.hindsight.latestRecallOk, true);
  assert.equal(status.webSearch.mode, "disabled");
  assert.deepEqual(status.warnings, []);

  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /SECRET_USER_TEXT/u);
  assert.doesNotMatch(serialized, /SECRET_ASSISTANT_TEXT/u);
});

test("buildAgentContextStatus emits degraded memory warnings without failing", () => {
  const status = buildAgentContextStatus({
    nowIso: () => "2026-06-04T12:00:00.000Z",
    runtimeConfig: { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
    agentStatus: { id: "beep", queueDepth: 1, activeRequestId: "req_running", lastError: null },
    sessionStatus: {
      phase: "turn_running",
      lcmContextInjection: {
        enabled: true,
        total: 1,
        failures: 1,
        latest: {
          kind: "assemble",
          ok: false,
          at: "2026-06-04T11:59:00.000Z",
          tokenBudget: 100,
          estimatedTokens: 96,
          inputMessageCount: 8,
          error: "assemble failed",
        },
      },
      hindsightMemory: {
        enabled: true,
        total: 1,
        failures: 1,
        history: [{ kind: "hindsight_recall", ok: false, at: "2026-06-04T11:59:10.000Z", error: "recall failed" }],
      },
    },
    requests: {
      req_1: {
        id: "req_1",
        sequence: 1,
        status: "completed",
        memoryError: "LCM ingest failed",
        lcm: { ok: false, error: "LCM ingest failed" },
      },
    },
    lcmStatus: null,
    lcmStatusError: "database unavailable",
    lcmContextEnabled: true,
    lcmContextTokenBudget: 100,
    hindsightConfigured: true,
    webSearch: { mode: "live", configured: true, provider: "openai-hosted", agentToolAvailable: false, notes: [] },
  });

  assert.equal(status.ok, true);
  assert.equal(status.context.pressure, "critical");
  assert.equal(status.lcm.available, false);
  assert.equal(status.lcm.statusError, "LCM status error.");
  assert.equal(status.lcm.lastIngestOk, false);
  assert.equal(status.hindsight.latestRecallOk, false);
  assert.equal(status.webSearch.mode, "live");
  assert.match(status.warnings.join("\n"), /LCM is unavailable/u);
  assert.match(status.warnings.join("\n"), /LCM context injection failed/u);
  assert.match(status.warnings.join("\n"), /latest completed request has memory ingest errors/u);
  assert.match(status.warnings.join("\n"), /Context pressure is critical/u);
  assert.match(status.warnings.join("\n"), /Hindsight recall failed/u);
  assert.match(status.warnings.join("\n"), /Web search is configured but no agent tool is available/u);
});

test("buildAgentContextStatus redacts sensitive strings from observable errors and warnings", () => {
  const status = buildAgentContextStatus({
    nowIso: () => "2026-06-04T12:00:00.000Z",
    agentStatus: {
      id: "beep",
      lastError: "agent failed after reading SECRET_AGENT_ERROR",
    },
    sessionStatus: {
      phase: "idle",
      lcmContextInjection: {
        enabled: true,
        total: 1,
        failures: 1,
        latest: {
          ok: false,
          tokenBudget: 100,
          estimatedTokens: 10,
          error: "assemble saw SECRET_INJECTION_ERROR",
        },
      },
      hindsightMemory: {
        enabled: true,
        total: 2,
        failures: 2,
        history: [
          { kind: "hindsight_retain", ok: false, error: "retain saw SECRET_RETAIN_ERROR" },
          { kind: "hindsight_recall", ok: false, error: "recall saw SECRET_RECALL_ERROR" },
        ],
      },
    },
    requests: {
      req_1: {
        id: "req_1",
        sequence: 1,
        status: "completed",
        memoryError: "memory saw SECRET_MEMORY_ERROR",
        lcm: { ok: false, error: "lcm saw SECRET_LCM_ERROR" },
      },
    },
    lcmStatus: null,
    lcmStatusError: "database saw SECRET_LCM_STATUS_ERROR",
    lcmContextEnabled: true,
    lcmContextTokenBudget: 100,
    hindsightConfigured: true,
  });

  const serialized = JSON.stringify(status);

  assert.doesNotMatch(serialized, /SECRET_AGENT_ERROR/u);
  assert.doesNotMatch(serialized, /SECRET_INJECTION_ERROR/u);
  assert.doesNotMatch(serialized, /SECRET_RETAIN_ERROR/u);
  assert.doesNotMatch(serialized, /SECRET_RECALL_ERROR/u);
  assert.doesNotMatch(serialized, /SECRET_MEMORY_ERROR/u);
  assert.doesNotMatch(serialized, /SECRET_LCM_ERROR/u);
  assert.doesNotMatch(serialized, /SECRET_LCM_STATUS_ERROR/u);
  assert.match(status.agent.lastError, /Agent error/u);
  assert.match(status.lcm.statusError, /LCM status error/u);
  assert.match(status.lcm.lastIngestError, /LCM ingest failed/u);
  assert.match(status.hindsight.latestError, /Hindsight recall failed/u);
});

test("buildAgentContextStatus bases last LCM ingest on latest request with memory evidence", () => {
  const status = buildAgentContextStatus({
    nowIso: () => "2026-06-04T12:00:00.000Z",
    agentStatus: { id: "beep" },
    sessionStatus: { phase: "idle" },
    requests: {
      req_lcm_failed: {
        id: "req_lcm_failed",
        sequence: 1,
        status: "completed",
        memoryError: "LCM ingest failed for SECRET_OLD_PROMPT",
        lcm: { ok: false, error: "LCM ingest failed for SECRET_OLD_PROMPT" },
      },
      req_without_lcm: {
        id: "req_without_lcm",
        sequence: 2,
        status: "completed",
        recordLcm: false,
      },
    },
    lcmStatus: { ok: true, rowCounts: {}, totals: {} },
  });

  assert.equal(status.agent.lastCompletedRequestId, "req_without_lcm");
  assert.equal(status.lcm.lastIngestRequestId, "req_lcm_failed");
  assert.equal(status.lcm.lastIngestOk, false);
  assert.match(status.warnings.join("\n"), /latest completed request has memory ingest errors/u);
  assert.doesNotMatch(JSON.stringify(status), /SECRET_OLD_PROMPT/u);
});

test("buildAgentContextStatus marks configured Hindsight unavailable until telemetry is observed", () => {
  const status = buildAgentContextStatus({
    hindsightConfigured: true,
    sessionStatus: {
      hindsightMemory: {
        enabled: true,
        total: 0,
        failures: 0,
        history: [],
      },
    },
  });

  assert.equal(status.hindsight.available, false);
  assert.equal(status.hindsight.observed, false);
});

test("buildAgentContextStatus marks Hindsight unavailable when latest event failed", () => {
  const retainFailed = buildAgentContextStatus({
    hindsightConfigured: true,
    sessionStatus: {
      hindsightMemory: {
        enabled: true,
        total: 1,
        failures: 1,
        history: [{ kind: "hindsight_retain", ok: false, error: "retain saw SECRET_RETAIN_LATEST" }],
      },
    },
  });
  const recallFailed = buildAgentContextStatus({
    hindsightConfigured: true,
    sessionStatus: {
      hindsightMemory: {
        enabled: true,
        total: 1,
        failures: 1,
        history: [{ kind: "hindsight_recall", ok: false, error: "recall saw SECRET_RECALL_LATEST" }],
      },
    },
  });

  assert.equal(retainFailed.hindsight.available, false);
  assert.equal(recallFailed.hindsight.available, false);
  assert.doesNotMatch(JSON.stringify(retainFailed), /SECRET_RETAIN_LATEST/u);
  assert.doesNotMatch(JSON.stringify(recallFailed), /SECRET_RECALL_LATEST/u);
});
