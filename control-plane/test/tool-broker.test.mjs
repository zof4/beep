import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PREVIEW_HOST_PORT_BASE, PUBLIC_BASE_URL, RUNTIME_ID } from "../src/config.mjs";
import { StateStore } from "../src/state-store.mjs";
import { ToolBroker } from "../src/tool-broker.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-tool-broker-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function installEnabledSandboxTool(store, { defaultDecision = "allow", timeoutMs = 7000 } = {}) {
  store.installToolPackage({
    packageId: "demo_tools",
    version: "1.0.0",
    packageHash: "sha256:abc123",
    source: "sandbox",
    tools: [
      {
        name: "demo_echo",
        action: "beep.tools.demo_tools.demo_echo",
        namespace: "beep_tools",
        label: "Demo Echo",
        description: "Echo text from the sandbox.",
        promptSnippet: "Use demo_echo to echo text through the sandbox.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
          },
        },
        target: "sandbox",
        command: {
          argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"],
          input: "json-stdin",
          timeoutMs,
        },
        scopes: ["sandbox.tool.execute"],
        defaultDecision,
      },
    ],
  });
  store.setToolPackageToolEnabled({
    packageId: "demo_tools",
    version: "1.0.0",
    toolName: "demo_echo",
    enabled: true,
    decidedBy: "operator",
  });
}

test("preview port exposure preserves path-only preview URLs", async () => {
  const { store, cleanup } = tempStore();
  try {
    const broker = new ToolBroker({ store });
    const cases = [
      { path: "/", suffix: "/" },
      { path: "/index.html", suffix: "/index.html" },
      { path: "index.html", suffix: "/index.html" },
      { path: "/docs/page.html", suffix: "/docs/page.html" },
      { path: "/?q=1", suffix: "/?q=1" },
      { path: "#section", suffix: "/#section" },
    ];

    for (const { path, suffix } of cases) {
      const result = await broker.call({
        runtimeId: RUNTIME_ID,
        action: "preview.port.expose",
        args: { port: 3000, path },
      });

      assert.equal(result.ok, true);
      assert.equal(new URL(result.result.url).origin, new URL(PUBLIC_BASE_URL).origin);
      assert.equal(new URL(result.result.directUrl).origin, `http://127.0.0.1:${PREVIEW_HOST_PORT_BASE}`);
      const previewUrl = new URL(result.result.url);
      const directUrl = new URL(result.result.directUrl);
      assert.equal(`${previewUrl.pathname}${previewUrl.search}${previewUrl.hash}`, `/preview/${RUNTIME_ID}/3000${suffix}`);
      assert.equal(`${directUrl.pathname}${directUrl.search}${directUrl.hash}`, suffix);
    }
  } finally {
    cleanup();
  }
});

test("preview port exposure cannot return external URLs from scheme-like paths", async () => {
  const { store, cleanup } = tempStore();
  try {
    const broker = new ToolBroker({ store });
    const poisoningPaths = [
      "https://attacker.test/x",
      "http://attacker.test/x",
      "//attacker.test/x",
      "javascript:alert(1)",
      "\\\\attacker.test\\x",
      " http://attacker.test/x",
      " /safe",
      " safe?x=1",
      "\nhttps://attacker.test/x",
      "/https://attacker.test/x",
      "../x",
      "../../../api/tools",
      "%2e%2e/%2e%2e/api/audit",
      "%2E%2E/api/tools",
      "%2e%2e%2f%2e%2e%2f%2e%2e%2fapi/tools",
      "safe%2f..%2fapi/tools",
      "safe%5c..%5capi/tools",
      "%zz",
      "%C0%AF",
      "%E0%80%AF",
    ];

    for (const path of poisoningPaths) {
      const result = await broker.call({
        runtimeId: RUNTIME_ID,
        action: "preview.port.expose",
        args: { port: 3000, path },
      });

      assert.equal(result.ok, true);
      assert.equal(new URL(result.result.url).origin, new URL(PUBLIC_BASE_URL).origin);
      assert.equal(new URL(result.result.directUrl).origin, `http://127.0.0.1:${PREVIEW_HOST_PORT_BASE}`);
      const previewUrl = new URL(result.result.url);
      const directUrl = new URL(result.result.directUrl);
      assert.notEqual(previewUrl.hostname, "attacker.test");
      assert.notEqual(directUrl.hostname, "attacker.test");
      assert.equal(
        `${previewUrl.pathname}${previewUrl.search}${previewUrl.hash}`,
        `/preview/${RUNTIME_ID}/3000/`,
      );
      assert.equal(`${directUrl.pathname}${directUrl.search}${directUrl.hash}`, "/");

      const exposure = store.readState().exposures[`${RUNTIME_ID}:3000`];
      assert.equal(new URL(exposure.url).origin, new URL(PUBLIC_BASE_URL).origin);
      assert.equal(new URL(exposure.directUrl).origin, `http://127.0.0.1:${PREVIEW_HOST_PORT_BASE}`);
    }
  } finally {
    cleanup();
  }
});

test("broker executes registry-backed web.run through injected webSearch.run", async () => {
  const { store, cleanup } = tempStore();
  try {
    const calls = [];
    const broker = new ToolBroker({
      store,
      registry: new ToolRegistry({ store }),
      webSearch: {
        async run(args) {
          calls.push(args);
          return { ok: true, result: { text: "search result", sources: [{ url: "https://example.test" }] } };
        },
      },
    });

    const result = await broker.call({
      runtimeId: RUNTIME_ID,
      toolCallId: "call_web",
      action: "web.run",
      args: { search_query: [{ q: "beep tools" }], response_length: "short" },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ search_query: [{ q: "beep tools" }], response_length: "short" }]);
    assert.equal(result.result.text, "search result");
  } finally {
    cleanup();
  }
});

test("web.run without configured webSearch returns structured broker failure", async () => {
  const { store, cleanup } = tempStore();
  try {
    const broker = new ToolBroker({
      store,
      registry: new ToolRegistry({ store }),
    });

    const result = await broker.call({
      runtimeId: RUNTIME_ID,
      toolCallId: "call_missing_web",
      action: "web.run",
      args: { search_query: [{ q: "beep tools" }] },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "denied");
    assert.equal(result.decision, "deny");
    assert.match(result.error, /web search.*not configured/iu);
  } finally {
    cleanup();
  }
});

test("broker forwards enabled dynamic sandbox tool definitions to sandboxToolCaller", async () => {
  const { store, cleanup } = tempStore();
  try {
    installEnabledSandboxTool(store, { defaultDecision: "allow", timeoutMs: 7000 });
    const calls = [];
    const broker = new ToolBroker({
      store,
      registry: new ToolRegistry({ store }),
      sandboxToolCaller: async (body) => {
        calls.push(body);
        return { ok: true, result: { echoed: body.args.text } };
      },
    });

    const result = await broker.call({
      runtimeId: RUNTIME_ID,
      toolCallId: "call_sandbox",
      action: "beep.tools.demo_tools.demo_echo",
      args: { text: "hello" },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { echoed: "hello" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "beep.tools.demo_tools.demo_echo");
    assert.equal(calls[0].toolName, "dynamic_cli");
    assert.equal(calls[0].toolCallId, "call_sandbox");
    assert.deepEqual(calls[0].args, { text: "hello" });
    assert.equal(calls[0].timeoutMs, 7000);
    assert.deepEqual(calls[0].dynamicTool.command, {
      argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"],
      input: "json-stdin",
      timeoutMs: 7000,
    });
  } finally {
    cleanup();
  }
});

test("approved review-mode sandbox tools execute through sandboxToolCaller", async () => {
  const { store, cleanup } = tempStore();
  try {
    installEnabledSandboxTool(store, { defaultDecision: "review", timeoutMs: 9000 });
    const calls = [];
    const broker = new ToolBroker({
      store,
      registry: new ToolRegistry({ store }),
      sandboxToolCaller: async (body) => {
        calls.push(body);
        return { ok: true, result: { approved: true, text: body.args.text } };
      },
    });
    const approval = store.createApproval({
      runtimeId: RUNTIME_ID,
      toolCallId: "call_review_sandbox",
      action: "beep.tools.demo_tools.demo_echo",
      args: { text: "approved" },
      risk: "high",
      prompt: "Approve Demo Echo?",
      reason: "Tool is configured for review.",
    });
    const executing = store.updateApproval(approval.approvalId, { status: "executing" });

    const result = await broker.executeApprovedApproval(executing);

    assert.deepEqual(result, { approved: true, text: "approved" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "beep.tools.demo_tools.demo_echo");
    assert.equal(calls[0].toolName, "dynamic_cli");
    assert.equal(calls[0].toolCallId, "call_review_sandbox");
    assert.equal(calls[0].timeoutMs, 9000);
    assert.equal(calls[0].dynamicTool.action, "beep.tools.demo_tools.demo_echo");
  } finally {
    cleanup();
  }
});
