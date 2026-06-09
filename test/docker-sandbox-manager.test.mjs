import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DockerSandboxManager } from "../runtime/src/docker-sandbox-manager.mjs";

function fakeRunner() {
  const calls = [];
  return {
    calls,
    async run(command, args, options = {}) {
      calls.push({ command, args, options });
      if (args[0] === "inspect") {
        const target = args[1];
        if (target === "container_1") {
          return {
            stdout: JSON.stringify([{ Id: "container_1", State: { Running: true, Status: "running" } }]),
            stderr: "",
          };
        }
        const error = new Error(`No such object: ${target}`);
        error.stderr = `No such object: ${target}`;
        error.code = 1;
        throw error;
      }
      if (args[0] === "create") return { stdout: "container_1\n", stderr: "" };
      if (args[0] === "start") return { stdout: "container_1\n", stderr: "" };
      if (args[0] === "exec") {
        return {
          stdout: JSON.stringify({
            ok: true,
            toolCallId: "call_1",
            content: [{ type: "text", text: "ok" }],
            details: {},
            diagnostics: {},
            isError: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  };
}

function argAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function valuesAfter(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

test("creates a labeled non-root sandbox with only the session workspace mounted", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-"));
  try {
    const runner = fakeRunner();
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      image: "beep-sandbox:local",
      runDocker: runner.run,
    });

    const sandbox = await manager.ensureSandbox("agent_beep");
    assert.equal(sandbox.sessionId, "agent_beep");
    assert.equal(sandbox.generation, 1);
    assert.equal(sandbox.containerId, "container_1");
    assert.equal(sandbox.status, "running");

    const create = runner.calls.find((call) => call.args[0] === "create");
    assert.ok(create);
    assert.equal(create.command, "docker");
    assert.ok(create.args.includes("--read-only"));
    assert.deepEqual(valuesAfter(create.args, "--tmpfs"), ["/tmp:size=256m,mode=1777"]);
    assert.equal(argAfter(create.args, "--network"), "none");
    assert.equal(argAfter(create.args, "--security-opt"), "no-new-privileges:true");
    assert.equal(argAfter(create.args, "--cap-drop"), "ALL");
    assert.equal(argAfter(create.args, "--user"), "beep");
    assert.equal(argAfter(create.args, "--memory"), "1024m");
    assert.equal(argAfter(create.args, "--cpus"), "2");
    assert.equal(argAfter(create.args, "--pids-limit"), "512");
    assert.ok(valuesAfter(create.args, "--label").includes("beep.sandbox.session=agent_beep"));

    const mounts = valuesAfter(create.args, "--mount");
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0], `type=bind,source=${resolve(root, "agent_beep")},target=/workspace`);
    assert.ok(existsSync(resolve(root, "agent_beep")));
    assert.doesNotMatch(create.args.join(" "), /codex|auth\.json|docker\.sock/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("executes a normalized tool request in the active sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-exec-"));
  try {
    const runner = fakeRunner();
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      image: "beep-sandbox:local",
      runDocker: runner.run,
    });

    const result = await manager.executeTool("agent_beep", {
      requestId: "req_1",
      turnId: "turn_1",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "printf ok" },
      timeoutMs: 5000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.diagnostics.sandbox.sessionId, "agent_beep");
    assert.equal(result.diagnostics.sandbox.generation, 1);
    assert.equal(result.diagnostics.sandbox.containerId, "container_1");

    const exec = runner.calls.find((call) => call.args[0] === "exec");
    assert.ok(exec);
    assert.equal(exec.command, "docker");
    assert.deepEqual(exec.args, ["exec", "-i", "container_1", "/runtime/bin/beep-sandbox-tool-runner"]);

    const payload = JSON.parse(exec.options.input);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.toolName, "bash");
    assert.deepEqual(payload.args, { command: "printf ok" });
    assert.equal(payload.cwd, "/workspace");
    assert.equal(payload.timeoutMs, 5000);
    assert.equal(payload.sandboxGeneration, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
