import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-request-routes-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(method, url, headers = {}, body = null) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => req.end(body));
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

function handlerFor({ store, runtimeManager = null }) {
  return createControlPlaneHandler({
    store,
    runtimeManager:
      runtimeManager ||
      {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async () => {
          throw new Error("runtime proxy should not be called");
        },
      },
    toolBroker: {
      manifest: () => ({ tools: [] }),
      call: async () => ({ ok: false }),
    },
    localPortProxy: async () => {
      throw new Error("local port proxy should not be called");
    },
  });
}

function operatorHeaders(store) {
  return { authorization: `Bearer ${store.ensureOperatorToken()}` };
}

test("request list requires operator auth", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const response = captureResponse();

    await handler(request("GET", "/api/requests"), response.response);

    assert.equal(response.json().statusCode, 401);
  } finally {
    cleanup();
  }
});

test("request list returns stable persisted request records", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const first = store.createAgentRequest({
      runtimeId: "local",
      message: "first",
      source: "api",
      internalNote: "do not expose",
    });
    store.updateAgentRequest(first.requestId, {
      status: "submitted",
      runtimeRequestId: "runtime-1",
      runtimeResult: {
        ok: true,
        request: {
          id: "runtime-1",
          status: "queued",
          createdAt: "2026-06-02T01:00:00.000Z",
          startedAt: null,
          completedAt: null,
          error: null,
          agent: { sessionId: "internal" },
        },
        promptResult: { finalAssistantText: "hidden answer" },
        stderrTail: "hidden stderr",
        stdoutTail: "hidden stdout",
        lcm: { loopCount: 4 },
        extra: { nested: true },
      },
    });

    const response = captureResponse();
    await handler(request("GET", "/api/requests", operatorHeaders(store)), response.response);

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.requests.length, 1);
    assert.deepEqual(Object.keys(payload.requests[0]).sort(), [
      "createdAt",
      "error",
      "message",
      "requestId",
      "runtimeId",
      "runtimeRequestId",
      "runtimeResult",
      "schemaVersion",
      "source",
      "status",
      "updatedAt",
    ]);
    assert.equal(payload.requests[0].requestId, first.requestId);
    assert.equal(payload.requests[0].runtimeRequestId, "runtime-1");
    assert.deepEqual(payload.requests[0].runtimeResult, {
      ok: true,
      error: null,
      request: {
        id: "runtime-1",
        status: "queued",
        createdAt: "2026-06-02T01:00:00.000Z",
        startedAt: null,
        completedAt: null,
        error: null,
      },
    });
    assert.equal(payload.requests[0].runtimeResult.request.agent, undefined);
    assert.equal(payload.requests[0].runtimeResult.promptResult, undefined);
    assert.equal(payload.requests[0].runtimeResult.stderrTail, undefined);
    assert.equal(payload.requests[0].runtimeResult.stdoutTail, undefined);
    assert.equal(payload.requests[0].runtimeResult.lcm, undefined);
    assert.equal(payload.requests[0].runtimeResult.extra, undefined);
    assert.equal(payload.requests[0].internalNote, undefined);
  } finally {
    cleanup();
  }
});

test("request list passes runtimeId filter and clamps limit", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    store.createAgentRequest({ runtimeId: "other", message: "other" });
    store.createAgentRequest({ runtimeId: "local", message: "local-a" });
    store.createAgentRequest({ runtimeId: "local", message: "local-b" });
    for (let index = 0; index < 205; index += 1) {
      store.createAgentRequest({ runtimeId: "bulk", message: `bulk-${index}` });
    }

    const response = captureResponse();
    await handler(request("GET", "/api/requests?runtimeId=local&limit=1", operatorHeaders(store)), response.response);

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.requests.length, 1);
    assert.equal(payload.requests[0].runtimeId, "local");

    const fallbackResponse = captureResponse();
    await handler(request("GET", "/api/requests?runtimeId=local&limit=0", operatorHeaders(store)), fallbackResponse.response);

    const fallback = fallbackResponse.json();
    assert.equal(fallback.statusCode, 200);
    assert.equal(fallback.payload.requests.length, 2);
    assert.deepEqual(
      new Set(fallback.payload.requests.map((entry) => entry.runtimeId)),
      new Set(["local"]),
    );

    const maxResponse = captureResponse();
    await handler(request("GET", "/api/requests?runtimeId=bulk&limit=999", operatorHeaders(store)), maxResponse.response);

    const maxLimited = maxResponse.json();
    assert.equal(maxLimited.statusCode, 200);
    assert.equal(maxLimited.payload.requests.length, 200);
  } finally {
    cleanup();
  }
});

test("single request route returns one stable persisted request record", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const created = store.createAgentRequest({
      runtimeId: "local",
      message: "run this",
      source: "api",
      internalNote: "do not expose",
    });
    store.updateAgentRequest(created.requestId, {
      status: "completed",
      runtimeRequestId: "runtime-2",
      runtimeResult: {
        ok: false,
        error: "top-level runtime error",
        request: {
          id: "runtime-2",
          status: "failed",
          createdAt: "2026-06-02T01:00:00.000Z",
          startedAt: "2026-06-02T01:01:00.000Z",
          completedAt: "2026-06-02T01:02:00.000Z",
          error: "request error",
          promptResult: { finalAssistantText: "hidden final text" },
        },
        agent: { workspacePath: "/hidden/workspace" },
        arbitrary: "hidden",
      },
    });

    const response = captureResponse();
    await handler(request("GET", `/api/requests/${created.requestId}`, operatorHeaders(store)), response.response);

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.request.requestId, created.requestId);
    assert.equal(payload.request.runtimeRequestId, "runtime-2");
    assert.deepEqual(payload.request.runtimeResult, {
      ok: false,
      error: "top-level runtime error",
      request: {
        id: "runtime-2",
        status: "failed",
        createdAt: "2026-06-02T01:00:00.000Z",
        startedAt: "2026-06-02T01:01:00.000Z",
        completedAt: "2026-06-02T01:02:00.000Z",
        error: "request error",
      },
    });
    assert.equal(payload.request.runtimeResult.agent, undefined);
    assert.equal(payload.request.runtimeResult.arbitrary, undefined);
    assert.equal(payload.request.runtimeResult.request.promptResult, undefined);
    assert.equal(payload.request.internalNote, undefined);
  } finally {
    cleanup();
  }
});

test("single request route requires operator auth", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const created = store.createAgentRequest({ runtimeId: "local", message: "run this" });
    const response = captureResponse();

    await handler(request("GET", `/api/requests/${created.requestId}`), response.response);

    assert.equal(response.json().statusCode, 401);
  } finally {
    cleanup();
  }
});

test("single request route returns 404 for a missing request", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const response = captureResponse();

    await handler(request("GET", "/api/requests/cp_req_missing", operatorHeaders(store)), response.response);

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 404);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Unknown requestId/);
  } finally {
    cleanup();
  }
});

test("single request route returns 400 for unsafe request identities", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const response = captureResponse();

    await handler(request("GET", "/api/requests/constructor", operatorHeaders(store)), response.response);

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /unsafe|invalid/i);
  } finally {
    cleanup();
  }
});

test("request read routes return 405 for unsupported authenticated methods", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    const response = captureResponse();

    await handler(request("DELETE", "/api/requests/cp_req_missing", operatorHeaders(store)), response.response);

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 405);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /method not allowed/);
  } finally {
    cleanup();
  }
});

test("POST request submission keeps the existing runtime forwarding behavior", async () => {
  const { store, cleanup } = tempStore();
  try {
    let ensureRuntimeCalls = 0;
    const forwarded = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => {
          ensureRuntimeCalls += 1;
          return { runtimeId: "local", running: true };
        },
        proxyToRuntime: async (path, options) => {
          forwarded.push({ path, options });
          return { ok: true, request: { id: "runtime-post-1" } };
        },
      },
    });
    const response = captureResponse();

    await handler(
      request(
        "POST",
        "/api/requests",
        { ...operatorHeaders(store), "content-type": "application/json" },
        JSON.stringify({ message: "submit me" }),
      ),
      response.response,
    );

    const { statusCode, payload } = response.json();
    const persisted = store.getAgentRequest(payload.requestId);
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(ensureRuntimeCalls, 1);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].path, "/agent/submit");
    assert.equal(JSON.parse(forwarded[0].options.body).message, "submit me");
    assert.equal(persisted.runtimeRequestId, "runtime-post-1");
  } finally {
    cleanup();
  }
});
