import test from "node:test";
import assert from "node:assert/strict";
import { validateToolPackageManifest } from "../src/tool-package-validator.mjs";

function validManifest(overrides = {}) {
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
        description: " Echo text from the sandbox. ",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string" } },
        },
        target: "sandbox",
        command: {
          argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"],
          input: "text",
          timeoutMs: 0,
        },
        scopes: undefined,
        defaultDecision: "sometimes",
        deferLoading: 1,
      },
    ],
  };

  return { ...manifest, ...overrides };
}

test("valid manifest normalizes package and demo_echo modelName/action/command", () => {
  const normalized = validateToolPackageManifest(validManifest());

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.packageId, "demo_tools");
  assert.equal(normalized.version, "1.0.0");
  assert.equal(normalized.packageHash, "sha256:abc123");
  assert.equal(normalized.source, "sandbox");
  assert.equal(normalized.tools[0].modelName, "beep_tools.demo_echo");
  assert.equal(normalized.tools[0].action, "beep.tools.demo_tools.demo_echo");
  assert.equal(normalized.tools[0].description, "Echo text from the sandbox.");
  assert.deepEqual(normalized.tools[0].command, {
    argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"],
    input: "json-stdin",
    timeoutMs: 15000,
  });
  assert.deepEqual(normalized.tools[0].scopes, ["sandbox.tool.execute"]);
  assert.equal(normalized.tools[0].defaultDecision, "review");
  assert.equal(normalized.tools[0].deferLoading, true);
});

test("reserved namespace web is rejected", () => {
  const manifest = validManifest({
    tools: [{ ...validManifest().tools[0], namespace: "web" }],
  });

  assert.throws(() => validateToolPackageManifest(manifest), /reserved namespace/u);
});

test("command path escape is rejected", () => {
  const manifest = validManifest({
    tools: [
      {
        ...validManifest().tools[0],
        command: { argv: ["node", "../escape.mjs"], input: "json-stdin" },
      },
    ],
  });

  assert.throws(
    () => validateToolPackageManifest(manifest),
    /command argv path must stay under \.beep\/tools/u,
  );
});

test("target control-plane is rejected", () => {
  const manifest = validManifest({
    tools: [{ ...validManifest().tools[0], target: "control-plane" }],
  });

  assert.throws(
    () => validateToolPackageManifest(manifest),
    /generated tool target must be sandbox/u,
  );
});

test("duplicate tool model names are rejected", () => {
  const tool = validManifest().tools[0];
  const manifest = validManifest({
    tools: [
      tool,
      { ...tool, action: "beep.tools.demo_tools.demo_echo_duplicate" },
    ],
  });

  assert.throws(
    () => validateToolPackageManifest(manifest),
    /duplicate tool model name: beep_tools\.demo_echo/u,
  );
});

test("invalid inputSchema missing properties is rejected", () => {
  const manifest = validManifest({
    tools: [{ ...validManifest().tools[0], inputSchema: { type: "object" } }],
  });

  assert.throws(
    () => validateToolPackageManifest(manifest),
    /tool\.inputSchema\.properties must be an object/u,
  );
});
