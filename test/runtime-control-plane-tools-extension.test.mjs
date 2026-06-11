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
      Number(schema = {}) { return { type: "number", ...schema }; },
      String(schema = {}) { return { type: "string", ...schema }; },
      Boolean(schema = {}) { return { type: "boolean", ...schema }; },
      Array(items, schema = {}) { return { type: "array", items, ...schema }; },
      Optional(schema) { return { optional: true, schema }; },
    };`,
  );
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(sourceWithTypeShim)}#${Date.now()}-${Math.random()}`;
  return import(moduleUrl);
}

async function registeredTools() {
  const { default: extension } = await loadExtension();
  const tools = [];
  await extension({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return tools;
}

function withExtensionEnv(callback, options = {}) {
  const toolsEnabled = Object.hasOwn(options, "toolsEnabled") ? options.toolsEnabled : "1";
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
  if (toolsEnabled === undefined) {
    delete process.env.BEEP_CONTROL_PLANE_TOOLS_ENABLED;
  } else {
    process.env.BEEP_CONTROL_PLANE_TOOLS_ENABLED = toolsEnabled;
  }
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

function manifestTools() {
  return [
    {
      name: "web_run",
      action: "web.run",
      label: "Web Search",
      description: "Search current public web content.",
      promptSnippet: "Use web_run when current public web information is required.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          search_query: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["q"],
              properties: {
                q: { type: "string", description: "Search query." },
                recency: { type: "integer", minimum: 0 },
                domains: { type: "array", items: { type: "string" } },
              },
            },
          },
          response_length: {
            type: "string",
            enum: ["short", "medium", "long"],
          },
        },
      },
    },
    {
      name: "demo_echo",
      action: "beep.tools.demo_tools.demo_echo",
      label: "Demo Echo",
      description: "Echo text through a generated sandbox tool.",
      promptSnippet: "Use demo_echo to echo text.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          text: { type: "string", description: "Text to echo." },
          loud: { type: "boolean" },
          count: { type: "number" },
        },
      },
    },
  ];
}

function manifestResponse({ ok = true, tools = manifestTools() } = {}) {
  return {
    ok,
    statusText: ok ? "OK" : "Server Error",
    json: async () => ({ ok, tools }),
  };
}

test("extension defaults off when tools enabled env is unset", async () => {
  await withExtensionEnv(
    async () => {
      const tools = await registeredTools();
      assert.deepEqual(tools, []);
    },
    { toolsEnabled: undefined },
  );
});

test("extension registers tools when explicitly enabled", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return manifestResponse();
    };

    try {
      const tools = await registeredTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["demo_echo", "web_run"],
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://control-plane.test/root/api/tools");
      assert.equal(calls[0].options.method, "GET");
      assert.equal(calls[0].options.headers.authorization, "Bearer runtime-token");

      const webRun = tools.find((tool) => tool.name === "web_run");
      assert.equal(webRun.label, "Web Search");
      assert.equal(webRun.description, "Search current public web content.");
      assert.equal(webRun.promptSnippet, "Use web_run when current public web information is required.");
      assert.equal(webRun.parameters.schema.search_query.optional, true);
      assert.equal(webRun.parameters.schema.search_query.schema.type, "array");
      assert.equal(webRun.parameters.schema.search_query.schema.items.schema.q.type, "string");
      assert.equal(webRun.parameters.schema.search_query.schema.items.schema.recency.optional, true);
      assert.equal(webRun.parameters.schema.search_query.schema.items.schema.domains.schema.items.type, "string");

      const demoEcho = tools.find((tool) => tool.name === "demo_echo");
      assert.equal(demoEcho.parameters.schema.text.type, "string");
      assert.equal(demoEcho.parameters.schema.loud.optional, true);
      assert.equal(demoEcho.parameters.schema.count.optional, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("manifest tool posts to internal tools call with runtime token and request body", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/api/tools")) {
        return manifestResponse();
      }
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({
          ok: true,
          result: {
            text: "echo: hello",
          },
        }),
      };
    };

    try {
      const tools = await registeredTools();
      const tool = tools.find((candidate) => candidate.name === "demo_echo");
      assert.ok(tool, "demo_echo should be registered");
      assert.equal(
        process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN,
        undefined,
        "extension should remove the runtime tool token from shell-visible process.env after capture",
      );

      const result = await tool.execute("tool-call-1", { text: "hello" });

      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "http://control-plane.test/root/api/tools");
      assert.equal(calls[1].url, "http://control-plane.test/root/internal/tools/call");
      assert.equal(calls[1].options.method, "POST");
      assert.equal(calls[1].options.headers.authorization, "Bearer runtime-token");
      assert.notEqual(calls[1].options.headers.authorization, "Bearer operator-token");
      assert.notEqual(calls[1].options.headers.authorization, "Bearer model-token");
      assert.deepEqual(JSON.parse(calls[1].options.body), {
        runtimeId: "runtime-alpha",
        action: "beep.tools.demo_tools.demo_echo",
        args: { text: "hello" },
        toolCallId: "tool-call-1",
      });
      assert.equal(textFromResult(result), "echo: hello");
      assert.equal(result.details.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("manifest tool normalizes needs_review and denied payloads into text results", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      manifestResponse(),
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
      const tool = tools.find((candidate) => candidate.name === "demo_echo");
      assert.ok(tool, "demo_echo should be registered");

      const reviewResult = await tool.execute("tool-call-2", { text: "hello" });
      assert.match(textFromResult(reviewResult), /waiting for user\/operator approval/u);
      assert.match(textFromResult(reviewResult), /approval-1/u);
      assert.equal(reviewResult.details.status, "needs_review");

      const deniedResult = await tool.execute("tool-call-3", { text: "hello" });
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
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      if (String(url).endsWith("/api/tools")) {
        return manifestResponse();
      }
      throw new Error("network down");
    };

    try {
      const tools = await registeredTools();
      const tool = tools.find((candidate) => candidate.name === "web_run");
      const result = await tool.execute("tool-call-4", { search_query: [{ q: "beep" }] });

      assert.equal(calls, 2);
      assert.match(textFromResult(result), /web_run failed: network down/u);
      assert.equal(result.details.ok, false);
      assert.equal(result.details.status, "request_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("extension registers nothing when manifest fetch fails or tools payload is invalid", async () => {
  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("manifest unavailable");
    };

    try {
      assert.deepEqual(await registeredTools(), []);
      assert.equal(process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => manifestResponse({ ok: false });

    try {
      assert.deepEqual(await registeredTools(), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await withExtensionEnv(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => manifestResponse({ tools: { web_run: {} } });

    try {
      assert.deepEqual(await registeredTools(), []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
