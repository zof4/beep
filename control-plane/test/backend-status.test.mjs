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
    error: null,
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
  store.appendAudit({ kind: "manual_status_probe", runtimeId: "local", detail: "included" });

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
        assistantFinalText: "LCM final assistant text must not leave this API",
        assistantMessage: "LCM assistant message must not leave this API",
        workspacePath: "/workspace/hidden",
      },
      lcmContextInjection: {
        latest: {
          kind: "assemble",
          at: "2026-06-02T10:04:00.000Z",
          injectedMessageCount: 2,
        },
      },
      hindsightMemory: {
        latest: {
          kind: "hindsight_recall",
          at: "2026-06-02T10:03:00.000Z",
          items: 4,
        },
        telemetry: {
          total: 7,
          failures: 0,
        },
        transcriptText: "hidden memory transcript",
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
    assert.equal(status.memory.lcm.available, true);
    assert.equal(status.memory.lcm.error, null);
    assert.deepEqual(status.memory.lcm.status, {
      ok: true,
      available: true,
      status: "ready",
      compactedCount: 3,
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
      },
      telemetry: {
        total: 7,
        failures: 0,
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
    assert.ok(status.controlPlane.recentAudit.some((event) => event.kind === "manual_status_probe"));
    assert.deepEqual(status.controlPlane.tools, { tools: [{ name: "preview.container.createStaticSite" }] });
    assert.deepEqual(calls, ["/agent/summary", "/agent/lcm/status"]);
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
        if (path === "/agent/lcm/status") return { ok: true, lcm: { ok: true, status: "ready" } };
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
    assert.equal(status.agent.summary.lcm.assistantFinalText, undefined);
    assert.equal(status.agent.summary.lcm.assistantMessage, undefined);
    assert.deepEqual(status.memory.lcm.latestContextInjection, {
      kind: "assemble",
      at: "2026-06-02T10:04:00.000Z",
      injectedMessageCount: 2,
    });
    assert.deepEqual(status.memory.hindsight.telemetry, { total: 7, failures: 0 });

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /\/workspace\/api-sessions/u);
    assert.doesNotMatch(serialized, /\/state\/api\/sessions/u);
    assert.doesNotMatch(serialized, /raw transcript text/u);
    assert.doesNotMatch(serialized, /events final assistant text/u);
    assert.doesNotMatch(serialized, /events transcript/u);
    assert.doesNotMatch(serialized, /LCM final assistant text/u);
    assert.doesNotMatch(serialized, /LCM assistant message/u);
    assert.doesNotMatch(serialized, /hidden memory transcript/u);
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
        if (path === "/agent/summary") throw new Error("summary unavailable");
        if (path === "/agent/lcm/status") return { ok: true, lcm: { ok: true, status: "ready" } };
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, false);
    assert.equal(status.agent.error, "summary unavailable");
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
        if (path === "/agent/lcm/status") throw new Error("LCM unavailable");
        return { ok: false };
      },
      now: () => "2026-06-02T12:00:00.000Z",
    });

    assert.equal(status.ok, true);
    assert.equal(status.agent.available, true);
    assert.equal(status.agent.error, null);
    assert.equal(status.agent.summary.sessionId, "agent_beep");
    assert.equal(status.memory.lcm.available, false);
    assert.equal(status.memory.lcm.error, "LCM unavailable");
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
    });
    assert.deepEqual(status.memory.hindsight.telemetry, {
      total: 7,
      failures: 0,
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
        status: async () => ({ runtimeId: "local", running: true }),
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
    assert.equal(payload.agent.available, true);
    assert.equal(payload.memory.lcm.available, true);
    assert.deepEqual(payload.controlPlane.tools, { tools: [{ name: "preview.container.createStaticSite" }] });
    assert.deepEqual(calls, ["/agent/summary", "/agent/lcm/status"]);
  } finally {
    cleanup();
  }
});
