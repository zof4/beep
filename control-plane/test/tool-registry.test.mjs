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

test("default manifest hides legacy web.run but keeps default scopes and broker lookup", () => {
  const { store, cleanup } = tempStore();
  const previous = process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
  try {
    delete process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
    const registry = new ToolRegistry({ store });
    const manifest = registry.manifest();

    assert.equal(manifest.schemaVersion, 2);
    assert.ok(manifest.defaultAllowedScopes.includes("web.search"));
    assert.ok(manifest.defaultAllowedScopes.includes("preview.port.expose"));
    assert.equal(manifest.tools.find((tool) => tool.action === "web.run"), undefined);
    assert.ok(manifest.tools.find((tool) => tool.action === "preview.port.expose"));
    assert.equal(registry.get("web.run")?.action, "web.run");
  } finally {
    if (previous === undefined) {
      delete process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
    } else {
      process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED = previous;
    }
    cleanup();
  }
});

test("manifest includes legacy web.run when explicitly enabled by env", () => {
  const { store, cleanup } = tempStore();
  const previous = process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
  try {
    process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED = "1";
    const registry = new ToolRegistry({ store });
    const manifest = registry.manifest();

    assert.ok(manifest.tools.find((tool) => tool.action === "web.run"));
  } finally {
    if (previous === undefined) {
      delete process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
    } else {
      process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED = previous;
    }
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

test("registry manifest includes a stable revision for identical public tools", () => {
  const { store, cleanup } = tempStore();
  try {
    installEnabledDemoTool(store);
    const first = new ToolRegistry({ store }).manifest();
    const second = new ToolRegistry({ store }).manifest();

    assert.equal(typeof first.revision, "string");
    assert.match(first.revision, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(second.revision, first.revision);
  } finally {
    cleanup();
  }
});

test("registry manifest revision changes when generated tool enablement changes", () => {
  const { store, cleanup } = tempStore();
  try {
    const registry = new ToolRegistry({ store });
    const before = registry.manifest();

    installEnabledDemoTool(store);
    const afterEnable = registry.manifest();

    store.setToolPackageToolEnabled({
      packageId: "demo_tools",
      version: "1.0.0",
      toolName: "demo_echo",
      enabled: false,
      decidedBy: "operator",
    });
    const afterDisable = registry.manifest();

    assert.notEqual(afterEnable.revision, before.revision);
    assert.equal(afterDisable.revision, before.revision);
  } finally {
    cleanup();
  }
});
