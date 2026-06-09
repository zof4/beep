import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DockerSandboxManager, defaultRunDocker } from "../runtime/src/docker-sandbox-manager.mjs";

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
  const dockerRoot = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-host-"));
  try {
    const runner = fakeRunner();
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      dockerWorkspaceRoot: dockerRoot,
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
    assert.equal(mounts[0].startsWith(`type=bind,source=${resolve(dockerRoot, "agent_beep")}`), true);
    assert.match(mounts[0], /-[a-f0-9]{16},target=\/workspace$/u);
    assert.ok(existsSync(sandbox.workspacePath));
    assert.equal(sandbox.dockerWorkspacePath, mounts[0].match(/source=([^,]+)/u)[1]);
    assert.doesNotMatch(create.args.join(" "), /codex|auth\.json|docker\.sock/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dockerRoot, { recursive: true, force: true });
  }
});

test("uses collision-resistant workspace components for similar session ids", () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-collision-"));
  try {
    const manager = new DockerSandboxManager({ workspaceRoot: root, runDocker: fakeRunner().run });
    const slashWorkspace = manager.workspaceFor("a/b");
    const colonWorkspace = manager.workspaceFor("a:b");
    const longOne = manager.workspaceFor(`${"x".repeat(100)}1`);
    const longTwo = manager.workspaceFor(`${"x".repeat(100)}2`);

    assert.notEqual(slashWorkspace, colonWorkspace);
    assert.notEqual(longOne, longTwo);
    assert.match(slashWorkspace, /a-b-[a-f0-9]{16}$/u);
    assert.match(colonWorkspace, /a-b-[a-f0-9]{16}$/u);
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
    assert.equal(exec.options.timeoutMs, 10_000);

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

test("allows the runner timeout to report before the Docker exec wrapper timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-exec-timeout-"));
  try {
    const runner = fakeRunner();
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      dockerTimeoutMs: 30_000,
      execTimeoutGraceMs: 5_000,
      runDocker: runner.run,
    });

    await manager.executeTool("agent_beep", {
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "sleep 120" },
    });

    const exec = runner.calls.find((call) => call.args[0] === "exec");
    assert.equal(exec.options.timeoutMs, 65_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects invalid tool requests before allocating Docker resources", async () => {
  const runner = fakeRunner();
  const manager = new DockerSandboxManager({
    workspaceRoot: mkdtempSync(join(tmpdir(), "beep-sandbox-manager-invalid-")),
    runDocker: runner.run,
  });

  const result = await manager.executeTool("agent_beep", {
    toolCallId: "call_bad",
    toolName: "unknown",
  });

  assert.equal(result.ok, false);
  assert.match(result.content[0].text, /Unsupported sandbox tool/u);
  assert.equal(runner.calls.length, 0);

  rmSync(manager.workspaceRoot, { recursive: true, force: true });
});

test("serializes concurrent first-use sandbox creation per session", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-concurrent-"));
  try {
    const calls = [];
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      async runDocker(command, args, options = {}) {
        calls.push({ command, args, options });
        if (args[0] === "create") {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
          return { stdout: "container_1\n", stderr: "" };
        }
        if (args[0] === "start") return { stdout: "container_1\n", stderr: "" };
        if (args[0] === "inspect") {
          return {
            stdout: JSON.stringify([{ Id: "container_1", State: { Running: true, Status: "running" } }]),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
    });

    const [first, second] = await Promise.all([manager.ensureSandbox("agent_beep"), manager.ensureSandbox("agent_beep")]);

    assert.equal(first.containerId, "container_1");
    assert.equal(second.containerId, "container_1");
    assert.equal(calls.filter((call) => call.args[0] === "create").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reuses a running labeled container discovered after manager restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-restart-"));
  try {
    const calls = [];
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      async runDocker(command, args, options = {}) {
        calls.push({ command, args, options });
        if (args[0] === "ps") return { stdout: "old_container\n", stderr: "" };
        if (args[0] === "inspect") {
          return {
            stdout: JSON.stringify([
              {
                Id: "old_container",
                Name: "/beep-sandbox-agent_beep-abcd-3",
                Config: {
                  Labels: {
                    "beep.sandbox": "1",
                    "beep.sandbox.session": "agent_beep",
                    "beep.sandbox.generation": "3",
                  },
                },
                State: { Running: true, Status: "running" },
              },
            ]),
            stderr: "",
          };
        }
        throw new Error(`unexpected docker ${args.join(" ")}`);
      },
    });

    const sandbox = await manager.ensureSandbox("agent_beep");

    assert.equal(sandbox.containerId, "old_container");
    assert.equal(sandbox.generation, 3);
    assert.equal(calls.filter((call) => call.args[0] === "create").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("starts and reuses a stopped labeled container discovered after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-stopped-"));
  try {
    const calls = [];
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      async runDocker(command, args, options = {}) {
        calls.push({ command, args, options });
        if (args[0] === "ps") return { stdout: "stopped_container\n", stderr: "" };
        if (args[0] === "inspect") {
          const started = calls.some((call) => call.args[0] === "start");
          return {
            stdout: JSON.stringify([
              {
                Id: "stopped_container",
                Config: {
                  Labels: {
                    "beep.sandbox": "1",
                    "beep.sandbox.session": "agent_beep",
                    "beep.sandbox.generation": "2",
                  },
                },
                State: started
                  ? { Running: true, Status: "running" }
                  : { Running: false, Status: "exited" },
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "start") return { stdout: "stopped_container\n", stderr: "" };
        throw new Error(`unexpected docker ${args.join(" ")}`);
      },
    });

    const sandbox = await manager.ensureSandbox("agent_beep");

    assert.equal(sandbox.containerId, "stopped_container");
    assert.equal(sandbox.generation, 2);
    assert.equal(calls.filter((call) => call.args[0] === "start").length, 1);
    assert.equal(calls.filter((call) => call.args[0] === "rm").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleans up a created container when start fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-start-fail-"));
  try {
    const calls = [];
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      async runDocker(command, args, options = {}) {
        calls.push({ command, args, options });
        if (args[0] === "ps") return { stdout: "", stderr: "" };
        if (args[0] === "create") return { stdout: "created_container\n", stderr: "" };
        if (args[0] === "start") throw new Error("start failed");
        if (args[0] === "rm") return { stdout: "", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });

    await assert.rejects(() => manager.ensureSandbox("agent_beep"), /start failed/u);

    assert.deepEqual(
      calls.filter((call) => call.args[0] === "rm").map((call) => call.args),
      [["rm", "-f", "created_container"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovers from Docker name conflicts by discovering the winning container", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-sandbox-manager-conflict-"));
  try {
    const calls = [];
    const manager = new DockerSandboxManager({
      workspaceRoot: root,
      async runDocker(command, args, options = {}) {
        calls.push({ command, args, options });
        if (args[0] === "ps") {
          const conflictSeen = calls.some((call) => call.args[0] === "create");
          return { stdout: conflictSeen ? "winner_container\n" : "", stderr: "" };
        }
        if (args[0] === "inspect") {
          return {
            stdout: JSON.stringify([
              {
                Id: "winner_container",
                Config: {
                  Labels: {
                    "beep.sandbox": "1",
                    "beep.sandbox.session": "agent_beep",
                    "beep.sandbox.generation": "1",
                  },
                },
                State: { Running: true, Status: "running" },
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "create") {
          const error = new Error("Conflict. The container name is already in use.");
          error.stderr = "Conflict. The container name is already in use.";
          throw error;
        }
        throw new Error(`unexpected docker ${args.join(" ")}`);
      },
    });

    const sandbox = await manager.ensureSandbox("agent_beep");

    assert.equal(sandbox.containerId, "winner_container");
    assert.equal(calls.filter((call) => call.args[0] === "create").length, 1);
    assert.equal(calls.filter((call) => call.args[0] === "rm").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default docker runner bounds output and times out hung commands", async () => {
  await assert.rejects(
    () =>
      defaultRunDocker(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        timeoutMs: 25,
        maxOutputBytes: 100,
      }),
    /timed out/u,
  );

  await assert.rejects(
    () =>
      defaultRunDocker(process.execPath, ["-e", "process.stderr.write('x'.repeat(200)); process.exit(1)"], {
        timeoutMs: 1000,
        maxOutputBytes: 25,
      }),
    (error) => {
      assert.equal(error.stderr.length, 25);
      assert.equal(error.stderrTruncated, true);
      return true;
    },
  );
});
