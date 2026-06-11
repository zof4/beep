import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";
import { ToolRegistry } from "../src/tool-registry.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-registry-test-"));
  return {
    store: new StateStore(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function installEnabledDemoTool(store) {
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
          timeoutMs: 5000,
        },
        scopes: ["sandbox.tool.execute"],
        defaultDecision: "review",
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

test("registry includes built-in web.run and preview tools", () => {
  const { store, cleanup } = tempStore();
  try {
    const registry = new ToolRegistry({ store });
    const manifest = registry.manifest();

    assert.equal(manifest.schemaVersion, 2);
    assert.ok(manifest.defaultAllowedScopes.includes("web.search"));
    assert.ok(manifest.defaultAllowedScopes.includes("sandbox.tool.execute"));
    assert.ok(manifest.tools.find((tool) => tool.action === "web.run"));
    assert.ok(manifest.tools.find((tool) => tool.action === "preview.port.expose"));
  } finally {
    cleanup();
  }
});

test("registry adds enabled generated sandbox tools", () => {
  const { store, cleanup } = tempStore();
  try {
    installEnabledDemoTool(store);
    const registry = new ToolRegistry({ store });
    const tool = registry.get("beep.tools.demo_tools.demo_echo");

    assert.equal(tool.target, "sandbox");
    assert.equal(tool.packageVersionId, "demo_tools@1.0.0");

    const publicTool = registry.manifest().tools.find((entry) => entry.name === "demo_echo");
    assert.ok(publicTool);
    assert.equal(publicTool.action, "beep.tools.demo_tools.demo_echo");
    assert.equal(publicTool.packageVersionId, "demo_tools@1.0.0");
    assert.equal("command" in publicTool, false);
  } finally {
    cleanup();
  }
});
