# Agent Context Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backend-first `/agent/context` and `/api/agent/context` observability surface that shows sanitized memory, context, LCM, Hindsight, and web-search readiness health for the long-running Beep Pi agent.

**Architecture:** Create a pure runtime context-status builder that accepts already-available runtime state and returns a sanitized JSON contract. Wire that builder into the runtime API, proxy it through the control plane, then update docs and smoke validation. Actual web-search execution remains outside this slice; the endpoint only reports readiness.

**Tech Stack:** Node.js ESM, `node:test`, Beep runtime API, control-plane route proxy, Lossless Claw status data, Hindsight telemetry, Bash smoke test.

---

## Execution Notes

This branch already has uncommitted model/thinking settings work in `runtime/src/beep-runtime-api.mjs`, `control-plane/src/runtime-agent-routes.mjs`, and related tests. Do not revert those changes. When committing task work, stage only the files or hunks listed in each task. If selective staging is awkward because a file is already dirty, skip that task commit and make one reviewed commit after all tests pass.

## File Structure

- Create `runtime/src/agent-context-status.mjs`: pure status builder, pressure calculation, warning generation, sanitization helpers.
- Create `test/agent-context-status.test.mjs`: focused tests for pressure, warning, and privacy behavior.
- Modify `runtime/src/beep-runtime-api.mjs`: import the builder, add `GET /agent/context`, add the endpoint to capabilities.
- Modify `test/runtime-integration-static.test.mjs`: static guard that the runtime route is wired through the focused builder.
- Modify `control-plane/src/runtime-agent-routes.mjs`: add `/api/agent/context` to GET proxy routes.
- Modify `control-plane/test/runtime-agent-routes.test.mjs`: verify proxy mapping and auth.
- Modify `runtime/README.md`: document direct runtime context endpoint.
- Modify `docs/first-usable-backend-loop.md`: document control-plane context endpoint.
- Modify `scripts/smoke-test-first-usable-backend.sh`: fetch and validate the new context endpoint in the live smoke.

### Task 1: Pure Context Status Builder

**Files:**
- Create: `runtime/src/agent-context-status.mjs`
- Create: `test/agent-context-status.test.mjs`

- [ ] **Step 1: Write the failing pure builder tests**

Create `test/agent-context-status.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentContextStatus,
  calculateContextPressure,
} from "../runtime/src/agent-context-status.mjs";

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

test("buildAgentContextStatus returns healthy sanitized context status", () => {
  const status = buildAgentContextStatus({
    nowIso: () => "2026-06-04T12:00:00.000Z",
    runtimeConfig: {
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "low",
    },
    agentStatus: {
      id: "beep",
      queueDepth: 0,
      activeRequestId: null,
      lastError: null,
    },
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
          {
            kind: "hindsight_recall",
            ok: true,
            at: "2026-06-04T11:58:00.000Z",
            bankId: "beep:local:user:project",
          },
          {
            kind: "hindsight_retain",
            ok: true,
            at: "2026-06-04T11:59:30.000Z",
            documentId: "doc-1",
          },
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
      rowCounts: {
        conversations: 1,
        messages: 57,
        message_parts: 73,
        summaries: 2,
        context_items: 59,
        large_files: 0,
      },
      totals: {
        messageTokens: 13485,
        summaryTokens: 900,
        summarizedSourceTokens: 4200,
      },
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
    runtimeConfig: {
      provider: "openai-codex",
      model: "gpt-5.5",
      thinking: "high",
    },
    agentStatus: {
      id: "beep",
      queueDepth: 1,
      activeRequestId: "req_running",
      lastError: null,
    },
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
        history: [
          {
            kind: "hindsight_recall",
            ok: false,
            at: "2026-06-04T11:59:10.000Z",
            error: "recall failed",
          },
        ],
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
    webSearch: {
      mode: "live",
      configured: true,
      provider: "openai-hosted",
      agentToolAvailable: false,
      notes: [],
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.context.pressure, "critical");
  assert.equal(status.lcm.available, false);
  assert.equal(status.lcm.statusError, "database unavailable");
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
```

- [ ] **Step 2: Run the new test and verify it fails before implementation**

Run:

```bash
node --test test/agent-context-status.test.mjs
```

Expected: FAIL with `Cannot find module` for `runtime/src/agent-context-status.mjs`.

- [ ] **Step 3: Create the pure status builder**

Create `runtime/src/agent-context-status.mjs`:

```js
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const DEFAULT_WEB_SEARCH_STATUS = Object.freeze({
  mode: "disabled",
  configured: false,
  provider: null,
  agentToolAvailable: false,
  notes: ["Web search execution is planned for the next backend slice."],
});

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function integerOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function safeString(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function requestValues(requests) {
  if (Array.isArray(requests)) return requests.filter((request) => request && typeof request === "object");
  if (requests && typeof requests === "object") {
    return Object.values(requests).filter((request) => request && typeof request === "object");
  }
  return [];
}

function requestSequence(request) {
  const parsed = Number(request?.sequence);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestCompletedRequest(requests) {
  return requestValues(requests)
    .filter((request) => request.status === "completed")
    .sort((left, right) => {
      const sequenceDelta = requestSequence(right) - requestSequence(left);
      if (sequenceDelta !== 0) return sequenceDelta;
      return String(right.completedAt || "").localeCompare(String(left.completedAt || ""));
    })[0] || null;
}

function requestCounts(requests) {
  const values = requestValues(requests);
  const byStatus = {};
  for (const request of values) {
    const status = request.status || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return {
    total: values.length,
    byStatus,
  };
}

function latestTelemetryEvent(telemetry, predicate) {
  const history = Array.isArray(telemetry?.history) ? telemetry.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event && typeof event === "object" && predicate(event)) return event;
  }
  const latest = telemetry?.latest;
  if (latest && typeof latest === "object" && predicate(latest)) return latest;
  return null;
}

function latestTelemetryByKind(telemetry, kind) {
  return latestTelemetryEvent(telemetry, (event) => event.kind === kind);
}

function latestFailure(telemetry) {
  return latestTelemetryEvent(telemetry, (event) => event.ok === false || Boolean(event.error));
}

function okOrNull(event) {
  if (!event) return null;
  if (event.ok === undefined || event.ok === null) return null;
  return event.ok !== false;
}

function normalizeWebSearchStatus(webSearch = null) {
  const source = webSearch && typeof webSearch === "object" ? webSearch : DEFAULT_WEB_SEARCH_STATUS;
  return {
    mode: typeof source.mode === "string" && source.mode.trim() ? source.mode.trim() : DEFAULT_WEB_SEARCH_STATUS.mode,
    configured: source.configured === true,
    provider: typeof source.provider === "string" && source.provider.trim() ? source.provider.trim() : null,
    agentToolAvailable: source.agentToolAvailable === true,
    notes: Array.isArray(source.notes) ? source.notes.map((note) => String(note)).filter(Boolean) : [...DEFAULT_WEB_SEARCH_STATUS.notes],
  };
}

function latestIngestFromRequest(request) {
  if (!request) {
    return {
      requestId: null,
      ok: null,
      error: null,
    };
  }
  if (request.recordLcm === false) {
    return {
      requestId: request.id || null,
      ok: null,
      error: null,
    };
  }
  const memoryError = safeString(request.memoryError);
  const lcmError = safeString(request.lcm?.error);
  if (memoryError || request.lcm?.ok === false) {
    return {
      requestId: request.id || null,
      ok: false,
      error: memoryError || lcmError || "LCM ingest failed.",
    };
  }
  if (request.lcm && typeof request.lcm === "object") {
    return {
      requestId: request.id || null,
      ok: true,
      error: null,
    };
  }
  return {
    requestId: request.id || null,
    ok: null,
    error: null,
  };
}

export function calculateContextPressure({ estimatedTokens, tokenBudget } = {}) {
  const estimated = numberOrNull(estimatedTokens);
  const budget = positiveNumberOrNull(tokenBudget);
  if (estimated === null || budget === null) {
    return {
      pressure: "unknown",
      remainingTokens: null,
      ratio: null,
    };
  }

  const ratio = estimated / budget;
  let pressure = "low";
  if (ratio >= 0.95) {
    pressure = "critical";
  } else if (ratio >= 0.8) {
    pressure = "high";
  } else if (ratio >= 0.6) {
    pressure = "medium";
  }

  return {
    pressure,
    remainingTokens: Math.max(0, Math.round(budget - estimated)),
    ratio: Number(ratio.toFixed(4)),
  };
}

export function buildAgentContextStatus({
  nowIso = () => new Date().toISOString(),
  runtimeConfig = {},
  agentStatus = {},
  sessionStatus = null,
  requests = {},
  lcmStatus = null,
  lcmStatusError = null,
  lcmContextEnabled = true,
  lcmContextTokenBudget = DEFAULT_CONTEXT_WINDOW_TOKENS,
  hindsightConfigured = false,
  webSearch = null,
  estimatedContextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
} = {}) {
  const requestSummary = requestCounts(requests);
  const latestCompleted = latestCompletedRequest(requests);
  const latestIngest = latestIngestFromRequest(latestCompleted);
  const lcmContextTelemetry = sessionStatus?.lcmContextInjection || null;
  const latestInjection = lcmContextTelemetry?.latest || null;
  const tokenBudget =
    positiveNumberOrNull(latestInjection?.tokenBudget) ||
    positiveNumberOrNull(lcmContextTokenBudget) ||
    DEFAULT_CONTEXT_WINDOW_TOKENS;
  const estimatedTokens = numberOrNull(latestInjection?.estimatedTokens);
  const pressure = calculateContextPressure({ estimatedTokens, tokenBudget });
  const lcmAvailable = Boolean(lcmStatus && typeof lcmStatus === "object" && lcmStatus.ok !== false && !lcmStatusError);
  const rowCounts = lcmStatus?.rowCounts && typeof lcmStatus.rowCounts === "object" ? lcmStatus.rowCounts : {};
  const totals = lcmStatus?.totals && typeof lcmStatus.totals === "object" ? lcmStatus.totals : {};
  const hindsightTelemetry = sessionStatus?.hindsightMemory || null;
  const latestRetain = latestTelemetryByKind(hindsightTelemetry, "hindsight_retain");
  const latestRecall = latestTelemetryByKind(hindsightTelemetry, "hindsight_recall");
  const hindsightFailure = latestFailure(hindsightTelemetry);
  const hindsightAvailable = Boolean(
    hindsightTelemetry?.enabled ||
      integerOrZero(hindsightTelemetry?.total) > 0 ||
      latestRetain ||
      latestRecall,
  );
  const normalizedWebSearch = normalizeWebSearchStatus(webSearch);
  const contextPressure = pressure.pressure;

  const warnings = [];
  if (!lcmAvailable) {
    warnings.push(`LCM is unavailable${lcmStatusError ? `: ${safeString(lcmStatusError)}` : "."}`);
  }
  if (lcmContextEnabled && requestSummary.total > 0 && !latestInjection) {
    warnings.push("LCM context injection has not run for this agent session yet.");
  }
  if (latestInjection?.ok === false) {
    warnings.push(`LCM context injection failed${latestInjection.error ? `: ${safeString(latestInjection.error)}` : "."}`);
  }
  if (latestIngest.ok === false) {
    warnings.push(`The latest completed request has memory ingest errors: ${latestIngest.error}`);
  }
  if (hindsightConfigured && !hindsightAvailable) {
    warnings.push("Hindsight is configured but no Hindsight telemetry is available for this agent session.");
  }
  if (latestRetain?.ok === false) {
    warnings.push(`Hindsight retain failed${latestRetain.error ? `: ${safeString(latestRetain.error)}` : "."}`);
  }
  if (latestRecall?.ok === false) {
    warnings.push(`Hindsight recall failed${latestRecall.error ? `: ${safeString(latestRecall.error)}` : "."}`);
  }
  if (hindsightFailure?.error && latestRetain?.ok !== false && latestRecall?.ok !== false) {
    warnings.push(`Hindsight has recent failures: ${safeString(hindsightFailure.error)}`);
  }
  if (contextPressure === "high" || contextPressure === "critical") {
    warnings.push(`Context pressure is ${contextPressure}.`);
  }
  if (normalizedWebSearch.mode !== "disabled" && !normalizedWebSearch.agentToolAvailable) {
    warnings.push("Web search is configured but no agent tool is available yet.");
  }

  return {
    ok: true,
    schemaVersion: 1,
    time: nowIso(),
    agent: {
      id: agentStatus.id || "beep",
      phase: sessionStatus?.phase || agentStatus.sessionPhase || null,
      queueDepth: integerOrZero(agentStatus.queueDepth),
      activeRequestId: agentStatus.activeRequestId || null,
      lastCompletedRequestId: latestCompleted?.id || null,
      lastError: safeString(agentStatus.lastError),
      requests: requestSummary,
    },
    model: {
      provider: runtimeConfig.provider || "openai-codex",
      model: sessionStatus?.model || runtimeConfig.model || null,
      thinking: sessionStatus?.thinking || runtimeConfig.thinking || null,
      estimatedContextWindowTokens,
    },
    context: {
      tokenBudget,
      estimatedTokens,
      pressure: contextPressure,
      remainingTokens: pressure.remainingTokens,
      ratio: pressure.ratio,
      lastInjectionAt: latestInjection?.at || null,
      lastInjectionOk: okOrNull(latestInjection),
      inputMessageCount: numberOrNull(latestInjection?.inputMessageCount),
      outputMessageCount: numberOrNull(latestInjection?.outputMessageCount),
    },
    lcm: {
      available: lcmAvailable,
      statusError: lcmStatusError ? safeString(lcmStatusError) : null,
      conversationCount: integerOrZero(rowCounts.conversations),
      messageCount: integerOrZero(rowCounts.messages),
      messagePartCount: integerOrZero(rowCounts.message_parts),
      contextItemCount: integerOrZero(rowCounts.context_items),
      summaryCount: integerOrZero(rowCounts.summaries),
      largeFileCount: integerOrZero(rowCounts.large_files),
      messageTokens: integerOrZero(totals.messageTokens),
      summaryTokens: integerOrZero(totals.summaryTokens),
      summarizedSourceTokens: integerOrZero(totals.summarizedSourceTokens),
      lastIngestRequestId: latestIngest.requestId,
      lastIngestOk: latestIngest.ok,
      lastIngestError: latestIngest.error,
    },
    hindsight: {
      configured: hindsightConfigured === true,
      available: hindsightAvailable,
      latestRetainOk: okOrNull(latestRetain),
      latestRecallOk: okOrNull(latestRecall),
      latestError: safeString(hindsightFailure?.error),
      telemetryCount: integerOrZero(hindsightTelemetry?.total),
      failureCount: integerOrZero(hindsightTelemetry?.failures),
    },
    webSearch: normalizedWebSearch,
    warnings,
  };
}
```

- [ ] **Step 4: Run the pure builder tests**

Run:

```bash
node --test test/agent-context-status.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the pure builder**

If only the two Task 1 files are unstaged, run:

```bash
git add runtime/src/agent-context-status.mjs test/agent-context-status.test.mjs
git commit -m "feat: add agent context status builder"
```

If other task files are dirty, stage only Task 1 hunks and use the same commit message.

### Task 2: Runtime `/agent/context` Endpoint

**Files:**
- Modify: `runtime/src/beep-runtime-api.mjs`
- Modify: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Add the failing static runtime wiring test**

Modify the top of `test/runtime-integration-static.test.mjs` so it reads the new builder source:

```js
const apiSource = readFileSync(new URL("../runtime/src/beep-runtime-api.mjs", import.meta.url), "utf8");
const agentSettingsSource = readFileSync(new URL("../runtime/src/agent-settings.mjs", import.meta.url), "utf8");
const agentContextSource = readFileSync(new URL("../runtime/src/agent-context-status.mjs", import.meta.url), "utf8");
```

Append this test to `test/runtime-integration-static.test.mjs`:

```js
test("runtime exposes sanitized agent context route through focused status builder", () => {
  assert.match(apiSource, /agent-context-status\.mjs/);
  assert.match(apiSource, /buildAgentContextStatus/);
  assert.match(apiSource, /async function handleAgentContextRoute/);
  assert.match(apiSource, /"GET \/agent\/context"/);
  assert.match(apiSource, /action === "context"/);
  assert.match(agentContextSource, /export function buildAgentContextStatus/);
  assert.doesNotMatch(agentContextSource, /lastAssistantText:/);
  assert.doesNotMatch(agentContextSource, /message:/);

  const contextRouteIndex = apiSource.indexOf('action === "context"');
  const summaryRouteIndex = apiSource.indexOf('action === "summary"');
  assert.ok(contextRouteIndex > 0, "agent context route should exist");
  assert.ok(summaryRouteIndex > 0, "agent summary route should exist");
  assert.ok(contextRouteIndex < summaryRouteIndex, "context route should be handled before summary route");
});
```

- [ ] **Step 2: Run the static runtime test and verify it fails**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL because `beep-runtime-api.mjs` does not import `agent-context-status.mjs` or expose `GET /agent/context`.

- [ ] **Step 3: Import the context builder in the runtime API**

In `runtime/src/beep-runtime-api.mjs`, add this import after the `agent-settings.mjs` import block:

```js
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  buildAgentContextStatus,
} from "./agent-context-status.mjs";
```

- [ ] **Step 4: Add the runtime context route handler**

In `runtime/src/beep-runtime-api.mjs`, insert this function immediately before `async function handleAgentSettingsRoute(req, res, url) {`:

```js
async function handleAgentContextRoute(_req, res) {
  const runtimeConfig = loadRuntimeConfig();
  const activeSession = agentSupervisor.session && !agentSupervisor.session.closed ? agentSupervisor.session : null;
  const sessionStatus = activeSession ? activeSession.status() : readSessionStatus(agentSupervisor.sessionId);
  let lcmStatus = null;
  let lcmStatusError = null;

  try {
    lcmStatus = await agentSupervisor.lcmStatus();
  } catch (error) {
    lcmStatusError = error instanceof Error ? error.message : String(error);
  }

  jsonResponse(
    res,
    200,
    buildAgentContextStatus({
      nowIso,
      runtimeConfig,
      agentStatus: agentSupervisor.status(),
      sessionStatus,
      requests: agentSupervisor.state.requests,
      lcmStatus,
      lcmStatusError,
      lcmContextEnabled: LCM_CONTEXT_ENABLED,
      lcmContextTokenBudget: LCM_CONTEXT_TOKEN_BUDGET,
      hindsightConfigured: Boolean(defaultMemoryCoordinator.hindsightService?.config?.enabled),
      webSearch: {
        mode: "disabled",
        configured: false,
        provider: null,
        agentToolAvailable: false,
        notes: ["Web search execution is planned for the next backend slice."],
      },
      estimatedContextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    }),
  );
}
```

- [ ] **Step 5: Route `GET /agent/context` before summary**

In `runtime/src/beep-runtime-api.mjs`, inside `async function handleAgentRoute(req, res, url, parts) {`, insert this block after the `GET /agent/requests/:id` block and before the existing `GET /agent/events` block:

```js
  if (action === "context" && !id) {
    if (req.method !== "GET") {
      routeError(res, 405, "Unsupported method for agent context route.");
      return;
    }
    await handleAgentContextRoute(req, res);
    return;
  }
```

- [ ] **Step 6: Add the endpoint to runtime capabilities**

In `runtime/src/beep-runtime-api.mjs`, in the `endpoints` array in `handleCapabilities`, add this string immediately after `"GET /agent/summary"`:

```js
      "GET /agent/context",
```

- [ ] **Step 7: Run the runtime tests**

Run:

```bash
node --test test/agent-context-status.test.mjs test/runtime-integration-static.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit the runtime endpoint**

If selective staging is safe, run:

```bash
git add runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
git commit -m "feat: expose agent context status"
```

If `runtime/src/beep-runtime-api.mjs` still contains pre-existing uncommitted settings work, stage only the context endpoint hunks or skip this commit until final review.

### Task 3: Control-Plane `/api/agent/context` Proxy

**Files:**
- Modify: `control-plane/src/runtime-agent-routes.mjs`
- Modify: `control-plane/test/runtime-agent-routes.test.mjs`

- [ ] **Step 1: Add the failing control-plane proxy test**

In `control-plane/test/runtime-agent-routes.test.mjs`, add this test after `summary and events proxy through operator auth and preserve event query string`:

```js
test("agent context proxies through operator auth", async () => {
  const context = await callRoute({ target: "/api/agent/context" });

  assert.equal(context.authCalls, 1);
  assert.deepEqual(context.calls, [{ path: "/agent/context", options: { method: "GET" } }]);
  assert.equal(context.statusCode, 200);
  assert.deepEqual(context.payload, { ok: true, path: "/agent/context" });
});
```

- [ ] **Step 2: Run the control-plane route test and verify it fails**

Run:

```bash
node --test control-plane/test/runtime-agent-routes.test.mjs
```

Expected: FAIL because `/api/agent/context` currently returns 404.

- [ ] **Step 3: Add the proxy route**

In `control-plane/src/runtime-agent-routes.mjs`, add this entry to `GET_ROUTES` immediately after `["/api/agent/summary", "/agent/summary"],`:

```js
  ["/api/agent/context", "/agent/context"],
```

- [ ] **Step 4: Run the control-plane route tests**

Run:

```bash
node --test control-plane/test/runtime-agent-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit the control-plane proxy**

If selective staging is safe, run:

```bash
git add control-plane/src/runtime-agent-routes.mjs control-plane/test/runtime-agent-routes.test.mjs
git commit -m "feat: proxy agent context status"
```

If those files contain pre-existing uncommitted settings work, stage only the `/api/agent/context` hunks or skip this commit until final review.

### Task 4: Docs And Live Smoke Coverage

**Files:**
- Modify: `runtime/README.md`
- Modify: `docs/first-usable-backend-loop.md`
- Modify: `scripts/smoke-test-first-usable-backend.sh`

- [ ] **Step 1: Document the direct runtime context endpoint**

In `runtime/README.md`, in the direct runtime curl block that currently includes `/agent/summary`, add:

```bash
curl http://127.0.0.1:8787/agent/context \
  -H "authorization: Bearer $runtime_api_token"
```

After the paragraph that ends with `under lcmContextInjection`, add:

```markdown

`GET /agent/context` is the sanitized backend observability contract for memory
and context health. It reports model and thinking settings, context pressure,
LCM row/token counters, latest LCM context injection, Hindsight retain/recall
telemetry, warnings, and web-search readiness. It must not expose raw
transcripts, message bodies, raw Hindsight memories, or LCM message content.
```

- [ ] **Step 2: Document the control-plane context endpoint**

In `docs/first-usable-backend-loop.md`, in the runtime agent proxy curl block after `/api/agent/events?limit=20`, add:

```bash
curl http://127.0.0.1:8788/api/agent/context \
  -H "authorization: Bearer $operator_token"
```

In the `Memory Flow` section, replace this bullet:

```markdown
- The operator-only backend status endpoint exposes sanitized LCM and Hindsight
  telemetry. It should not expose raw runtime transcripts, raw memory files, or
  LCM message bodies.
```

with:

```markdown
- The operator-only backend status and `/api/agent/context` endpoints expose
  sanitized LCM and Hindsight telemetry. `/api/agent/context` is the purpose-built
  memory/context health contract for context pressure, latest injection, latest
  ingest, Hindsight telemetry, warnings, and web-search readiness. Neither
  endpoint should expose raw runtime transcripts, raw memory files, raw
  Hindsight memories, or LCM message bodies.
```

- [ ] **Step 3: Fetch `/api/agent/context` in the live smoke**

In `scripts/smoke-test-first-usable-backend.sh`, after this line:

```bash
STATUS_AFTER_FILE="$OUTPUT_DIR/backend-status-after.json"
```

add:

```bash
CONTEXT_AFTER_FILE="$OUTPUT_DIR/agent-context-after.json"
```

After this line:

```bash
auth_get "/api/backend/status" "$STATUS_AFTER_FILE"
```

add:

```bash
auth_get "/api/agent/context" "$CONTEXT_AFTER_FILE"
```

- [ ] **Step 4: Pass the context file into the smoke validator**

In `scripts/smoke-test-first-usable-backend.sh`, change the `node --input-type=module - \` argument list from:

```bash
  "$STATUS_BEFORE_FILE" \
  "$STATUS_AFTER_FILE" \
  "$SEED_OUTPUT_FILE" \
  "$RECALL_OUTPUT_FILE" \
  "$RUNTIME_STOP_FILE" \
  "$RUNTIME_START_FILE" <<'NODE'
```

to:

```bash
  "$STATUS_BEFORE_FILE" \
  "$STATUS_AFTER_FILE" \
  "$CONTEXT_AFTER_FILE" \
  "$SEED_OUTPUT_FILE" \
  "$RECALL_OUTPUT_FILE" \
  "$RUNTIME_STOP_FILE" \
  "$RUNTIME_START_FILE" <<'NODE'
```

Then replace this JavaScript argument parsing block:

```js
const [beforeStatusPath, statusPath, seedResponsePath, recallResponsePath, stopResponsePath, startResponsePath] =
  process.argv.slice(2);
if (!beforeStatusPath || !statusPath || !seedResponsePath || !recallResponsePath || !stopResponsePath || !startResponsePath) {
  console.error(
    "usage: validator <before-status.json> <final-status.json> <seed-response.json> <recall-response.json> <runtime-stop.json> <runtime-start.json>",
  );
  process.exit(2);
}
```

with:

```js
const [
  beforeStatusPath,
  statusPath,
  contextStatusPath,
  seedResponsePath,
  recallResponsePath,
  stopResponsePath,
  startResponsePath,
] = process.argv.slice(2);
if (
  !beforeStatusPath ||
  !statusPath ||
  !contextStatusPath ||
  !seedResponsePath ||
  !recallResponsePath ||
  !stopResponsePath ||
  !startResponsePath
) {
  console.error(
    "usage: validator <before-status.json> <final-status.json> <context-status.json> <seed-response.json> <recall-response.json> <runtime-stop.json> <runtime-start.json>",
  );
  process.exit(2);
}
```

After:

```js
const status = readJson(statusPath);
```

add:

```js
const contextStatus = readJson(contextStatusPath);
```

- [ ] **Step 5: Validate the context payload in the smoke validator**

In `scripts/smoke-test-first-usable-backend.sh`, after the `requireFinalStatusRequest` helper block and before the `if (status.ok !== true)` checks, add:

```js
const validateAgentContextStatus = (value) => {
  if (!isObject(value)) {
    failures.push("agent context status must be a JSON object");
    return null;
  }
  if (value.ok !== true) failures.push("agent context status ok must be true");
  if (value.schemaVersion !== 1) failures.push("agent context status schemaVersion must be 1");
  if (!isObject(value.agent)) failures.push("agent context status must include agent");
  if (!isObject(value.model)) failures.push("agent context status must include model");
  if (!isObject(value.context)) failures.push("agent context status must include context");
  if (!isObject(value.lcm)) failures.push("agent context status must include lcm");
  if (!isObject(value.hindsight)) failures.push("agent context status must include hindsight");
  if (!isObject(value.webSearch)) failures.push("agent context status must include webSearch");
  if (!Array.isArray(value.warnings)) failures.push("agent context status warnings must be an array");
  if (value.context && !nonEmptyString(value.context.pressure)) {
    failures.push("agent context status must include context.pressure");
  }
  if (value.lcm?.available !== true) {
    failures.push("agent context status must report LCM as available after live memory proof");
  }
  if (value.webSearch?.mode !== "disabled") {
    failures.push("agent context status webSearch.mode should be disabled in the memory-first slice");
  }
  const serialized = JSON.stringify(value);
  if (serialized.includes("Remember this Beep project rule")) {
    failures.push("agent context status must not include raw seed prompt text");
  }
  if (serialized.includes("Continue from the earlier memory rule")) {
    failures.push("agent context status must not include raw recall prompt text");
  }
  return value;
};
const agentContext = validateAgentContextStatus(contextStatus);
```

In the `summary` object, add these fields after `agentAvailable: status.agent?.available === true,`:

```js
  agentContextPressure: agentContext?.context?.pressure || null,
  agentContextWarnings: Array.isArray(agentContext?.warnings) ? agentContext.warnings : [],
```

In the final smoke output file list, after:

```bash
  final backend status:   $STATUS_AFTER_FILE
```

add:

```bash
  final agent context:    $CONTEXT_AFTER_FILE
```

- [ ] **Step 6: Run syntax checks for docs-adjacent shell edits**

Run:

```bash
bash -n scripts/smoke-test-first-usable-backend.sh
```

Expected: PASS with no output.

- [ ] **Step 7: Commit docs and smoke updates**

Run:

```bash
git add runtime/README.md docs/first-usable-backend-loop.md scripts/smoke-test-first-usable-backend.sh
git commit -m "docs: document agent context observability"
```

If prior unrelated changes are present in those files, stage only the docs and smoke hunks from this task.

### Task 5: Full Verification

**Files:**
- No source edits.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test test/agent-context-status.test.mjs test/runtime-integration-static.test.mjs control-plane/test/runtime-agent-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run the reconciliation suite**

Run:

```bash
npm run test:reconciliation
```

Expected: PASS for all Node tests.

- [ ] **Step 3: Run diff whitespace validation**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Run the live smoke when credentials and Docker are available**

Run:

```bash
./scripts/smoke-test-first-usable-backend.sh
```

Expected: PASS and output includes `First usable backend control-plane smoke passed.` The printed output files should include `final agent context`.

- [ ] **Step 5: Manually inspect the live endpoint**

With the control plane running and `operator_token` set, run:

```bash
curl -sS http://127.0.0.1:8788/api/agent/context \
  -H "authorization: Bearer $operator_token" | jq
```

Expected:

- `ok` is `true`.
- `schemaVersion` is `1`.
- `context.pressure` is one of `unknown`, `low`, `medium`, `high`, or `critical`.
- `lcm.available` is `true` after the runtime has started and LCM is readable.
- `webSearch.mode` is `disabled`.
- Raw user prompts and assistant answers are absent.

- [ ] **Step 6: Final reviewed commit**

If all task commits were skipped due existing dirty files, make one reviewed commit after staging only the context observability changes:

```bash
git status --short
git diff -- runtime/src/agent-context-status.mjs test/agent-context-status.test.mjs runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs control-plane/src/runtime-agent-routes.mjs control-plane/test/runtime-agent-routes.test.mjs runtime/README.md docs/first-usable-backend-loop.md scripts/smoke-test-first-usable-backend.sh
git add runtime/src/agent-context-status.mjs test/agent-context-status.test.mjs runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs control-plane/src/runtime-agent-routes.mjs control-plane/test/runtime-agent-routes.test.mjs runtime/README.md docs/first-usable-backend-loop.md scripts/smoke-test-first-usable-backend.sh
git commit -m "feat: expose agent context observability"
```
