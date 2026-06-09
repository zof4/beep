import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const extensionPath = new URL("../runtime/pi-extensions/sandbox-tool-portal-extension.mjs", import.meta.url);
const runtimePath = new URL("../runtime/pi-extensions/sandbox-tool-portal-runtime.mjs", import.meta.url);
const extensionSource = readFileSync(extensionPath, "utf8");
const runtimeSource = readFileSync(runtimePath, "utf8");

async function loadExtension() {
  const runtimeModuleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(runtimeSource)}#runtime-${Date.now()}-${Math.random()}`;
  const sourceWithRuntimeShim = extensionSource.replace(
    /^import \{ readSandboxPortalConfig, registerSandboxPortalTools \} from "\.\/sandbox-tool-portal-runtime\.mjs";$/m,
    `import { readSandboxPortalConfig, registerSandboxPortalTools } from "${runtimeModuleUrl}";`,
  );
  const sourceWithTypeShim = sourceWithRuntimeShim.replace(
    /^import \{ Type \} from "@earendil-works\/pi-ai";$/m,
    `const Type = {
      Array(schema, options = {}) { return { type: "array", items: schema, ...options }; },
      Object(schema, options = {}) { return { type: "object", schema, ...options }; },
      Integer(schema = {}) { return { type: "integer", ...schema }; },
      Number(schema = {}) { return { type: "number", ...schema }; },
      Boolean(schema = {}) { return { type: "boolean", ...schema }; },
      String(schema = {}) { return { type: "string", ...schema }; },
      Optional(schema) { return { optional: true, schema }; },
    };`,
  );
  const sourceWithTextShim = sourceWithTypeShim.replace(
    /^import \{ Text \} from "@earendil-works\/pi-tui";$/m,
    `class Text {
      constructor(text = "") { this.text = text; }
      setText(text) { this.text = text; }
    }`,
  );
  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(sourceWithTextShim)}#${Date.now()}-${Math.random()}`;
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

function withPortalEnv(callback, options = {}) {
  const enabled = Object.hasOwn(options, "enabled") ? options.enabled : "1";
  const keys = [
    "BEEP_SANDBOX_TOOL_PORTAL_ENABLED",
    "BEEP_SANDBOX_TOOL_PORTAL_URL",
    "BEEP_SANDBOX_TOOL_PORTAL_TOKEN",
    "BEEP_RUNTIME_API_TOKEN",
  ];
  const originalEnv = new Map(keys.map((key) => [key, process.env[key]]));
  if (enabled === undefined) delete process.env.BEEP_SANDBOX_TOOL_PORTAL_ENABLED;
  else process.env.BEEP_SANDBOX_TOOL_PORTAL_ENABLED = enabled;
  process.env.BEEP_SANDBOX_TOOL_PORTAL_URL = "http://runtime.test/internal/sandbox/tools/call";
  process.env.BEEP_SANDBOX_TOOL_PORTAL_TOKEN = "portal-token";
  process.env.BEEP_RUNTIME_API_TOKEN = "runtime-api-token";
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of originalEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function textFromResult(result) {
  return result?.content?.map((part) => part?.text || "").join("\n") || "";
}

test("sandbox portal extension defaults off", async () => {
  await withPortalEnv(
    async () => {
      assert.deepEqual(await registeredTools(), []);
    },
    { enabled: undefined },
  );
});

test("sandbox portal extension registers same-name Pi work tools", async () => {
  await withPortalEnv(async () => {
    const tools = await registeredTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["bash", "edit", "find", "grep", "ls", "read", "write"],
    );
    assert.equal(tools.some((tool) => tool.name === "sandbox_bash"), false);
    assert.ok(tools.find((tool) => tool.name === "edit")?.renderCall, "edit must avoid built-in local preview rendering");
  });
});

test("sandbox portal extension removes sensitive portal env after reading config", async () => {
  await withPortalEnv(async () => {
    await registeredTools();
    assert.equal(process.env.BEEP_SANDBOX_TOOL_PORTAL_TOKEN, undefined);
    assert.equal(process.env.BEEP_RUNTIME_API_TOKEN, undefined);
  });
});

test("bash portal tool posts same-name request to runtime route", async () => {
  await withPortalEnv(async () => {
    const originalFetch = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (url, options = {}) => {
      seen = { url: String(url), options };
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({
          ok: true,
          content: [{ type: "text", text: "portal-ok" }],
          details: { exitCode: 0 },
        }),
      };
    };

    try {
      const tools = await registeredTools();
      const bash = tools.find((tool) => tool.name === "bash");
      const result = await bash.execute("call_bash", { command: "printf portal-ok" });

      assert.equal(seen.url, "http://runtime.test/internal/sandbox/tools/call");
      assert.equal(seen.options.method, "POST");
      assert.equal(seen.options.headers.authorization, "Bearer portal-token");
      assert.deepEqual(JSON.parse(seen.options.body), {
        toolCallId: "call_bash",
        toolName: "bash",
        args: { command: "printf portal-ok" },
        timeoutMs: 60000,
      });
      assert.equal(textFromResult(result), "portal-ok");
      assert.equal(result.details.exitCode, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
