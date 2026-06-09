import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildBackendStatus } from "../src/backend-status.mjs";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-backend-status-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(method, url, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => req.end());
  return req;
}

function captureResponse() {
  let statusCode = 0;
  let body = "";
  return {
    response: {
      writeHead(status) {
        statusCode = status;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    json() {
      return { statusCode, payload: body ? JSON.parse(body) : null };
    },
  };
}

function operatorHeaders(store) {
  return { authorization: `Bearer ${store.ensureOperatorToken()}` };
}

function seedStatusState(store) {
  const requestRecord = store.createAgentRequest({
    runtimeId: "local",
    message: "Create the first usable loop",
    source: "api",
    internalNote: "hidden",
  });
  store.updateAgentRequest(requestRecord.requestId, {
    status: "submitted",
    runtimeRequestId: "runtime-request-1",
    error: "runtime failed at file:///opt/lossless-claw/src/db/connection.ts and /workspace/private/session.json",
    runtimeResult: { promptResult: { finalAssistantText: "hidden answer" } },
  });

  const approval = store.createApproval({
    runtimeId: "local",
    toolCallId: "tool-call-1",
    action: "preview.container.createStaticSite",
    args: { sourcePath: "/workspace/hidden-site" },
    risk: "high",
    prompt: "Approve static preview?",
    reason: "operator review",
  });
  const oldApproval = store.createApproval({
    runtimeId: "local",
    toolCallId: "tool-call-old",
    action: "preview.container.createStaticSite",
    risk: "low",
    prompt: "Already approved?",
  });
  store.updateApproval(oldApproval.approvalId, {
    status: "approved",
    decision: "approve",
  });
  store.appendAudit({ kind: "manual_status_probe", runtimeId: "local", detail: "included /workspace/operator-audit" });

  return { requestRecord, approval };
}

function agentSummaryFixture() {
  return {
    ok: true,
    summary: {
      ok: true,
      sessionId: "agent_beep",
      provider: "openai-codex",
      model: "gpt-5",
      thinking: "medium",
      phase: "idle",
      createdAt: "2026-06-02T10:00:00.000Z",
      updatedAt: "2026-06-02T10:05:00.000Z",
      workspace: {
        path: "/workspace/api-sessions/agent_beep",
        entries: ["secret.txt"],
      },
      events: {
        path: "/state/api/sessions/agent_beep/events.jsonl",
        total: 12,
        byType: { session: 1, response: 2 },
        agentEndCount: 1,
        finalAssistantText: "events final assistant text must not leave this API",
        transcript: "events transcript must not leave this API",
      },
      lastAssistantText: "raw transcript text must not leave this API",
      lcm: {
        ok: true,
        available: true,
        backend: "lossless-claw",
        status: "ready",
        compactedCount: 5,
        error: "failed to read /state/api/sessions/agent_beep/session.json",
        rowCounts: { atoms: 12, bonds: 7, messages: 19, large_files: 2 },
        messageCount: 19,
        assemble: {
          messageCount: 3,
          estimatedTokens: 512,
          contextProjection: "summary assemble raw context projection must not leave this API",
          systemPromptAddition: "summary assemble raw system prompt must not leave this API",
          messages: [{ role: "system", content: "summary assemble raw message must not leave this API" }],
        },
        current: { messages: 4, atoms: 9 },
        messages: [{ role: "assistant", content: "raw LCM message object must not leave this API" }],
        lcmRoot: "/lcm/runtime-summary-root",
        assistantFinalText: "LCM final assistant text must not leave this API",
        assistantMessage: "LCM assistant message must not leave this API",
        config: {
          largeFilesDir: "/lcm/runtime-summary-large-files",
          status: "loaded",
          rowCounts: { configRows: 2 },
        },
        workspacePath: "/workspace/hidden",
      },
      lcmContextInjection: {
        latest: {
          kind: "assemble",
          at: "2026-06-02T10:04:00.000Z",
          injectedMessageCount: 2,
          contextProjection: "latest LCM context projection must not leave this API",
          systemPromptAddition: "latest LCM system prompt must not leave this API",
        },
      },
      hindsightMemory: {
        schemaVersion: 1,
        enabled: true,
        total: 7,
        byKind: {
          hindsight_recall: 4,
          hindsight_retain: 3,
        },
        failures: 1,
        latest: {
          kind: "hindsight_recall",
          at: "2026-06-02T10:03:00.000Z",
          items: 4,
          error: "hindsight read failed at file:///workspace/private/session.json",
        },
        transcriptText: "hidden memory transcript",
        history: [
          {
            kind: "hindsight_recall",
            content: "hindsight raw history must not leave this API",
          },
        ],
      },
    },
  };
}

test("buildBackendStatus aggregates running runtime, memory, control-plane state, and tools", async () => {
  const { store, cleanup } = tempStore();
  try {
    const { requestRecord, approval } = seedStatusState(store);
    const calls = [];
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true, pid: 1234 }),
      },
      toolBroker: {
        manifest: () => ({ tools: [{ name: "preview.container.createStaticSite" }] }),
      },
      forwardRuntimeRequest: async (path) => {
        calls.push(path);
        if (path === "/agent/summary") return agentSummaryFixture();
        if (path === "/agent/lcm/status") {
          return {
            ok: true,
            lcm: {
              ok: true,
              available: true,
              status: "ready",
              compactedCount: 3,
              error: "failed to scan /workspace/status-cwd and /state/api/sessions/agent_beep/lcm.json",
              rowCounts: { atoms: 8, bonds: 4, messages: 11, large_files: 1 },
              messageCount: 11,
              current: { messages: 6, bonds: 2 },
              messages: ["raw message from runtime must not leave this API"],
              lcmRoot: "/lcm/status-root",
              lcmLogTail: "raw LCM status log tail must not leave this API",
              cwd: "/workspace/status-cwd",
            },
          };
        }
        throw new Error(`unexpected forward path: ${path}`);
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.generatedAt, "2026-06-02T12:00:00.000Z");
    assert.deepEqual(status.runtime, { runtimeId: "local", running: true, pid: 1234 });
    assert.equal(status.agent.available, true);
    assert.equal(status.agent.error, null);
    assert.equal(status.agent.summary.sessionId, "agent_beep");
    assert.deepEqual(status.agent.summary.events, {
      total: 12,
      byType: { session: 1, response: 2 },
      agentEndCount: 1,
    });
    assert.deepEqual(status.agent.summary.lcm, {
      ok: true,
      available: true,
      backend: "lossless-claw",
      status: "ready",
      compactedCount: 5,
      error: "failed to read [redacted-path]",
      rowCounts: { atoms: 12, bonds: 7, messages: 19, large_files: 2 },
      messageCount: 19,
      assemble: {
        messageCount: 3,
        estimatedTokens: 512,
      },
      current: { messages: 4, atoms: 9 },
      config: {
        status: "loaded",
        rowCounts: { configRows: 2 },
      },
    });
    assert.equal(status.memory.lcm.available, true);
    assert.equal(status.memory.lcm.error, null);
    assert.deepEqual(status.memory.lcm.status, {
      ok: true,
      available: true,
      status: "ready",
      compactedCount: 3,
      error: "failed to scan [redacted-path] and [redacted-path]",
      rowCounts: { atoms: 8, bonds: 4, messages: 11, large_files: 1 },
      messageCount: 11,
      current: { messages: 6, bonds: 2 },
    });
    assert.deepEqual(status.memory.lcm.latestContextInjection, {
      kind: "assemble",
      at: "2026-06-02T10:04:00.000Z",
      injectedMessageCount: 2,
    });
    assert.deepEqual(status.memory.hindsight, {
      available: true,
      latest: {
        kind: "hindsight_recall",
        at: "2026-06-02T10:03:00.000Z",
        items: 4,
        error: "hindsight read failed at [redacted-path]",
      },
      telemetry: {
        enabled: true,
        total: 7,
        byKind: {
          hindsight_recall: 4,
          hindsight_retain: 3,
        },
        failures: 1,
      },
    });
    assert.equal(status.controlPlane.recentRequests.length, 1);
    assert.deepEqual(Object.keys(status.controlPlane.recentRequests[0]).sort(), [
      "createdAt",
      "error",
      "message",
      "requestId",
      "runtimeId",
      "runtimeRequestId",
      "status",
      "updatedAt",
    ]);
    assert.equal(status.controlPlane.recentRequests[0].requestId, requestRecord.requestId);
    assert.equal(status.controlPlane.recentRequests[0].runtimeRequestId, "runtime-request-1");
    assert.equal(status.controlPlane.recentRequests[0].message, "Create the first usable loop");
    assert.equal(status.controlPlane.recentRequests[0].error, "runtime failed at [redacted-path] and [redacted-path]");
    assert.equal(status.controlPlane.pendingApprovals.length, 1);
    assert.equal(status.controlPlane.pendingApprovals[0].approvalId, approval.approvalId);
    assert.deepEqual(Object.keys(status.controlPlane.pendingApprovals[0]).sort(), [
      "action",
      "approvalId",
      "createdAt",
      "prompt",
      "risk",
      "runtimeId",
      "status",
      "toolCallId",
      "updatedAt",
    ]);
    assert.equal(status.controlPlane.pendingApprovals[0].prompt, "Approve static preview?");
    assert.ok(
      status.controlPlane.recentAudit.some(
        (event) => event.kind === "manual_status_probe" && event.detail === "included /workspace/operator-audit",
      ),
    );
    assert.deepEqual(status.controlPlane.tools, { tools: [{ name: "preview.container.createStaticSite" }] });
    assert.deepEqual(calls, ["/agent/summary", "/agent/lcm/status"]);
    const serializedRequests = JSON.stringify(status.controlPlane.recentRequests);
    assert.doesNotMatch(serializedRequests, /file:\/\/\/opt/u);
    assert.doesNotMatch(serializedRequests, /src\/db\/connection\.ts/u);
    assert.doesNotMatch(serializedRequests, /\/workspace\/private/u);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus calls runtime forwarder exactly for summary and LCM status when running", async () => {
  const { store, cleanup } = tempStore();
  try {
    const calls = [];
    await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        calls.push(path);
        if (path === "/agent/summary") return { ok: true, summary: { sessionId: "agent_beep" } };
        if (path === "/agent/lcm/status") return { ok: true, status: { ok: true, status: "ready" } };
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.deepEqual(calls, ["/agent/summary", "/agent/lcm/status"]);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus degrades when runtime is stopped and does not call runtime forwarder", async () => {
  const { store, cleanup } = tempStore();
  try {
    let forwardCalls = 0;
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async () => {
        forwardCalls += 1;
        throw new Error("forwarder should not be called");
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.deepEqual(status.runtime, { runtimeId: "local", running: false });
    assert.equal(status.agent.available, false);
    assert.equal(status.agent.error, "runtime is not running");
    assert.equal(status.agent.summary, null);
    assert.equal(status.memory.lcm.available, false);
    assert.equal(status.memory.lcm.error, "runtime is not running");
    assert.equal(status.memory.hindsight.available, false);
    assert.equal(status.memory.hindsight.latest, null);
    assert.equal(status.memory.hindsight.telemetry, null);
    assert.equal(forwardCalls, 0);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus sanitizes stopped runtime status errors before returning or reusing them", async () => {
  const { store, cleanup } = tempStore();
  try {
    let forwardCalls = 0;
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({
          runtimeId: "local",
          running: false,
          apiUrl: "http://127.0.0.1:8787",
          error: "missing /workspace/private/session.json",
          state: {
            status: "stopped",
            updatedAt: "2026-06-02T10:00:00.000Z",
            workspacePath: "/workspace/private",
          },
        }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async () => {
        forwardCalls += 1;
        throw new Error("forwarder should not be called");
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.deepEqual(status.runtime, {
      runtimeId: "local",
      running: false,
      apiUrl: "http://127.0.0.1:8787",
      error: "missing [redacted-path]",
      state: {
        status: "stopped",
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
    });
    assert.equal(status.agent.error, "missing [redacted-path]");
    assert.equal(status.memory.lcm.error, "missing [redacted-path]");
    assert.equal(forwardCalls, 0);

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /\/workspace\/private/u);
    assert.doesNotMatch(serialized, /session\.json/u);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus sanitizes running runtime health fields with spaced paths", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({
          runtimeId: "local",
          running: true,
          apiUrl: "http://127.0.0.1:8787",
          health: {
            ok: true,
            service: "beep-agentd",
            runtimeId: "local",
            agent: {
              running: true,
              requestCount: 4,
              lastError: "failed /workspace/My Project/session.json",
              workspacePath: "/workspace/My Project",
            },
          },
          state: {
            status: "running",
            startedAt: "2026-06-02T09:00:00.000Z",
            apiUrl: "http://127.0.0.1:8787",
            logTail: "raw runtime state log tail",
          },
        }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") return agentSummaryFixture();
        if (path === "/agent/lcm/status") return { ok: true, lcm: { ok: true, status: "ready" } };
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.runtime.health.agent.lastError, "failed [redacted-path]");
    assert.equal(status.runtime.health.agent.workspacePath, undefined);
    assert.deepEqual(status.runtime.health.agent, {
      running: true,
      requestCount: 4,
      lastError: "failed [redacted-path]",
    });
    assert.deepEqual(status.runtime.state, {
      status: "running",
      startedAt: "2026-06-02T09:00:00.000Z",
      apiUrl: "http://127.0.0.1:8787",
    });

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /\/workspace\/My Project/u);
    assert.doesNotMatch(serialized, /Project\/session\.json/u);
    assert.doesNotMatch(serialized, /raw runtime state log tail/u);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus sanitizes agent summary while exposing memory telemetry", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") return agentSummaryFixture();
        if (path === "/agent/lcm/status") {
          return {
            ok: true,
            lcm: {
              ok: true,
              status: "ready",
              compactedCount: 3,
              error: "failed to scan /workspace/status-cwd and /state/api/sessions/agent_beep/lcm.json",
              rowCounts: { atoms: 8, bonds: 4, messages: 11, large_files: 1 },
              messageCount: 11,
              current: { messages: 6, bonds: 2 },
              messages: ["raw message from runtime must not leave this API"],
              lcmRoot: "/lcm/status-root",
              lcmLogTail: "raw LCM status log tail must not leave this API",
              cwd: "/workspace/status-cwd",
            },
          };
        }
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.agent.summary.workspace, undefined);
    assert.equal(status.agent.summary.lastAssistantText, undefined);
    assert.equal(status.agent.summary.events.path, undefined);
    assert.equal(status.agent.summary.events.finalAssistantText, undefined);
    assert.equal(status.agent.summary.events.transcript, undefined);
    assert.equal(status.agent.summary.lcm.workspacePath, undefined);
    assert.equal(status.agent.summary.lcm.lcmRoot, undefined);
    assert.equal(status.agent.summary.lcm.config.largeFilesDir, undefined);
    assert.equal(status.agent.summary.lcm.assistantFinalText, undefined);
    assert.equal(status.agent.summary.lcm.assistantMessage, undefined);
    assert.equal(status.agent.summary.lcm.messages, undefined);
    assert.equal(status.agent.summary.lcm.assemble.contextProjection, undefined);
    assert.equal(status.agent.summary.lcm.assemble.systemPromptAddition, undefined);
    assert.equal(status.agent.summary.lcm.assemble.messages, undefined);
    assert.deepEqual(status.agent.summary.lcm.assemble, { messageCount: 3, estimatedTokens: 512 });
    assert.equal(status.agent.summary.lcm.error, "failed to read [redacted-path]");
    assert.deepEqual(status.agent.summary.lcm.rowCounts, { atoms: 12, bonds: 7, messages: 19, large_files: 2 });
    assert.deepEqual(status.agent.summary.lcm.current, { messages: 4, atoms: 9 });
    assert.deepEqual(status.agent.summary.lcm.config.rowCounts, { configRows: 2 });
    assert.equal(status.memory.lcm.status.lcmRoot, undefined);
    assert.equal(status.memory.lcm.status.lcmLogTail, undefined);
    assert.equal(status.memory.lcm.status.cwd, undefined);
    assert.equal(status.memory.lcm.status.messages, undefined);
    assert.equal(status.memory.lcm.status.error, "failed to scan [redacted-path] and [redacted-path]");
    assert.deepEqual(status.memory.lcm.status.rowCounts, { atoms: 8, bonds: 4, messages: 11, large_files: 1 });
    assert.deepEqual(status.memory.lcm.status.current, { messages: 6, bonds: 2 });
    assert.equal(status.memory.lcm.status.messageCount, 11);
    assert.deepEqual(status.memory.lcm.latestContextInjection, {
      kind: "assemble",
      at: "2026-06-02T10:04:00.000Z",
      injectedMessageCount: 2,
    });
    assert.deepEqual(status.memory.hindsight.telemetry, {
      enabled: true,
      total: 7,
      byKind: {
        hindsight_recall: 4,
        hindsight_retain: 3,
      },
      failures: 1,
    });
    assert.equal(status.memory.hindsight.latest.error, "hindsight read failed at [redacted-path]");

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /\/workspace\/api-sessions/u);
    assert.doesNotMatch(serialized, /\/state\/api\/sessions/u);
    assert.doesNotMatch(serialized, /raw transcript text/u);
    assert.doesNotMatch(serialized, /events final assistant text/u);
    assert.doesNotMatch(serialized, /events transcript/u);
    assert.doesNotMatch(serialized, /LCM final assistant text/u);
    assert.doesNotMatch(serialized, /LCM assistant message/u);
    assert.doesNotMatch(serialized, /\/lcm\/runtime-summary-root/u);
    assert.doesNotMatch(serialized, /\/lcm\/runtime-summary-large-files/u);
    assert.doesNotMatch(serialized, /\/lcm\/status-root/u);
    assert.doesNotMatch(serialized, /raw LCM status log tail/u);
    assert.doesNotMatch(serialized, /\/workspace\/status-cwd/u);
    assert.doesNotMatch(serialized, /raw LCM message object/u);
    assert.doesNotMatch(serialized, /raw message from runtime/u);
    assert.doesNotMatch(serialized, /hidden memory transcript/u);
    assert.doesNotMatch(serialized, /summary assemble raw context projection/u);
    assert.doesNotMatch(serialized, /summary assemble raw system prompt/u);
    assert.doesNotMatch(serialized, /summary assemble raw message/u);
    assert.doesNotMatch(serialized, /latest LCM context projection/u);
    assert.doesNotMatch(serialized, /latest LCM system prompt/u);
    assert.doesNotMatch(serialized, /hindsight raw history/u);
    assert.doesNotMatch(serialized, /file:\/\/\/workspace/u);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus includes sanitized sandbox telemetry when runtime reports it", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true, health: { service: "beep-agentd" } }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") {
          return {
            ok: true,
            summary: {
              sessionId: "agent_beep",
              sandbox: {
                backend: "docker",
                active: [
                  {
                    sessionId: "agent_beep",
                    generation: 2,
                    status: "running",
                    workspacePath: "/workspace/sandboxes/agent_beep",
                    dockerWorkspacePath: "/srv/beep/workspaces/sandboxes/agent_beep",
                    diagnostics: {
                      containerName: "beep-sandbox-agent_beep-2",
                      runnerPath: "/runtime/bin/beep-sandbox-tool-runner",
                    },
                  },
                ],
              },
            },
          };
        }
        if (path === "/agent/lcm/status") return { ok: true, lcm: { available: true } };
        return { ok: true };
      },
    });

    assert.equal(status.agent.summary.sandbox.backend, "docker");
    assert.equal(status.agent.summary.sandbox.active[0].generation, 2);
    assert.equal(status.agent.summary.sandbox.active[0].status, "running");
    assert.equal(status.agent.summary.sandbox.active[0].workspacePath, undefined);
    assert.equal(status.agent.summary.sandbox.active[0].dockerWorkspacePath, undefined);
    assert.equal(status.agent.summary.sandbox.active[0].diagnostics.runnerPath, undefined);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus treats ok false runtime summary payload as unavailable", async () => {
  const { store, cleanup } = tempStore();
  try {
    const calls = [];
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        calls.push(path);
        if (path === "/agent/summary") {
          return { ok: false, error: "summary failed at /state/api/sessions/agent_beep/session.json" };
        }
        if (path === "/agent/lcm/status") return { ok: true, lcm: { ok: true, status: "ready" } };
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, false);
    assert.equal(status.agent.error, "summary failed at [redacted-path]");
    assert.equal(status.agent.summary, null);
    assert.equal(status.memory.lcm.available, true);
    assert.deepEqual(status.memory.lcm.status, { ok: true, status: "ready" });
    assert.deepEqual(status.memory.hindsight, {
      available: false,
      latest: null,
      telemetry: null,
    });
    assert.deepEqual(calls, ["/agent/summary", "/agent/lcm/status"]);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus treats ok false runtime LCM status payload as unavailable", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") {
          return {
            ok: true,
            summary: {
              sessionId: "agent_beep",
              lcmContextInjection: {
                latest: {
                  kind: "assemble",
                  at: "2026-06-02T10:04:00.000Z",
                  injectedMessageCount: 2,
                },
              },
              hindsightMemory: {
                enabled: true,
                total: 1,
                failures: 0,
                latest: { kind: "hindsight_recall", items: 1 },
              },
            },
          };
        }
        if (path === "/agent/lcm/status") {
          return { ok: false, error: "LCM status failed at file:///opt/lossless-claw/src/db/connection.ts" };
        }
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, true);
    assert.equal(status.memory.lcm.available, false);
    assert.equal(status.memory.lcm.error, "LCM status failed at [redacted-path]");
    assert.equal(status.memory.lcm.status, null);
    assert.deepEqual(status.memory.lcm.latestContextInjection, {
      kind: "assemble",
      at: "2026-06-02T10:04:00.000Z",
      injectedMessageCount: 2,
    });
    assert.equal(status.memory.hindsight.available, true);

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /file:\/\/\/opt/u);
    assert.doesNotMatch(serialized, /lossless-claw/u);
    assert.doesNotMatch(serialized, /connection\.ts/u);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus treats malformed ok true runtime LCM status payload as unavailable", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") return agentSummaryFixture();
        if (path === "/agent/lcm/status") return { ok: true, lcm: null };
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, true);
    assert.equal(status.memory.lcm.available, false);
    assert.equal(status.memory.lcm.error, "runtime LCM status unavailable");
    assert.equal(status.memory.lcm.status, null);
    assert.deepEqual(status.memory.lcm.latestContextInjection, {
      kind: "assemble",
      at: "2026-06-02T10:04:00.000Z",
      injectedMessageCount: 2,
    });
  } finally {
    cleanup();
  }
});

test("buildBackendStatus accepts real top-level runtime LCM status payload", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") return agentSummaryFixture();
        if (path === "/agent/lcm/status") {
          return {
            ok: true,
            status: "ready",
            dbPath: "/lcm/lcm.sqlite",
            lcmRoot: "/lcm",
            dbSizeBytes: 4096,
            rowCounts: { messages: 3 },
            totals: { messageTokens: 10 },
            current: null,
            conversations: [],
            config: {
              databasePath: "/lcm/lcm.sqlite",
              largeFilesDir: "/lcm/large",
            },
            configDiagnostics: { ok: true, warningCount: 0 },
            lcmLogTail: "raw log",
          };
        }
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.memory.lcm.available, true);
    assert.deepEqual(status.memory.lcm.status, {
      ok: true,
      status: "ready",
      dbSizeBytes: 4096,
      rowCounts: { messages: 3 },
      totals: { messageTokens: 10 },
      current: null,
      config: {},
      configDiagnostics: { ok: true, warningCount: 0 },
    });
    assert.equal(status.memory.lcm.status.dbPath, undefined);
    assert.equal(status.memory.lcm.status.lcmRoot, undefined);
    assert.equal(status.memory.lcm.status.config.databasePath, undefined);
    assert.equal(status.memory.lcm.status.config.largeFilesDir, undefined);
    assert.equal(status.memory.lcm.status.lcmLogTail, undefined);

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /\/lcm\/lcm\.sqlite/u);
    assert.doesNotMatch(serialized, /\/lcm\/large/u);
    assert.doesNotMatch(serialized, /raw log/u);
  } finally {
    cleanup();
  }
});

test("buildBackendStatus keeps LCM status available when runtime summary fails", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") {
          throw new Error("summary unavailable at /state/api/sessions/agent_beep/session.json");
        }
        if (path === "/agent/lcm/status") return { ok: true, lcm: { ok: true, status: "ready" } };
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, false);
    assert.equal(status.agent.error, "summary unavailable at [redacted-path]");
    assert.equal(status.agent.summary, null);
    assert.equal(status.memory.lcm.available, true);
    assert.equal(status.memory.lcm.error, null);
    assert.deepEqual(status.memory.lcm.status, { ok: true, status: "ready" });
    assert.equal(status.memory.lcm.latestContextInjection, null);
    assert.deepEqual(status.memory.hindsight, {
      available: false,
      latest: null,
      telemetry: null,
    });
  } finally {
    cleanup();
  }
});

test("buildBackendStatus keeps summary memory available when runtime LCM status fails", async () => {
  const { store, cleanup } = tempStore();
  try {
    const status = await buildBackendStatus({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: true }),
      },
      toolBroker: { manifest: () => ({ tools: [] }) },
      forwardRuntimeRequest: async (path) => {
        if (path === "/agent/summary") return agentSummaryFixture();
        if (path === "/agent/lcm/status") throw new Error("LCM unavailable at /workspace/status-cwd/lcm.json");
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, true);
    assert.equal(status.agent.error, null);
    assert.equal(status.agent.summary.sessionId, "agent_beep");
    assert.equal(status.memory.lcm.available, false);
    assert.equal(status.memory.lcm.error, "LCM unavailable at [redacted-path]");
    assert.equal(status.memory.lcm.status, null);
    assert.deepEqual(status.memory.lcm.latestContextInjection, {
      kind: "assemble",
      at: "2026-06-02T10:04:00.000Z",
      injectedMessageCount: 2,
    });
    assert.deepEqual(status.memory.hindsight.latest, {
      kind: "hindsight_recall",
      at: "2026-06-02T10:03:00.000Z",
      items: 4,
      error: "hindsight read failed at [redacted-path]",
    });
    assert.deepEqual(status.memory.hindsight.telemetry, {
      enabled: true,
      total: 7,
      byKind: {
        hindsight_recall: 4,
        hindsight_retain: 3,
      },
      failures: 1,
    });
  } finally {
    cleanup();
  }
});

test("backend status route requires operator auth and returns status for authenticated request", async () => {
  const { store, cleanup } = tempStore();
  try {
    const calls = [];
    const handler = createControlPlaneHandler({
      store,
      runtimeManager: {
        status: async () => ({
          runtimeId: "local",
          running: true,
          health: {
            ok: true,
            service: "beep-agentd",
            runtimeId: "local",
            agent: {
              lastError: "failed /workspace/My Project/session.json",
            },
          },
        }),
        proxyToRuntime: async (path) => {
          calls.push(path);
          if (path === "/agent/summary") return agentSummaryFixture();
          if (path === "/agent/lcm/status") return { ok: true, lcm: { ok: true, status: "ready" } };
          return { ok: false };
        },
      },
      toolBroker: {
        manifest: () => ({ tools: [{ name: "preview.container.createStaticSite" }] }),
        call: async () => ({ ok: false }),
      },
      localPortProxy: async () => {
        throw new Error("local port proxy should not be called");
      },
    });

    const unauthenticated = captureResponse();
    await handler(request("GET", "/api/backend/status"), unauthenticated.response);
    assert.equal(unauthenticated.json().statusCode, 401);
    assert.deepEqual(calls, []);

    const authenticated = captureResponse();
    await handler(request("GET", "/api/backend/status", operatorHeaders(store)), authenticated.response);
    const { statusCode, payload } = authenticated.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.runtime.running, true);
    assert.equal(payload.runtime.health.agent.lastError, "failed [redacted-path]");
    assert.equal(payload.agent.available, true);
    assert.equal(payload.memory.lcm.available, true);
    assert.deepEqual(payload.controlPlane.tools, { tools: [{ name: "preview.container.createStaticSite" }] });
    assert.deepEqual(calls, ["/agent/summary", "/agent/lcm/status"]);
    assert.doesNotMatch(JSON.stringify(payload), /\/workspace\/My Project/u);
    assert.doesNotMatch(JSON.stringify(payload), /Project\/session\.json/u);
  } finally {
    cleanup();
  }
});
