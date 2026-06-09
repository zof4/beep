import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSandboxToolRequest,
  sandboxToolErrorResult,
  sandboxToolOkResult,
  isReadOnlySandboxTool,
} from "../runtime/src/sandbox-tool-protocol.mjs";

test("normalizes a same-name Pi tool request", () => {
  const request = normalizeSandboxToolRequest({
    requestId: "req_1",
    turnId: "turn_1",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "pwd" },
    cwd: "/workspace",
    timeoutMs: 1000,
    sandboxGeneration: 2,
  });

  assert.equal(request.schemaVersion, 1);
  assert.equal(request.toolName, "bash");
  assert.deepEqual(request.args, { command: "pwd" });
  assert.equal(request.cwd, "/workspace");
  assert.equal(request.timeoutMs, 1000);
  assert.equal(request.sandboxGeneration, 2);
});

test("rejects unknown tool names", () => {
  assert.throws(
    () => normalizeSandboxToolRequest({ toolCallId: "call_1", toolName: "sandbox_bash", args: {} }),
    /Unsupported sandbox tool/u,
  );
});

test("classifies read-only tools for conservative retry", () => {
  assert.equal(isReadOnlySandboxTool("read"), true);
  assert.equal(isReadOnlySandboxTool("ls"), true);
  assert.equal(isReadOnlySandboxTool("grep"), true);
  assert.equal(isReadOnlySandboxTool("find"), true);
  assert.equal(isReadOnlySandboxTool("bash"), false);
  assert.equal(isReadOnlySandboxTool("write"), false);
  assert.equal(isReadOnlySandboxTool("edit"), false);
});

test("normalizes edit as a same-name mutating Pi tool", () => {
  const request = normalizeSandboxToolRequest({
    requestId: "req_edit",
    turnId: "turn_edit",
    toolCallId: "call_edit",
    toolName: "edit",
    args: { path: "hello.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
  });

  assert.equal(request.toolName, "edit");
  assert.deepEqual(request.args, {
    path: "hello.txt",
    edits: [{ oldText: "hello", newText: "goodbye" }],
  });
});

test("builds Pi-compatible success and error result envelopes", () => {
  const ok = sandboxToolOkResult({
    toolCallId: "call_1",
    content: [{ type: "text", text: "done" }],
    details: { exitCode: 0 },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.isError, false);
  assert.deepEqual(ok.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(ok.details, { exitCode: 0 });

  const error = sandboxToolErrorResult({
    toolCallId: "call_2",
    error: "sandbox restarted",
    details: { interrupted: true },
  });
  assert.equal(error.ok, false);
  assert.equal(error.isError, true);
  assert.match(error.content[0].text, /sandbox restarted/u);
  assert.equal(error.details.interrupted, true);
});
