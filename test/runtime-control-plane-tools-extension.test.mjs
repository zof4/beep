import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const extensionPath = new URL("../runtime/pi-extensions/control-plane-tools-extension.mjs", import.meta.url);
const extensionSource = readFileSync(extensionPath, "utf8");

async function loadExtension() {
  const sourceWithTypeShim = extensionSource.replace(
    /^import \{ Type \} from "@earendil-works\/pi-ai";$/m,
    `const Type = {
      Object(schema) { return { type: "object", schema }; },
      Integer(schema = {}) { return { type: "integer", ...schema }; },
      String(schema = {}) { return { type: "string", ...schema }; },
      Optional(schema) { return { optional: true, schema }; },
    };`,
  );
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(sourceWithTypeShim)}#${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

async function registeredTools() {
  const { default: extension } = await loadExtension();
  const tools = [];
  extension({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return tools;
}

function withExtensionEnv(callback) {
  const keys = [
    "BEEP_CONTROL_PLANE_TOOLS_ENABLED",
    "BEEP_CONTROL_PLANE_URL",
    "BEEP_CONTROL_PLANE_RUNTIME_ID",
    "BEEP_CONTROL_PLANE_RUNTIME_TOKEN",
    "BEEP_CONTROL_PLANE_OPERATOR_TOKEN",
    "BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN",
    "BEEP_MODEL_GATEWAY_CREDENTIAL_URL",
  ];
  const originalEnv = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.BEEP_CONTROL_PLANE_TOOLS_ENABLED = "1";
  process.env.BEEP_CONTROL_PLANE_URL = "http://control-plane.test/root/";
  process.env.BEEP_CONTROL_PLANE_RUNTIME_ID = "runtime-alpha";
  process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN = "runtime-token";
  process.env.BEEP_CONTROL_PLANE_OPERATOR_TOKEN = "operator-token";
  process.env.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN = "model-token";
  process.env.BEEP_MODEL_GATEWAY_CREDENTIAL_URL = "http://model-gateway.test/credential";
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of originalEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function textFromResult(result) {
  return result?.content?.map((part) => part?.text || "").join("\n") || "";
}

test("preview_port_expose posts to internal tools call with runtime token and request body", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, options = {}) => {
      seen = { url: String(url), options };
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({
          ok: true,
          result: {
            url: "http://preview.test/",
            directUrl: "http://127.0.0.1:3000/",
            note: "ready",
          },
        }),
      };
    };

    try {
      const tools = await registeredTools();
      const tool = tools.find((candidate) => candidate.name === "preview_port_expose");
      assert.ok(tool, "preview_port_expose should be registered");

      const result = await tool.execute("tool-call-1", { port: 3000, path: "/", label: "site" });

      assert.equal(seen.url, "http://control-plane.test/root/internal/tools/call");
      assert.equal(seen.options.method, "POST");
      assert.equal(seen.options.headers.authorization, "Bearer runtime-token");
      assert.notEqual(seen.options.headers.authorization, "Bearer operator-token");
      assert.notEqual(seen.options.headers.authorization, "Bearer model-token");
      assert.deepEqual(JSON.parse(seen.options.body), {
        runtimeId: "runtime-alpha",
        action: "preview.port.expose",
        args: { port: 3000, path: "/", label: "site" },
        toolCallId: "tool-call-1",
      });
      assert.match(textFromResult(result), /Preview exposed: http:\/\/preview\.test\//u);
      assert.equal(result.details.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("preview static-site tool normalizes needs_review and denied payloads into text results", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      {
        ok: true,
        statusText: "OK",
        json: async () => ({
          ok: false,
          status: "needs_review",
          approvalId: "approval-1",
          approval: { prompt: "Approve static preview?" },
        }),
      },
      {
        ok: true,
        statusText: "OK",
        json: async () => ({
          ok: false,
          status: "denied",
          error: "Denied by policy.",
        }),
      },
    ];
    globalThis.fetch = async () => responses.shift();

    try {
      const tools = await registeredTools();
      const tool = tools.find((candidate) => candidate.name === "preview_container_create_static_site");
      assert.ok(tool, "preview_container_create_static_site should be registered");

      const reviewResult = await tool.execute("tool-call-2", { siteName: "docs", sourcePath: "/workspace/docs" });
      assert.match(textFromResult(reviewResult), /waiting for user\/operator approval/u);
      assert.match(textFromResult(reviewResult), /approval-1/u);
      assert.equal(reviewResult.details.status, "needs_review");

      const deniedResult = await tool.execute("tool-call-3", { siteName: "docs", sourcePath: "/workspace/docs" });
      assert.match(textFromResult(deniedResult), /failed: Denied by policy\./u);
      assert.equal(deniedResult.details.ok, false);
      assert.equal(deniedResult.details.status, "denied");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("tool execute normalizes fetch failures into structured text results", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    try {
      const tools = await registeredTools();
      const tool = tools.find((candidate) => candidate.name === "preview_port_expose");
      const result = await tool.execute("tool-call-4", { port: 3001 });

      assert.match(textFromResult(result), /preview_port_expose failed: network down/u);
      assert.equal(result.details.ok, false);
      assert.equal(result.details.status, "request_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
