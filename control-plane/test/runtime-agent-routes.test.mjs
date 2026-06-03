import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { handleRuntimeAgentRoute } from "../src/runtime-agent-routes.mjs";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

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

async function callRoute({
  method = "GET",
  target = "/api/agent",
  body = null,
  authOk = true,
  runtimeResult = null,
  runtimeError = null,
}) {
  const calls = [];
  let authCalls = 0;
  const req = request(method, target, {}, body === null ? null : JSON.stringify(body));
  const url = new URL(target, "http://127.0.0.1");
  const response = captureResponse();
  await handleRuntimeAgentRoute({
    request: req,
    response: response.response,
    pathname: url.pathname,
    url,
    requireOperatorAuth(requestForAuth) {
      authCalls += 1;
      assert.equal(requestForAuth, req);
      if (!authOk) {
        const error = new Error("operator token is invalid");
        error.status = 401;
        throw error;
      }
    },
    forwardRuntimeRequest: async (path, options = {}) => {
      calls.push({ path, options });
      if (runtimeError) throw runtimeError;
      return runtimeResult || { ok: true, path };
    },
  });
  return { authCalls, calls, ...response.json() };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-runtime-agent-routes-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function handlerFor({ store, runtimeManager }) {
  return createControlPlaneHandler({
    store,
    runtimeManager,
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

test("summary and events proxy through operator auth and preserve event query string", async () => {
  const summary = await callRoute({ target: "/api/agent/summary" });
  assert.equal(summary.authCalls, 1);
  assert.deepEqual(summary.calls, [{ path: "/agent/summary", options: { method: "GET" } }]);
  assert.equal(summary.statusCode, 200);
  assert.deepEqual(summary.payload, { ok: true, path: "/agent/summary" });

  const events = await callRoute({ target: "/api/agent/events?limit=10" });
  assert.equal(events.authCalls, 1);
  assert.deepEqual(events.calls, [{ path: "/agent/events?limit=10", options: { method: "GET" } }]);
  assert.equal(events.statusCode, 200);
  assert.deepEqual(events.payload, { ok: true, path: "/agent/events?limit=10" });
});

test("agent request list and detail proxy to runtime request paths", async () => {
  const list = await callRoute({ target: "/api/agent/requests" });
  assert.deepEqual(list.calls, [{ path: "/agent/requests", options: { method: "GET" } }]);
  assert.equal(list.statusCode, 200);

  const detail = await callRoute({ target: "/api/agent/requests/request-123" });
  assert.deepEqual(detail.calls, [{ path: "/agent/requests/request-123", options: { method: "GET" } }]);
  assert.equal(detail.statusCode, 200);
});

test("LCM status and doctor proxy to runtime LCM paths", async () => {
  const status = await callRoute({ target: "/api/agent/lcm/status" });
  assert.deepEqual(status.calls, [{ path: "/agent/lcm/status", options: { method: "GET" } }]);
  assert.equal(status.statusCode, 200);

  const doctor = await callRoute({ target: "/api/agent/lcm/doctor" });
  assert.deepEqual(doctor.calls, [{ path: "/agent/lcm/doctor", options: { method: "GET" } }]);
  assert.equal(doctor.statusCode, 200);
});

test("LCM compact POST parses JSON and passes body object to forwardRuntimeRequest", async () => {
  const result = await callRoute({
    method: "POST",
    target: "/api/agent/lcm/compact",
    body: { maxTurns: 12, dryRun: true },
  });

  assert.equal(result.authCalls, 1);
  assert.deepEqual(result.calls, [
    { path: "/agent/lcm/compact", options: { method: "POST", body: { maxTurns: 12, dryRun: true } } },
  ]);
  assert.equal(result.statusCode, 200);
});

test("LCM record POST parses JSON and proxies to the generic runtime LCM route", async () => {
  const result = await callRoute({
    method: "POST",
    target: "/api/agent/lcm",
    body: { force: true },
  });

  assert.equal(result.authCalls, 1);
  assert.deepEqual(result.calls, [
    { path: "/agent/lcm", options: { method: "POST", body: { force: true } } },
  ]);
  assert.equal(result.statusCode, 200);
});

test("LCM assemble-preview and rotate POST parse JSON and pass body objects", async () => {
  const assemblePreview = await callRoute({
    method: "POST",
    target: "/api/agent/lcm/assemble-preview",
    body: { requestId: "request-123", dryRun: true },
  });
  assert.deepEqual(assemblePreview.calls, [
    {
      path: "/agent/lcm/assemble-preview",
      options: { method: "POST", body: { requestId: "request-123", dryRun: true } },
    },
  ]);
  assert.equal(assemblePreview.statusCode, 200);

  const rotate = await callRoute({
    method: "POST",
    target: "/api/agent/lcm/rotate",
    body: { keep: 4 },
  });
  assert.deepEqual(rotate.calls, [
    { path: "/agent/lcm/rotate", options: { method: "POST", body: { keep: 4 } } },
  ]);
  assert.equal(rotate.statusCode, 200);
});

test("missing operator auth rejects before forwarding", async () => {
  await assert.rejects(
    () => callRoute({ target: "/api/agent/summary", authOk: false }),
    /operator token is invalid/u,
  );
});

test("runtime proxy failures return 502 with runtime payload", async () => {
  const result = await callRoute({
    target: "/api/agent/lcm/status",
    runtimeResult: { ok: false, error: "runtime unavailable" },
  });

  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.payload, { ok: false, error: "runtime unavailable" });
});

test("runtime proxy thrown errors return 502 with upstream payload details", async () => {
  const error = new Error("LCM compact failed");
  error.status = 409;
  error.payload = { ok: false, compact: { ok: false, reason: "busy" } };
  const result = await callRoute({
    method: "POST",
    target: "/api/agent/lcm/compact",
    body: { force: true },
    runtimeError: error,
  });

  assert.equal(result.statusCode, 502);
  assert.deepEqual(result.payload, {
    ok: false,
    error: "LCM compact failed",
    upstreamStatus: 409,
    upstream: { ok: false, compact: { ok: false, reason: "busy" } },
  });
});

test("unsupported methods on known route return 405", async () => {
  const result = await callRoute({ method: "POST", target: "/api/agent/summary", body: { ignored: true } });

  assert.equal(result.authCalls, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(result.statusCode, 405);
  assert.deepEqual(result.payload, { ok: false, error: "method not allowed" });
});

test("GET on generic LCM POST route returns 405", async () => {
  const result = await callRoute({ method: "GET", target: "/api/agent/lcm" });

  assert.equal(result.authCalls, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(result.statusCode, 405);
  assert.deepEqual(result.payload, { ok: false, error: "method not allowed" });
});

test("unsupported methods on assemble-preview and rotate return 405", async () => {
  const assemblePreview = await callRoute({ method: "GET", target: "/api/agent/lcm/assemble-preview" });
  assert.deepEqual(assemblePreview.calls, []);
  assert.equal(assemblePreview.statusCode, 405);
  assert.deepEqual(assemblePreview.payload, { ok: false, error: "method not allowed" });

  const rotate = await callRoute({ method: "GET", target: "/api/agent/lcm/rotate" });
  assert.deepEqual(rotate.calls, []);
  assert.equal(rotate.statusCode, 405);
  assert.deepEqual(rotate.payload, { ok: false, error: "method not allowed" });
});

test("unknown agent paths return 404", async () => {
  const result = await callRoute({ target: "/api/agent/lcm/nope" });

  assert.equal(result.authCalls, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.payload, { ok: false, error: "not found" });
});

test("encoded dot segments and separators return 400 without forwarding", async () => {
  for (const target of ["/api/agent/requests/%2e%2e", "/api/agent/requests/%2E%2E", "/api/agent/requests/a%2fb"]) {
    const result = await callRoute({ target });
    assert.equal(result.authCalls, 1);
    assert.deepEqual(result.calls, []);
    assert.equal(result.statusCode, 400);
    assert.match(result.payload.error, /unsafe encoded path/u);
  }
});

test("createControlPlaneHandler delegates agent routes through managed runtime proxy", async () => {
  const { store, cleanup } = tempStore();
  try {
    const proxyCalls = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async (path, options) => {
          proxyCalls.push({ path, options });
          return { ok: true, path, body: options.body ? JSON.parse(options.body) : null };
        },
      },
    });

    const unauthenticated = captureResponse();
    await handler(request("GET", "/api/agent/summary"), unauthenticated.response);

    assert.equal(unauthenticated.json().statusCode, 401);
    assert.deepEqual(proxyCalls, []);

    const response = captureResponse();
    await handler(
      request(
        "POST",
        "/api/agent/lcm/backup",
        { ...operatorHeaders(store), "content-type": "application/json" },
        JSON.stringify({ includeSnapshots: true }),
      ),
      response.response,
    );

    assert.equal(response.json().statusCode, 200);
    assert.deepEqual(response.json().payload, {
      ok: true,
      path: "/agent/lcm/backup",
      body: { includeSnapshots: true },
    });
    assert.deepEqual(proxyCalls, [
      {
        path: "/agent/lcm/backup",
        options: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ includeSnapshots: true }),
        },
      },
    ]);

    const events = captureResponse();
    await handler(
      request("GET", "/api/agent/events?limit=10", operatorHeaders(store)),
      events.response,
    );

    assert.equal(events.json().statusCode, 200);
    assert.deepEqual(events.json().payload, {
      ok: true,
      path: "/agent/events?limit=10",
      body: null,
    });
    assert.deepEqual(proxyCalls[1], {
      path: "/agent/events?limit=10",
      options: {
        method: "GET",
        headers: {},
        body: undefined,
      },
    });
  } finally {
    cleanup();
  }
});

test("createControlPlaneHandler maps thrown runtime proxy payloads to 502", async () => {
  const { store, cleanup } = tempStore();
  try {
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async () => {
          const error = new Error("LCM compact failed");
          error.status = 409;
          error.payload = { ok: false, compact: { ok: false, reason: "busy" } };
          throw error;
        },
      },
    });

    const response = captureResponse();
    await handler(
      request(
        "POST",
        "/api/agent/lcm/compact",
        { ...operatorHeaders(store), "content-type": "application/json" },
        JSON.stringify({ force: true }),
      ),
      response.response,
    );

    assert.equal(response.json().statusCode, 502);
    assert.deepEqual(response.json().payload, {
      ok: false,
      error: "LCM compact failed",
      upstreamStatus: 409,
      upstream: { ok: false, compact: { ok: false, reason: "busy" } },
    });
  } finally {
    cleanup();
  }
});

test("createControlPlaneHandler keeps invalid JSON body errors as 400", async () => {
  const { store, cleanup } = tempStore();
  try {
    const proxyCalls = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async (path, options) => {
          proxyCalls.push({ path, options });
          return { ok: true };
        },
      },
    });

    const response = captureResponse();
    await handler(
      request("POST", "/api/agent/lcm", { ...operatorHeaders(store), "content-type": "application/json" }, "{"),
      response.response,
    );

    assert.equal(response.json().statusCode, 400);
    assert.match(response.json().payload.error, /invalid JSON body/u);
    assert.deepEqual(proxyCalls, []);
  } finally {
    cleanup();
  }
});

test("createControlPlaneHandler rejects unsafe raw agent paths before normalized dispatch or proxying", async () => {
  const { store, cleanup } = tempStore();
  try {
    const proxyCalls = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async (path, options) => {
          proxyCalls.push({ path, options });
          return { ok: true };
        },
      },
    });

    for (const target of [
      "/api/agent/%2e%2e/requests",
      "/api/agent/requests/a%2fb",
      "/api/agent/requests/%2e%2e#frag",
      "/x/%2e%2e/api/agent/summary",
      "http://control.test/api/agent/%2e%2e/requests",
    ]) {
      const response = captureResponse();
      await handler(request("GET", target, operatorHeaders(store)), response.response);

      assert.equal(response.json().statusCode, 400);
      assert.match(response.json().payload.error, /unsafe encoded path/u);
    }
    assert.deepEqual(proxyCalls, []);
  } finally {
    cleanup();
  }
});

test("createControlPlaneHandler rejects unsafe raw agent-looking paths before auth", async () => {
  const { store, cleanup } = tempStore();
  try {
    const proxyCalls = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => ({ runtimeId: "local", running: true }),
        proxyToRuntime: async (path, options) => {
          proxyCalls.push({ path, options });
          return { ok: true };
        },
      },
    });

    const response = captureResponse();
    await handler(request("GET", "/api/agent/%2e%2e/requests"), response.response);

    assert.equal(response.json().statusCode, 400);
    assert.match(response.json().payload.error, /unsafe encoded path/u);
    assert.deepEqual(proxyCalls, []);
  } finally {
    cleanup();
  }
});
