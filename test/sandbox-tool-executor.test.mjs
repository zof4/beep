import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executeSandboxTool } from "../runtime/src/sandbox-tool-executor.mjs";

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "beep-sandbox-tools-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("bash runs inside the workspace and returns stdout", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const result = await executeSandboxTool({
      toolCallId: "call_bash",
      toolName: "bash",
      args: { command: "pwd && printf hello" },
      cwd: dir,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.match(result.content[0].text, new RegExp(dir.replaceAll("/", "\\/")));
    assert.match(result.content[0].text, /hello/u);
    assert.equal(result.details.exitCode, 0);
  } finally {
    cleanup();
  }
});

test("bash reports no output for silent successful commands", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const result = await executeSandboxTool({
      toolCallId: "call_bash",
      toolName: "bash",
      args: { command: "true" },
      cwd: dir,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.content[0].text, "(no output)");
  } finally {
    cleanup();
  }
});

test("bash bounds large stdout and stderr in content and details", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const result = await executeSandboxTool({
      toolCallId: "call_bash",
      toolName: "bash",
      args: { command: "yes A | head -c 200000; yes B | head -c 200000 >&2" },
      cwd: dir,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.stdoutTruncated, true);
    assert.equal(result.details.stderrTruncated, true);
    assert.ok(result.content[0].text.length < 140_000);
    assert.ok(result.details.stdout.length < 140_000);
    assert.ok(result.details.stderr.length < 140_000);
    assert.match(result.content[0].text, /output truncated/u);
  } finally {
    cleanup();
  }
});

test("write and read operate under the workspace", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const write = await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "hello.txt", content: "hello portal\n" },
      cwd: dir,
    });
    assert.equal(write.ok, true);
    assert.match(write.content[0].text, /Successfully wrote/u);
    assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "hello portal\n");

    const read = await executeSandboxTool({
      toolCallId: "call_read",
      toolName: "read",
      args: { path: "hello.txt" },
      cwd: dir,
    });
    assert.equal(read.ok, true);
    assert.equal(read.content[0].text, "hello portal\n");
  } finally {
    cleanup();
  }
});

test("read bounds large file output", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    writeFileSync(join(dir, "large.txt"), `${"x".repeat(200_000)}\n`);

    const result = await executeSandboxTool({
      toolCallId: "call_read",
      toolName: "read",
      args: { path: "large.txt" },
      cwd: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.details.truncated, true);
    assert.ok(result.content[0].text.length < 140_000);
    assert.match(result.content[0].text, /output truncated/u);
  } finally {
    cleanup();
  }
});

test("ls returns alphabetized entries with directory suffixes", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "zeta.txt", content: "" },
      cwd: dir,
    });
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "alpha/file.txt", content: "" },
      cwd: dir,
    });

    const result = await executeSandboxTool({
      toolCallId: "call_ls",
      toolName: "ls",
      args: { path: "." },
      cwd: dir,
    });

    assert.equal(result.ok, true);
    assert.equal(result.content[0].text, "alpha/\nzeta.txt");
  } finally {
    cleanup();
  }
});

test("grep returns matches and no-match text in Pi-compatible format", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "notes.txt", content: "alpha\nportal\n" },
      cwd: dir,
    });

    const match = await executeSandboxTool({
      toolCallId: "call_grep",
      toolName: "grep",
      args: { pattern: "portal", path: "." },
      cwd: dir,
    });
    assert.equal(match.ok, true);
    assert.equal(match.content[0].text, "notes.txt:2:portal");

    const noMatch = await executeSandboxTool({
      toolCallId: "call_grep",
      toolName: "grep",
      args: { pattern: "missing", path: "." },
      cwd: dir,
    });
    assert.equal(noMatch.ok, true);
    assert.equal(noMatch.content[0].text, "No matches found");
  } finally {
    cleanup();
  }
});

test("grep bounds captured command output", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    writeFileSync(join(dir, "large.txt"), `needle ${"x".repeat(200_000)}\n`);

    const result = await executeSandboxTool({
      toolCallId: "call_grep",
      toolName: "grep",
      args: { pattern: "needle", path: "." },
      cwd: dir,
    });
    assert.equal(result.ok, true);
    assert.equal(result.details.truncated, true);
    assert.ok(result.content[0].text.length < 140_000);
    assert.match(result.content[0].text, /output truncated/u);
  } finally {
    cleanup();
  }
});

test("find filters by pattern and returns paths relative to the search root", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "src/target-one.txt", content: "" },
      cwd: dir,
    });
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "src/other.txt", content: "" },
      cwd: dir,
    });

    const result = await executeSandboxTool({
      toolCallId: "call_find",
      toolName: "find",
      args: { pattern: "target", path: "src" },
      cwd: dir,
    });

    assert.equal(result.ok, true);
    assert.equal(result.content[0].text, "target-one.txt");
  } finally {
    cleanup();
  }
});

test("edit performs exact replacements under the workspace", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "hello.txt", content: "one\ntwo\nthree\n" },
      cwd: dir,
    });

    const result = await executeSandboxTool({
      toolCallId: "call_edit",
      toolName: "edit",
      args: { path: "hello.txt", edits: [{ oldText: "two", newText: "TWO" }] },
      cwd: dir,
    });

    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(dir, "hello.txt"), "utf8"), "one\nTWO\nthree\n");
    assert.match(result.content[0].text, /Successfully replaced 1 block/u);
    assert.match(result.details.patch, /-two/u);
    assert.match(result.details.patch, /\+TWO/u);
    assert.equal(result.details.firstChangedLine, 2);
  } finally {
    cleanup();
  }
});

test("edit rejects duplicate oldText matches", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "hello.txt", content: "same\nsame\n" },
      cwd: dir,
    });

    const result = await executeSandboxTool({
      toolCallId: "call_edit",
      toolName: "edit",
      args: { path: "hello.txt", edits: [{ oldText: "same", newText: "different" }] },
      cwd: dir,
    });

    assert.equal(result.ok, false);
    assert.match(result.content[0].text, /Found 2 occurrences/u);
  } finally {
    cleanup();
  }
});

test("read rejects paths outside the workspace", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const result = await executeSandboxTool({
      toolCallId: "call_read",
      toolName: "read",
      args: { path: "../outside.txt" },
      cwd: dir,
    });
    assert.equal(result.ok, false);
    assert.match(result.content[0].text, /outside workspace/u);
  } finally {
    cleanup();
  }
});

test("read rejects symlinks that resolve outside the workspace", async () => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  try {
    writeFileSync(join(outside.dir, "secret.txt"), "outside\n");
    symlinkSync(join(outside.dir, "secret.txt"), join(workspace.dir, "link.txt"));

    const result = await executeSandboxTool({
      toolCallId: "call_read",
      toolName: "read",
      args: { path: "link.txt" },
      cwd: workspace.dir,
    });
    assert.equal(result.ok, false);
    assert.match(result.content[0].text, /outside workspace/u);
  } finally {
    workspace.cleanup();
    outside.cleanup();
  }
});

test("write rejects symlink parents that resolve outside the workspace", async () => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  try {
    symlinkSync(outside.dir, join(workspace.dir, "escape-dir"), "dir");

    const result = await executeSandboxTool({
      toolCallId: "call_write",
      toolName: "write",
      args: { path: "escape-dir/pwned.txt", content: "outside\n" },
      cwd: workspace.dir,
    });
    assert.equal(result.ok, false);
    assert.match(result.content[0].text, /outside workspace/u);
    assert.equal(existsSync(join(outside.dir, "pwned.txt")), false);
  } finally {
    workspace.cleanup();
    outside.cleanup();
  }
});

test("edit rejects symlinks that resolve outside the workspace", async () => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  try {
    writeFileSync(join(outside.dir, "secret.txt"), "outside\n");
    symlinkSync(join(outside.dir, "secret.txt"), join(workspace.dir, "link.txt"));

    const result = await executeSandboxTool({
      toolCallId: "call_edit",
      toolName: "edit",
      args: { path: "link.txt", edits: [{ oldText: "outside", newText: "changed" }] },
      cwd: workspace.dir,
    });
    assert.equal(result.ok, false);
    assert.match(result.content[0].text, /outside workspace/u);
    assert.equal(readFileSync(join(outside.dir, "secret.txt"), "utf8"), "outside\n");
  } finally {
    workspace.cleanup();
    outside.cleanup();
  }
});

test("bash timeout cleans up background children in the process group", async () => {
  const { dir, cleanup } = tempWorkspace();
  try {
    const result = await executeSandboxTool({
      toolCallId: "call_bash_timeout",
      toolName: "bash",
      args: { command: "(sleep 0.5; touch child-survived.txt) & sleep 5" },
      cwd: dir,
      timeoutMs: 100,
    });
    assert.equal(result.ok, false);
    assert.equal(result.details.timedOut, true);

    await delay(900);
    assert.equal(existsSync(join(dir, "child-survived.txt")), false);
  } finally {
    cleanup();
  }
});
