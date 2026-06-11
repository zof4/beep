import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";
import { handleToolPackageRoute } from "../src/tool-package-routes.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-tool-routes-"));
  return {
    store: new StateStore(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeResponse() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      this.body = body || "";
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
}

function request(method, body = null, headers = { authorization: "Bearer operator" }) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(JSON.stringify(body));
    },
  };
}

function routeOptions({ method = "GET", path = "/api/tools/packages", body = null, store, requireOperatorAuth }) {
  const response = fakeResponse();
  return {
    response,
    options: {
      request: request(method, body),
      response,
      pathname: path,
      url: new URL(`http://127.0.0.1${path}`),
      store,
      requireOperatorAuth,
    },
  };
}

const manifest = {
  schemaVersion: 1,
  packageId: "demo_tools",
  version: "1.0.0",
  packageHash: "sha256:abc123",
  source: "sandbox",
  tools: [
    {
      name: "demo_echo",
      action: "beep.tools.demo_tools.demo_echo",
      namespace: "beep_tools",
      description: "Echo text from the sandbox.",
      inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } } },
      target: "sandbox",
      command: { argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"], input: "json-stdin", timeoutMs: 5000 },
      scopes: ["sandbox.tool.execute"],
      defaultDecision: "review",
    },
  ],
};

test("operator can install and enable a generated tool package", async () => {
  const { store, cleanup } = tempStore();
  try {
    const requireOperatorAuth = (req) => assert.equal(req.headers.authorization, "Bearer operator");

    const installRoute = routeOptions({
      method: "POST",
      path: "/api/tools/packages",
      body: manifest,
      store,
      requireOperatorAuth,
    });
    await handleToolPackageRoute(installRoute.options);

    assert.equal(installRoute.response.statusCode, 200);
    assert.equal(installRoute.response.json().package.packageVersionId, "demo_tools@1.0.0");

    const enableRoute = routeOptions({
      method: "POST",
      path: "/api/tools/packages/demo_tools/1.0.0/tools/demo_echo/enable",
      body: {},
      store,
      requireOperatorAuth,
    });
    await handleToolPackageRoute(enableRoute.options);

    assert.equal(enableRoute.response.statusCode, 200);
    assert.equal(store.listEnabledToolDefinitions()[0].action, "beep.tools.demo_tools.demo_echo");
  } finally {
    cleanup();
  }
});

test("tool package routes require operator auth before reading state", async () => {
  const { store, cleanup } = tempStore();
  try {
    let listCalls = 0;
    store.listToolPackages = () => {
      listCalls += 1;
      return [];
    };
    const authError = new Error("operator token is invalid");
    authError.status = 401;

    const route = routeOptions({
      store,
      requireOperatorAuth: () => {
        throw authError;
      },
    });

    await assert.rejects(() => handleToolPackageRoute(route.options), /operator token is invalid/u);
    assert.equal(listCalls, 0);
  } finally {
    cleanup();
  }
});

test("operator can list and disable package tools", async () => {
  const { store, cleanup } = tempStore();
  try {
    const requireOperatorAuth = (req) => assert.equal(req.headers.authorization, "Bearer operator");
    store.installToolPackage(manifest);
    store.setToolPackageToolEnabled({
      packageId: "demo_tools",
      version: "1.0.0",
      toolName: "demo_echo",
      enabled: true,
      decidedBy: "operator",
    });

    const listRoute = routeOptions({ store, requireOperatorAuth });
    await handleToolPackageRoute(listRoute.options);

    assert.equal(listRoute.response.statusCode, 200);
    assert.equal(listRoute.response.json().packages[0].enabledTools.demo_echo.enabled, true);

    const disableRoute = routeOptions({
      method: "POST",
      path: "/api/tools/packages/demo_tools/1.0.0/tools/demo_echo/disable",
      body: {},
      store,
      requireOperatorAuth,
    });
    await handleToolPackageRoute(disableRoute.options);

    assert.equal(disableRoute.response.statusCode, 200);
    assert.equal(disableRoute.response.json().package.enabledTools.demo_echo.enabled, false);
    assert.deepEqual(store.listEnabledToolDefinitions(), []);
  } finally {
    cleanup();
  }
});

test("unknown package routes return not found", async () => {
  const { store, cleanup } = tempStore();
  try {
    const route = routeOptions({
      path: "/api/tools/packages/demo_tools",
      store,
      requireOperatorAuth: (req) => assert.equal(req.headers.authorization, "Bearer operator"),
    });

    await handleToolPackageRoute(route.options);

    assert.equal(route.response.statusCode, 404);
    assert.equal(route.response.json().error, "not found");
  } finally {
    cleanup();
  }
});
