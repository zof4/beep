import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-server-boundary-test-"));
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

function handlerFor({ store, runtimeManager = null, localPortProxy = null } = {}) {
  return createControlPlaneHandler({
    store,
    runtimeManager:
      runtimeManager ||
      {
        status: async () => ({ runtimeId: "local", running: false }),
      },
    toolBroker: {
      manifest: () => ({ tools: [] }),
      call: async () => ({ ok: false }),
    },
    localPortProxy:
      localPortProxy ||
      (async () => {
        throw new Error("local port proxy should not be called");
      }),
  });
}

test("runtime status endpoint requires operator auth", async () => {
  const { store, cleanup } = tempStore();
  try {
    let statusCalls = 0;
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => {
          statusCalls += 1;
          return { runtimeId: "local", running: false };
        },
      },
    });

    const unauthenticated = captureResponse();
    await handler(request("GET", "/api/runtimes/local"), unauthenticated.response);

    assert.equal(unauthenticated.json().statusCode, 401);
    assert.equal(statusCalls, 0);

    const operatorToken = store.ensureOperatorToken();
    const authenticated = captureResponse();
    await handler(
      request("GET", "/api/runtimes/local", { authorization: `Bearer ${operatorToken}` }),
      authenticated.response,
    );

    assert.equal(authenticated.json().statusCode, 200);
    assert.equal(statusCalls, 1);
  } finally {
    cleanup();
  }
});

test("preview proxy requires a matching broker-created exposure", async () => {
  const { store, cleanup } = tempStore();
  try {
    const proxyCalls = [];
    const handler = handlerFor({
      store,
      localPortProxy: async (_request, response, hostPort, suffixPath) => {
        proxyCalls.push({ hostPort, suffixPath });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      },
    });

    const missing = captureResponse();
    await handler(request("GET", "/preview/local/3000/index.html"), missing.response);

    assert.equal(missing.json().statusCode, 404);
    assert.equal(proxyCalls.length, 0);

    store.upsertExposure({
      runtimeId: "local",
      containerPort: 3000,
      hostPort: 13000,
      baseUrl: "http://127.0.0.1/preview/local/3000/",
    });

    const exposed = captureResponse();
    await handler(request("GET", "/preview/local/3000/index.html"), exposed.response);

    assert.equal(exposed.json().statusCode, 200);
    assert.deepEqual(proxyCalls, [{ hostPort: 13000, suffixPath: "index.html" }]);
  } finally {
    cleanup();
  }
});
