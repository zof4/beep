import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runRunner(payload, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["runtime/bin/beep-sandbox-tool-runner"], {
      cwd: new URL("..", import.meta.url),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BEEP_SANDBOX_WORKSPACE: cwd },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

test("sandbox tool runner executes one normalized request from stdin", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-runner-"));
  try {
    const result = await runRunner(
      {
        toolCallId: "call_write",
        toolName: "write",
        args: { path: "proof.txt", content: "runner-ok\n" },
      },
      { cwd: workspace },
    );

    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(readFileSync(join(workspace, "proof.txt"), "utf8"), "runner-ok\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("sandbox tool runner flushes large JSON results before exiting", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-runner-large-"));
  try {
    const result = await runRunner(
      {
        toolCallId: "call_large",
        toolName: "bash",
        args: { command: "yes R | head -c 200000" },
        timeoutMs: 5000,
      },
      { cwd: workspace },
    );

    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.toolCallId, "call_large");
    assert.equal(payload.details.stdoutTruncated, true);
    assert.match(payload.content[0].text, /output truncated/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("sandbox tool runner ignores stdin cwd overrides", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-runner-root-"));
  const outside = mkdtempSync(join(tmpdir(), "beep-runner-outside-"));
  const outsidePath = join(outside, "secret.txt");
  try {
    writeFileSync(outsidePath, "outside-secret\n");
    const result = await runRunner(
      {
        toolCallId: "call_escape",
        toolName: "read",
        cwd: "/",
        args: { path: outsidePath },
      },
      { cwd: workspace },
    );

    assert.equal(result.code, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.content[0].text, /Path escapes outside workspace/u);
    assert.doesNotMatch(payload.content[0].text, /outside-secret/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("sandbox tool runner returns a nonzero exit for malformed input", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-runner-bad-"));
  try {
    const result = await runRunner({ toolName: "bash", args: {} }, { cwd: workspace });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /toolCallId is required/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
