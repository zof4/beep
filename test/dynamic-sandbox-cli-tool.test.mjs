import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeSandboxToolRequest } from "../runtime/src/sandbox-tool-protocol.mjs";
import { executeSandboxTool } from "../runtime/src/sandbox-tool-executor.mjs";

function tempWorkspace(prefix = "beep-dynamic-cli-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function writeExecutableScript(cwd, path, lines) {
  const fullPath = join(cwd, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${lines.join("\n")}\n`);
  await chmod(fullPath, 0o755);
  return fullPath;
}

test("dynamic_cli executes package command with JSON stdin", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await writeExecutableScript(dir, ".beep/tools/demo_tools/bin/echo.mjs", [
      "#!/usr/bin/env node",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      "  process.stdout.write(JSON.stringify({",
      "    action: payload.action,",
      "    text: `echo:${payload.args.text}`,",
      "    toolCallId: payload.toolCallId,",
      "  }));",
      "});",
    ]);

    const request = normalizeSandboxToolRequest({
      toolCallId: "call_dynamic",
      toolName: "dynamic_cli",
      cwd: dir,
      args: { text: "hello" },
      dynamicTool: {
        action: "beep.tools.demo_tools.demo_echo",
        command: { argv: ["node", ".beep/tools/demo_tools/bin/echo.mjs"], input: "json-stdin", timeoutMs: 5000 },
      },
    });
    assert.equal(request.dynamicTool.command.timeoutMs, 5000);
    assert.deepEqual(request.dynamicTool.command.argv, ["node", ".beep/tools/demo_tools/bin/echo.mjs"]);

    const result = await executeSandboxTool(request);

    assert.equal(result.ok, true);
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.timedOut, false);
    assert.match(result.content[0].text, /"action":"beep\.tools\.demo_tools\.demo_echo"/u);
    assert.match(result.content[0].text, /"text":"echo:hello"/u);
    assert.match(result.content[0].text, /"toolCallId":"call_dynamic"/u);
  } finally {
    await cleanup();
  }
});

test("dynamic_cli normalizes default timeout and rejects control characters", () => {
  const request = normalizeSandboxToolRequest({
    toolCallId: "call_timeout",
    toolName: "dynamic_cli",
    args: {},
    dynamicTool: {
      action: "beep.tools.demo_tools.timeout",
      command: { argv: ["node", ".beep/tools/demo_tools/bin/timeout.mjs"], input: "json-stdin" },
    },
  });

  assert.equal(request.dynamicTool.command.timeoutMs, 15_000);

  assert.throws(
    () =>
      normalizeSandboxToolRequest({
        toolCallId: "call_control",
        toolName: "dynamic_cli",
        args: {},
        dynamicTool: {
          action: "beep.tools.demo_tools.bad",
          command: { argv: ["node", ".beep/tools/demo_tools/bin/bad\u0000.mjs"], input: "json-stdin" },
        },
      }),
    /must not contain control characters/u,
  );
});

test("dynamic_cli rejects command path escape", () => {
  assert.throws(
    () =>
      normalizeSandboxToolRequest({
        toolCallId: "call_escape",
        toolName: "dynamic_cli",
        args: {},
        dynamicTool: {
          action: "beep.tools.demo_tools.bad",
          command: { argv: ["node", "../bad.mjs"], input: "json-stdin" },
        },
      }),
    /dynamic tool command path must stay under \.beep\/tools/u,
  );
});

test("dynamic_cli rejects symlink script escapes", async () => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace("beep-dynamic-outside-");
  try {
    await writeExecutableScript(outside.dir, "escape.mjs", [
      "#!/usr/bin/env node",
      "process.stdout.write('escaped');",
    ]);
    await mkdir(join(workspace.dir, ".beep/tools/demo_tools/bin"), { recursive: true });
    await symlink(join(outside.dir, "escape.mjs"), join(workspace.dir, ".beep/tools/demo_tools/bin/escape.mjs"));

    const request = normalizeSandboxToolRequest({
      toolCallId: "call_symlink_escape",
      toolName: "dynamic_cli",
      cwd: workspace.dir,
      args: {},
      dynamicTool: {
        action: "beep.tools.demo_tools.escape",
        command: { argv: ["node", ".beep/tools/demo_tools/bin/escape.mjs"], input: "json-stdin" },
      },
    });

    const result = await executeSandboxTool(request);

    assert.equal(result.ok, false);
    assert.match(result.content[0].text, /outside workspace/u);
  } finally {
    await workspace.cleanup();
    await outside.cleanup();
  }
});

test("dynamic_cli reports non-zero exits with bounded details", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await writeExecutableScript(dir, ".beep/tools/demo_tools/bin/fail.mjs", [
      "#!/usr/bin/env node",
      "process.stdout.write('partial stdout');",
      "process.stderr.write('failure stderr');",
      "process.exit(7);",
    ]);

    const request = normalizeSandboxToolRequest({
      toolCallId: "call_fail",
      toolName: "dynamic_cli",
      cwd: dir,
      args: {},
      dynamicTool: {
        action: "beep.tools.demo_tools.fail",
        command: { argv: ["node", ".beep/tools/demo_tools/bin/fail.mjs"], input: "json-stdin" },
      },
    });

    const result = await executeSandboxTool(request);

    assert.equal(result.ok, false);
    assert.equal(result.details.exitCode, 7);
    assert.equal(result.details.timedOut, false);
    assert.equal(result.details.stdout, "partial stdout");
    assert.equal(result.details.stderr, "failure stderr");
    assert.match(result.content[0].text, /partial stdout/u);
    assert.match(result.content[0].text, /failure stderr/u);
  } finally {
    await cleanup();
  }
});

test("non-dynamic sandbox tools drop dynamic tool metadata", () => {
  const request = normalizeSandboxToolRequest({
    toolCallId: "call_bash",
    toolName: "bash",
    args: { command: "true" },
    dynamicTool: {
      action: "beep.tools.demo_tools.ignored",
      command: { argv: ["node", ".beep/tools/demo_tools/bin/ignored.mjs"], input: "json-stdin" },
    },
  });

  assert.equal(request.dynamicTool, null);
});
