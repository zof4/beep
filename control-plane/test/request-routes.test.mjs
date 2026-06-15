import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler, MAX_NATIVE_REQUEST_BYTES } from "../src/server.mjs";
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
      input: [
        { type: "text", text: "first" },
        { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
      ],
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
      "inputSummary",
      "redactedInput",
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
    assert.equal(payload.requests[0].redactedInput[1].data, "[redacted]");
    assert.equal(payload.requests[0].input?.[1]?.data, undefined);
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

test("request read routes tolerate legacy records without native input", async () => {
  const { store, cleanup } = tempStore();
  try {
    const legacyRequestId = "cp_req_legacy";
    store.update((state) => {
      state.agentRequests[legacyRequestId] = {
        schemaVersion: 1,
        requestId: legacyRequestId,
        runtimeId: "local",
        runtimeRequestId: "runtime-legacy",
        message: "legacy secret",
        status: "submitted",
        source: "api",
        error: null,
        createdAt: "2026-06-02T01:00:00.000Z",
        updatedAt: "2026-06-02T01:00:00.000Z",
      };
    });
    const handler = handlerFor({ store });

    const listResponse = captureResponse();
    await handler(request("GET", "/api/requests", operatorHeaders(store)), listResponse.response);
    const list = listResponse.json();
    assert.equal(list.statusCode, 200);
    assert.equal(list.payload.requests[0].requestId, legacyRequestId);
    assert.equal(list.payload.requests[0].inputSummary, null);
    assert.deepEqual(list.payload.requests[0].redactedInput, []);
    assert.equal(list.payload.requests[0].message, undefined);
    assert.equal(list.payload.requests[0].input, undefined);

    const singleResponse = captureResponse();
    await handler(request("GET", `/api/requests/${legacyRequestId}`, operatorHeaders(store)), singleResponse.response);
    const single = singleResponse.json();
    assert.equal(single.statusCode, 200);
    assert.equal(single.payload.request.inputSummary, null);
    assert.deepEqual(single.payload.request.redactedInput, []);
    assert.equal(single.payload.request.message, undefined);
    assert.equal(single.payload.request.input, undefined);
  } finally {
    cleanup();
  }
});

test("request list passes runtimeId filter and clamps limit", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({ store });
    store.createAgentRequest({ runtimeId: "other", input: [{ type: "text", text: "other" }] });
    store.createAgentRequest({ runtimeId: "local", input: [{ type: "text", text: "local-a" }] });
    store.createAgentRequest({ runtimeId: "local", input: [{ type: "text", text: "local-b" }] });
    for (let index = 0; index < 205; index += 1) {
      store.createAgentRequest({ runtimeId: "bulk", input: [{ type: "text", text: `bulk-${index}` }] });
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
      input: [{ type: "text", text: "run this" }],
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
    const created = store.createAgentRequest({ runtimeId: "local", input: [{ type: "text", text: "run this" }] });
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

test("POST request submission forwards native input unchanged and persists a redacted summary", async () => {
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
        JSON.stringify({
          input: [
            { type: "text", text: "submit me" },
            { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
          ],
        }),
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
    assert.deepEqual(JSON.parse(forwarded[0].options.body).input, [
      { type: "text", text: "submit me" },
      { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
    ]);
    assert.equal(persisted.runtimeRequestId, "runtime-post-1");
    assert.equal(persisted.input[1].data, "ZmFrZQ==");
    assert.equal(persisted.inputSummary.imageParts[0].byteLength, 4);
  } finally {
    cleanup();
  }
});

test("POST request submission accepts native image bodies larger than the default JSON limit", async () => {
  const { store, cleanup } = tempStore();
  try {
    assert.ok(MAX_NATIVE_REQUEST_BYTES >= 36 * 1024 * 1024);
    const inlineImageBytes = 1024 * 1024 + 1;
    const imageData = Buffer.alloc(inlineImageBytes, 1).toString("base64");
    const forwarded = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async (path, options) => {
          forwarded.push({ path, options });
          return { ok: true, request: { id: "runtime-large-post-1" } };
        },
      },
    });
    const response = captureResponse();

    await handler(
      request(
        "POST",
        "/api/requests",
        { ...operatorHeaders(store), "content-type": "application/json" },
        JSON.stringify({
          input: [
            { type: "text", text: "large image" },
            { type: "image", mimeType: "image/png", data: imageData },
          ],
        }),
      ),
      response.response,
    );

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(forwarded.length, 1);
    assert.equal(JSON.parse(forwarded[0].options.body).input[1].data.length, imageData.length);
  } finally {
    cleanup();
  }
});

test("POST request submission returns 400 for invalid native input", async () => {
  const { store, cleanup } = tempStore();
  try {
    let ensureRuntimeCalls = 0;
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => {
          ensureRuntimeCalls += 1;
          return { runtimeId: "local", running: true };
        },
        proxyToRuntime: async () => {
          throw new Error("runtime proxy should not be called");
        },
      },
    });
    const response = captureResponse();

    await handler(
      request(
        "POST",
        "/api/requests",
        { ...operatorHeaders(store), "content-type": "application/json" },
        JSON.stringify({ input: [{ type: "text", text: "" }] }),
      ),
      response.response,
    );

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 400);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /empty text/);
    assert.equal(ensureRuntimeCalls, 0);
  } finally {
    cleanup();
  }
});
