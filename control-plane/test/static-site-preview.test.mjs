import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ROOT_DIR, STATE_DIR } from "../src/config.mjs";
import {
  collectStaticSiteEvidence,
  staticSiteExecutionRejectionReason,
} from "../src/gatekeeper/evidence.mjs";
import { createStaticSiteSnapshot } from "../src/static-site-preview.mjs";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "beep-static-preview-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("static site snapshot is independent of later workspace changes", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>original</h1>\n");

    const snapshot = createStaticSiteSnapshot({
      sourceHostPath: source,
      siteId: "demo-site",
      snapshotRoot,
    });

    writeFileSync(join(source, "index.html"), "<h1>mutated</h1>\n");

    assert.equal(readFileSync(join(snapshot.snapshotPath, "index.html"), "utf8"), "<h1>original</h1>\n");
    assert.equal(snapshot.fileCount, 1);
    assert.equal(snapshot.totalBytes, "<h1>original</h1>\n".length);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects secret-like files instead of serving them", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(source, ".env"), "TOKEN=secret\n");

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
        }),
      /secret or credential/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects symlinked directories during traversal", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const outside = join(dir, "outside");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(source, "assets"));

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
        }),
      /symlink/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects symlinked parent components under the trusted root", () => {
  const { dir, cleanup } = tempDir();
  try {
    const trustedRoot = join(dir, "workspace");
    const outside = join(dir, "outside");
    const source = join(trustedRoot, "api-sessions", "agent_beep", "site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(trustedRoot, { recursive: true });
    mkdirSync(join(outside, "agent_beep", "site"), { recursive: true });
    writeFileSync(join(outside, "agent_beep", "site", "index.html"), "<h1>outside</h1>\n");
    symlinkSync(outside, join(trustedRoot, "api-sessions"));

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          trustedRoot,
        }),
      /symlink/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects snapshot roots inside the source tree", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(source, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          maxFiles: 4,
        }),
      /snapshot root must not be inside the source tree/iu,
    );
    assert.equal(existsSync(snapshotRoot), false);
  } finally {
    cleanup();
  }
});

test("static site evidence rejects symlinked parent components before walking", () => {
  const { dir, cleanup } = tempDir();
  const workspaceRoot = join(ROOT_DIR, ".beep-dev", "workspace");
  const linkName = `evidence-parent-${process.pid}-${Date.now()}`;
  const linkPath = join(workspaceRoot, linkName);
  try {
    const outsideSite = join(dir, "outside", "agent_beep", "site");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(outsideSite, { recursive: true });
    writeFileSync(join(outsideSite, "index.html"), "<h1>outside</h1>\n");
    symlinkSync(join(dir, "outside"), linkPath);

    const evidence = collectStaticSiteEvidence({
      sourcePath: `/workspace/${linkName}/agent_beep/site`,
    });

    assert.equal(evidence.ok, false);
    assert.match(evidence.error, /symlink/iu);
  } finally {
    rmSync(linkPath, { recursive: true, force: true });
    cleanup();
  }
});

test("static site evidence rejects excessive directory depth", () => {
  const workspaceRoot = join(ROOT_DIR, ".beep-dev", "workspace");
  const sourceName = `evidence-depth-${process.pid}-${Date.now()}`;
  const source = join(workspaceRoot, sourceName);
  try {
    mkdirSync(join(source, "assets", "nested"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(source, "assets", "nested", "leaf.txt"), "leaf\n");

    const evidence = collectStaticSiteEvidence({
      sourcePath: `/workspace/${sourceName}`,
      maxDepth: 1,
    });

    assert.equal(evidence.limitExceeded, "depth");
    assert.match(staticSiteExecutionRejectionReason(evidence), /depth limit/iu);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("static site evidence rejects source directory identity changes during readdir", async () => {
  const workspaceRoot = join(ROOT_DIR, ".beep-dev", "workspace");
  const sourceName = `evidence-race-${process.pid}-${Date.now()}`;
  const source = join(workspaceRoot, sourceName);
  const { dir, cleanup } = tempDir();
  const outside = join(dir, "outside");
  const originalReaddirSync = fs.readdirSync;
  let swapped = false;
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>safe</h1>\n");
    writeFileSync(join(outside, "outside-secret.txt"), "secret\n");

    fs.readdirSync = function readdirSyncWithDirectorySwap(path, ...args) {
      if (path === source && !swapped) {
        swapped = true;
        rmSync(source, { recursive: true, force: true });
        symlinkSync(outside, source);
      }
      return originalReaddirSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();

    const { collectStaticSiteEvidence: checkedCollectStaticSiteEvidence } = await import(
      `../src/gatekeeper/evidence.mjs?readdir-race=${Date.now()}`
    );
    const evidence = checkedCollectStaticSiteEvidence({
      sourcePath: `/workspace/${sourceName}`,
    });

    assert.equal(evidence.ok, false);
    assert.match(evidence.error, /changed|symlink|safe directory/iu);
    assert.notEqual(evidence.fileCount, 1);
    assert.deepEqual(evidence.suspiciousFiles, undefined);
  } finally {
    fs.readdirSync = originalReaddirSync;
    syncBuiltinESMExports();
    rmSync(source, { recursive: true, force: true });
    cleanup();
  }
});

test("static site evidence rejects real trees that exceed the directory count limit", () => {
  const workspaceRoot = join(ROOT_DIR, ".beep-dev", "workspace");
  const sourceName = `evidence-dirs-${process.pid}-${Date.now()}`;
  const source = join(workspaceRoot, sourceName);
  try {
    mkdirSync(join(source, "assets"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");

    const evidence = collectStaticSiteEvidence({
      sourcePath: `/workspace/${sourceName}`,
      maxDirs: 1,
    });

    assert.equal(evidence.limitExceeded, "dirs");
    assert.match(staticSiteExecutionRejectionReason(evidence), /directory count limit/iu);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("static site evidence rejects real trees that exceed the file count limit", () => {
  const workspaceRoot = join(ROOT_DIR, ".beep-dev", "workspace");
  const sourceName = `evidence-files-${process.pid}-${Date.now()}`;
  const source = join(workspaceRoot, sourceName);
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(source, "app.css"), "body { color: black; }\n");

    const evidence = collectStaticSiteEvidence({
      sourcePath: `/workspace/${sourceName}`,
      maxFiles: 1,
    });

    assert.equal(evidence.limitExceeded, "files");
    assert.match(staticSiteExecutionRejectionReason(evidence), /file count limit/iu);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("static site snapshot rejects real trees that exceed the file count limit", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(source, "app.css"), "body { color: black; }\n");

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          maxFiles: 1,
        }),
      /file count exceeds configured limit/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects excessive directory depth", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(join(source, "assets", "nested"), { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(source, "assets", "nested", "leaf.txt"), "leaf\n");

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          maxDepth: 1,
        }),
      /directory depth exceeds configured limit/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects oversized files before reading file contents", async () => {
  const { dir, cleanup } = tempDir();
  const originalReadSync = fs.readSync;
  let readAttempted = false;
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>oversized</h1>\n");

    const { createStaticSiteSnapshot: checkedCreateSnapshot } = await import(
      `../src/static-site-preview.mjs?byte-cap=${Date.now()}`
    );
    fs.readSync = function readSyncWithAllocationCheck(...args) {
      readAttempted = true;
      return originalReadSync.apply(this, args);
    };
    syncBuiltinESMExports();

    assert.throws(
      () =>
        checkedCreateSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          maxBytes: 1,
        }),
      /total bytes exceed configured limit/iu,
    );
    assert.equal(readAttempted, false);
  } finally {
    fs.readSync = originalReadSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("static site execution rejection reports invalid evidence and traversal limits", () => {
  assert.equal(staticSiteExecutionRejectionReason({ ok: false, error: "bad source" }), "bad source");
  assert.match(
    staticSiteExecutionRejectionReason({
      ok: true,
      hasIndexHtml: true,
      limitExceeded: "dirs",
    }),
    /directory count limit/iu,
  );
});

function dockerSpawnStubForUpdate({ oldContainerName, newContainerPrefix, port = 49152, failOnRun = false, rmFailures = new Map() }) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      assert.equal(command, "docker");
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        const subcommand = args[0];
        if (subcommand === "run") {
          const nameIndex = args.indexOf("--name");
          const containerName = nameIndex === -1 ? "" : args[nameIndex + 1];
          assert.match(containerName, new RegExp(`^${newContainerPrefix}`));
          if (failOnRun) {
            child.stderr.write("replacement container failed\n");
            child.stderr.end();
            child.emit("close", 1);
            return;
          }
          child.stdout.write("new-container-id\n");
          child.stdout.end();
          child.emit("close", 0);
          return;
        }
        if (subcommand === "port") {
          child.stdout.write(`127.0.0.1:${port}\n`);
          child.stdout.end();
          child.emit("close", 0);
          return;
        }
        if (subcommand === "rm") {
          const containerName = args[2];
          const failure = rmFailures.get(containerName);
          if (failure) {
            child.stderr.write(failure);
            child.stderr.end();
            child.emit("close", 1);
            return;
          }
          assert.equal(args[1], "-f");
          assert.equal(containerName === oldContainerName || containerName.startsWith(newContainerPrefix), true);
          child.stdout.write(containerName);
          child.stdout.end();
          child.emit("close", 0);
          return;
        }
        child.stderr.write(`unexpected docker args: ${args.join(" ")}\n`);
        child.stderr.end();
        child.emit("close", 1);
      });
      return child;
    },
  };
}

function dockerSpawnStubForPortFailure({ runContainerPrefix }) {
  const calls = [];
  let startedContainerName = null;
  let startedSnapshotPath = null;
  return {
    calls,
    startedSnapshotPath: () => startedSnapshotPath,
    spawn(command, args, options) {
      assert.equal(command, "docker");
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        const subcommand = args[0];
        if (subcommand === "run") {
          const nameIndex = args.indexOf("--name");
          startedContainerName = nameIndex === -1 ? "" : args[nameIndex + 1];
          assert.match(startedContainerName, new RegExp(`^${runContainerPrefix}`));
          const volume = args.find((arg) => typeof arg === "string" && arg.endsWith(":/site:ro"));
          startedSnapshotPath = volume ? volume.slice(0, -":/site:ro".length) : null;
          child.stdout.write("started-container-id\n");
          child.stdout.end();
          child.emit("close", 0);
          return;
        }
        if (subcommand === "port") {
          assert.equal(args[1], startedContainerName);
          child.stderr.write("port lookup failed\n");
          child.stderr.end();
          child.emit("close", 1);
          return;
        }
        if (subcommand === "rm") {
          assert.equal(args[1], "-f");
          assert.equal(args[2], startedContainerName);
          child.stdout.write(startedContainerName);
          child.stdout.end();
          child.emit("close", 0);
          return;
        }
        child.stderr.write(`unexpected docker args: ${args.join(" ")}\n`);
        child.stderr.end();
        child.emit("close", 1);
      });
      return child;
    },
  };
}

test("static site create removes started container when port lookup fails", async () => {
  const originalSpawn = childProcess.spawn;
  const workspaceRoot = join(ROOT_DIR, ".beep-dev", "workspace");
  const sourceName = `port-fail-create-${process.pid}-${Date.now()}`;
  const source = join(workspaceRoot, sourceName);
  const siteName = `port-fail-create-${process.pid}`;
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");

    const upserts = [];
    const store = {
      upsertSite(site, auditEvent) {
        upserts.push({ site, auditEvent });
      },
    };
    const stub = dockerSpawnStubForPortFailure({
      runContainerPrefix: `beep-preview-${siteName}-`,
    });
    childProcess.spawn = stub.spawn;
    syncBuiltinESMExports();

    const { createStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?create-port-failure=${Date.now()}`
    );

    await assert.rejects(
      createStaticSitePreview({
        runtimeId: "local",
        args: { sourcePath: `/workspace/${sourceName}`, siteName },
        approvalId: "approval-port-failure",
        store,
      }),
      /port lookup failed/iu,
    );

    assert.deepEqual(
      stub.calls.map((args) => args[0]),
      ["run", "port", "rm"],
    );
    assert.equal(upserts.length, 0);
    assert.equal(existsSync(stub.startedSnapshotPath()), false);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(source, { recursive: true, force: true });
  }
});

test("static site update preserves site id and swaps to a fresh snapshot and container", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `update-${process.pid}-${Date.now()}`;
  const oldContainerName = `beep-preview-${siteId}`;
  const { dir, cleanup } = tempDir();
  const source = join(dir, "workspace-site");
  const oldSnapshotPath = join(STATE_DIR, "static-site-snapshots", `${siteId}-old`);
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>updated</h1>\n");
    mkdirSync(oldSnapshotPath, { recursive: true });
    writeFileSync(join(oldSnapshotPath, "index.html"), "<h1>old</h1>\n");

    const upserts = [];
    const store = {
      upsertSite(site, auditEvent) {
        upserts.push({ site, auditEvent });
      },
    };
    const stub = dockerSpawnStubForUpdate({
      oldContainerName,
      newContainerPrefix: `beep-preview-${siteId}-r2-`,
      port: 49177,
    });
    childProcess.spawn = stub.spawn;
    syncBuiltinESMExports();

    const { updateStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?update-success=${Date.now()}`
    );
    const updated = await updateStaticSitePreview({
      runtimeId: "local",
      site: {
        siteId,
        runtimeId: "local",
        status: "running",
        sourcePath: "/workspace/api-sessions/agent_beep/site",
        snapshotPath: oldSnapshotPath,
        snapshotFileCount: 1,
        snapshotTotalBytes: 13,
        containerName: oldContainerName,
        containerId: "old-container-id",
        hostPort: 49170,
        proxyUrl: `http://127.0.0.1:8788/sites/${siteId}/`,
        directUrl: "http://127.0.0.1:49170/",
        revision: 1,
      },
      args: { sourcePath: "/workspace/api-sessions/agent_beep/site" },
      store,
      sourceHostPath: source,
      trustedRoot: source,
    });

    assert.equal(updated.siteId, siteId);
    assert.equal(updated.revision, 2);
    assert.equal(updated.proxyUrl, `http://127.0.0.1:8788/sites/${siteId}/`);
    assert.equal(updated.directUrl, "http://127.0.0.1:49177/");
    assert.equal(updated.previousContainerName, oldContainerName);
    assert.equal(updated.previousSnapshotPath, oldSnapshotPath);
    assert.equal(readFileSync(join(updated.snapshotPath, "index.html"), "utf8"), "<h1>updated</h1>\n");
    assert.equal(existsSync(oldSnapshotPath), false);
    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].auditEvent, undefined);
    assert.equal(upserts[1].auditEvent.kind, "site_updated");
    assert.equal(upserts[1].auditEvent.cleanup.oldContainerRemoval, "removed");
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(oldSnapshotPath, { recursive: true, force: true });
    cleanup();
  }
});

test("static site update removes replacement container when port lookup fails", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `update-port-fail-${process.pid}-${Date.now()}`;
  const oldContainerName = `beep-preview-${siteId}`;
  const { dir, cleanup } = tempDir();
  const source = join(dir, "workspace-site");
  const oldSnapshotPath = join(STATE_DIR, "static-site-snapshots", `${siteId}-old`);
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>updated</h1>\n");
    mkdirSync(oldSnapshotPath, { recursive: true });
    writeFileSync(join(oldSnapshotPath, "index.html"), "<h1>old</h1>\n");

    const upserts = [];
    const store = {
      upsertSite(site, auditEvent) {
        upserts.push({ site, auditEvent });
      },
    };
    const stub = dockerSpawnStubForPortFailure({
      runContainerPrefix: `beep-preview-${siteId}-r2-`,
    });
    childProcess.spawn = stub.spawn;
    syncBuiltinESMExports();

    const { updateStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?update-port-failure=${Date.now()}`
    );

    await assert.rejects(
      updateStaticSitePreview({
        runtimeId: "local",
        site: {
          siteId,
          runtimeId: "local",
          status: "running",
          sourcePath: "/workspace/api-sessions/agent_beep/site",
          snapshotPath: oldSnapshotPath,
          snapshotFileCount: 1,
          snapshotTotalBytes: 13,
          containerName: oldContainerName,
          containerId: "old-container-id",
          hostPort: 49170,
          proxyUrl: `http://127.0.0.1:8788/sites/${siteId}/`,
          directUrl: "http://127.0.0.1:49170/",
          revision: 1,
        },
        args: { sourcePath: "/workspace/api-sessions/agent_beep/site" },
        store,
        sourceHostPath: source,
        trustedRoot: source,
      }),
      /port lookup failed/iu,
    );

    assert.deepEqual(
      stub.calls.map((args) => args[0]),
      ["run", "port", "rm"],
    );
    assert.equal(upserts.length, 0);
    assert.equal(existsSync(oldSnapshotPath), true);
    assert.equal(existsSync(stub.startedSnapshotPath()), false);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(oldSnapshotPath, { recursive: true, force: true });
    cleanup();
  }
});

test("static site update keeps replacement assets after state swap if audit write fails", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `update-audit-fail-${process.pid}-${Date.now()}`;
  const oldContainerName = `beep-preview-${siteId}`;
  const { dir, cleanup } = tempDir();
  const source = join(dir, "workspace-site");
  const oldSnapshotPath = join(STATE_DIR, "static-site-snapshots", `${siteId}-old`);
  let replacementSnapshotPath = null;
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>updated</h1>\n");
    mkdirSync(oldSnapshotPath, { recursive: true });
    writeFileSync(join(oldSnapshotPath, "index.html"), "<h1>old</h1>\n");

    const upserts = [];
    const store = {
      upsertSite(site, auditEvent) {
        upserts.push({ site, auditEvent });
        if (upserts.length === 1) {
          replacementSnapshotPath = site.snapshotPath;
          return;
        }
        throw new Error("audit write failed");
      },
    };
    const stub = dockerSpawnStubForUpdate({
      oldContainerName,
      newContainerPrefix: `beep-preview-${siteId}-r2-`,
      port: 49188,
    });
    childProcess.spawn = stub.spawn;
    syncBuiltinESMExports();

    const { updateStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?update-audit-failure=${Date.now()}`
    );

    await assert.rejects(
      updateStaticSitePreview({
        runtimeId: "local",
        site: {
          siteId,
          runtimeId: "local",
          status: "running",
          sourcePath: "/workspace/api-sessions/agent_beep/site",
          snapshotPath: oldSnapshotPath,
          snapshotFileCount: 1,
          snapshotTotalBytes: 13,
          containerName: oldContainerName,
          containerId: "old-container-id",
          hostPort: 49170,
          proxyUrl: `http://127.0.0.1:8788/sites/${siteId}/`,
          directUrl: "http://127.0.0.1:49170/",
          revision: 1,
        },
        args: { sourcePath: "/workspace/api-sessions/agent_beep/site" },
        store,
        sourceHostPath: source,
        trustedRoot: source,
      }),
      /audit write failed/iu,
    );

    const rmCalls = stub.calls.filter((args) => args[0] === "rm");
    assert.equal(rmCalls.length, 1);
    assert.equal(rmCalls[0][2], oldContainerName);
    assert.equal(upserts.length, 2);
    assert.equal(upserts[0].auditEvent, undefined);
    assert.equal(upserts[1].auditEvent.kind, "site_updated");
    assert.equal(existsSync(oldSnapshotPath), false);
    assert.equal(readFileSync(join(replacementSnapshotPath, "index.html"), "utf8"), "<h1>updated</h1>\n");
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(oldSnapshotPath, { recursive: true, force: true });
    if (replacementSnapshotPath) {
      rmSync(replacementSnapshotPath, { recursive: true, force: true });
    }
    cleanup();
  }
});

test("static site removal cleans up stale missing docker containers", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `stale-${process.pid}-${Date.now()}`;
  const containerName = `beep-preview-${siteId}`;
  const snapshotPath = join(STATE_DIR, "static-site-snapshots", siteId);
  try {
    mkdirSync(snapshotPath, { recursive: true });
    writeFileSync(join(snapshotPath, "index.html"), "<h1>demo</h1>\n");

    childProcess.spawn = function spawnMissingContainer(command, args, options) {
      assert.equal(command, "docker");
      assert.deepEqual(args, ["rm", "-f", containerName]);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stderr.write(`Error response from daemon: No such container: ${containerName}\n`);
        child.stderr.end();
        child.emit("close", 1);
      });
      return child;
    };
    syncBuiltinESMExports();

    const upserts = [];
    const store = {
      upsertSite(site, auditEvent) {
        upserts.push({ site, auditEvent });
      },
    };
    const { removeStaticSitePreview: checkedRemoveStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?stale-container=${Date.now()}`
    );

    const stopped = await checkedRemoveStaticSitePreview({
      site: {
        siteId,
        runtimeId: "local",
        containerName,
        snapshotPath,
        status: "running",
      },
      store,
    });

    assert.equal(stopped.status, "stopped");
    assert.equal(existsSync(snapshotPath), false);
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].auditEvent.dockerRemoval, "container_missing");
    assert.match(upserts[0].auditEvent.dockerError, /No such container/);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(snapshotPath, { recursive: true, force: true });
  }
});

test("static site removal preserves unexpected docker failures", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `docker-failure-${process.pid}-${Date.now()}`;
  const containerName = `beep-preview-${siteId}`;
  const snapshotPath = join(STATE_DIR, "static-site-snapshots", siteId);
  try {
    mkdirSync(snapshotPath, { recursive: true });
    writeFileSync(join(snapshotPath, "index.html"), "<h1>demo</h1>\n");

    childProcess.spawn = function spawnUnexpectedFailure(command, args, options) {
      assert.equal(command, "docker");
      assert.deepEqual(args, ["rm", "-f", containerName]);
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        child.stderr.write("permission denied while removing container\n");
        child.stderr.end();
        child.emit("close", 1);
      });
      return child;
    };
    syncBuiltinESMExports();

    const upserts = [];
    const store = {
      upsertSite(site, auditEvent) {
        upserts.push({ site, auditEvent });
      },
    };
    const { removeStaticSitePreview: checkedRemoveStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?unexpected-docker=${Date.now()}`
    );

    await assert.rejects(
      checkedRemoveStaticSitePreview({
        site: {
          siteId,
          runtimeId: "local",
          containerName,
          snapshotPath,
          status: "running",
        },
        store,
      }),
      /permission denied/iu,
    );
    assert.equal(upserts.length, 0);
    assert.equal(existsSync(snapshotPath), true);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(snapshotPath, { recursive: true, force: true });
  }
});
