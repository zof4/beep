# Managed Static Site Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add same-URL redeploy support for managed static-site previews so Beep can update an already-live static website without changing its `/sites/<siteId>/` URL.

**Architecture:** Keep Docker and snapshot authority in the host control plane. A new `updateStaticSitePreview` worker validates updated runtime workspace files, creates a fresh read-only snapshot, starts a replacement container, swaps the existing site record to the new container/port/snapshot under the same `siteId`, then cleans up old assets. The agent reaches this through a restricted broker tool; operators can also trigger it with `POST /api/sites/<siteId>/update`.

**Tech Stack:** Node.js ESM, `node:test`, local JSON `StateStore`, Docker CLI via `spawn`, control-plane `ToolBroker`, deterministic local gatekeeper policy.

---

## File Structure

- Modify `control-plane/src/static-site-preview.mjs`
  - Owns snapshot creation/removal, Docker container lifecycle, create/stop preview behavior.
  - Add `updateStaticSitePreview({ runtimeId, site, args, store })`.
  - Add small private helpers for starting replacement containers and cleaning old assets.

- Modify `control-plane/test/static-site-preview.test.mjs`
  - Add direct unit tests for success, validation failure, replacement start failure, and old cleanup diagnostics.

- Modify `control-plane/src/tool-manifest.mjs`
  - Add `preview_container_update_static_site` with action `preview.container.updateStaticSite`.

- Modify `control-plane/src/tool-broker.mjs`
  - Import `updateStaticSitePreview`.
  - Execute `preview.container.updateStaticSite` after approval.

- Modify `control-plane/test/tool-broker.test.mjs`
  - Prove approved static-site update routes through broker execution.

- Modify `control-plane/src/gatekeeper/evidence.mjs`
  - Reuse `collectStaticSiteEvidence` for `preview.container.updateStaticSite`.

- Modify `control-plane/src/gatekeeper/index.mjs`
  - Treat create and update as the same static-preview policy domain.
  - Include update intent phrases and `siteId` path/reference scoring.

- Modify `control-plane/test/gatekeeper.test.mjs`
  - Add update allow/deny/escalation coverage.

- Modify `control-plane/src/site-routes.mjs`
  - Add operator-only `POST /api/sites/<siteId>/update`.
  - Inject `updateStaticSitePreview` for tests.

- Create `control-plane/test/site-routes.test.mjs`
  - Focus route/auth tests for site update.

- Modify `control-plane/README.md`
  - Document static-site update semantics and stable URL contract.

---

## Task 1: Static Site Update Worker

**Files:**
- Modify: `control-plane/src/static-site-preview.mjs`
- Modify: `control-plane/test/static-site-preview.test.mjs`

- [ ] **Step 1: Write failing success test for same-URL update**

Append this test helper and test near the existing static-site preview tests in `control-plane/test/static-site-preview.test.mjs`. Reuse the existing imports already present in that file.

```js
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
```

- [ ] **Step 2: Run success test and verify it fails because update function is missing**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs --test-name-pattern "static site update preserves site id"
```

Expected: FAIL with an error like:

```text
updateStaticSitePreview is not a function
```

- [ ] **Step 3: Implement minimal update worker**

Add these helpers after `isMissingDockerContainerError`:

```js
function nowIso() {
  return new Date().toISOString();
}

function nextSiteRevision(site) {
  const currentRevision = Number.isInteger(site?.revision) && site.revision > 0 ? site.revision : 1;
  return currentRevision + 1;
}

function staticPreviewContainerName({ siteId, revision }) {
  return `beep-preview-${siteId}-r${revision}-${randomBytes(3).toString("hex")}`;
}

function snapshotIdForUpdate({ siteId, revision }) {
  return `${siteId}-r${revision}-${randomBytes(4).toString("hex")}`;
}

async function startStaticSiteContainer({ runtimeId, siteId, approvalId, revision, snapshotPath, containerName }) {
  const runResult = await run("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    "beep.managed=true",
    "--label",
    `beep.runtime_id=${runtimeId}`,
    "--label",
    `beep.site_id=${siteId}`,
    "--label",
    `beep.site_revision=${revision}`,
    "--label",
    `beep.approval_id=${approvalId || "operator"}`,
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m,mode=1777",
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${snapshotPath}:/site:ro`,
    STATIC_SITE_IMAGE,
    "node",
    "-e",
    staticServerScript(),
  ]);
  const containerId = runResult.stdout.trim();
  const portResult = await run("docker", ["port", containerName, "8080/tcp"]);
  const portMatch = portResult.stdout.match(/127[.]0[.]0[.]1:(\d+)/u);
  if (!portMatch) {
    throw new ToolBrokerError(`Could not determine mapped site port for ${containerName}.`, 500);
  }
  return {
    containerId,
    hostPort: Number(portMatch[1]),
  };
}

async function removeStaticSiteContainer(containerName) {
  try {
    await run("docker", ["rm", "-f", containerName]);
    return { removal: "removed", error: null };
  } catch (error) {
    if (!isMissingDockerContainerError(error)) throw error;
    return {
      removal: "container_missing",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cleanupOldStaticSiteAssets(site) {
  const cleanup = {
    oldContainerRemoval: "not_attempted",
    oldContainerError: null,
    oldSnapshotRemoval: "not_attempted",
    oldSnapshotError: null,
  };
  if (site.containerName) {
    try {
      const removed = await removeStaticSiteContainer(site.containerName);
      cleanup.oldContainerRemoval = removed.removal;
      cleanup.oldContainerError = removed.error;
    } catch (error) {
      cleanup.oldContainerRemoval = "failed";
      cleanup.oldContainerError = error instanceof Error ? error.message : String(error);
    }
  }
  if (site.snapshotPath) {
    try {
      removeStaticSiteSnapshot(site.snapshotPath);
      cleanup.oldSnapshotRemoval = "removed";
    } catch (error) {
      cleanup.oldSnapshotRemoval = "failed";
      cleanup.oldSnapshotError = error instanceof Error ? error.message : String(error);
    }
  }
  return cleanup;
}
```

Refactor `createStaticSitePreview` to use `startStaticSiteContainer` instead of duplicating `docker run` and `docker port` inline:

```js
    const started = await startStaticSiteContainer({
      runtimeId,
      siteId,
      approvalId,
      revision: 1,
      snapshotPath: snapshot.snapshotPath,
      containerName,
    });
    containerStarted = true;
    const site = {
      siteId,
      runtimeId,
      approvalId,
      siteName: siteSlug,
      status: "running",
      sourcePath: args.sourcePath,
      snapshotPath: snapshot.snapshotPath,
      snapshotFileCount: snapshot.fileCount,
      snapshotTotalBytes: snapshot.totalBytes,
      containerName,
      containerId: started.containerId,
      image: STATIC_SITE_IMAGE,
      hostPort: started.hostPort,
      proxyUrl: `${PUBLIC_BASE_URL}/sites/${siteId}/`,
      directUrl: `http://127.0.0.1:${started.hostPort}/`,
      revision: 1,
      createdAt: nowIso(),
    };
```

Then add this exported function before `removeStaticSitePreview`:

```js
export async function updateStaticSitePreview({ runtimeId, site, args, store, sourceHostPath = null, trustedRoot = null }) {
  if (runtimeId !== RUNTIME_ID) {
    throw new ToolBrokerError(`Unknown runtimeId: ${runtimeId}`, 404);
  }
  if (!site?.siteId) {
    throw new ToolBrokerError("Static preview update requires an existing site.", 400);
  }
  if (site.runtimeId !== runtimeId) {
    throw new ToolBrokerError(`Site ${site.siteId} does not belong to runtime ${runtimeId}.`, 404);
  }
  if (site.status === "stopped") {
    throw new ToolBrokerError(`Site is stopped: ${site.siteId}`, 410);
  }

  const evidence = sourceHostPath && trustedRoot
    ? { ok: true, hostPath: sourceHostPath, workspaceRoot: trustedRoot }
    : validateStaticSiteSourceForExecution(args);
  const revision = nextSiteRevision(site);
  const snapshotSiteId = snapshotIdForUpdate({ siteId: site.siteId, revision });
  const containerName = staticPreviewContainerName({ siteId: site.siteId, revision });
  const snapshot = createStaticSiteSnapshot({
    sourceHostPath: evidence.hostPath,
    siteId: snapshotSiteId,
    trustedRoot: evidence.workspaceRoot,
  });

  let replacementStarted = false;
  try {
    const started = await startStaticSiteContainer({
      runtimeId,
      siteId: site.siteId,
      approvalId: site.approvalId || "operator",
      revision,
      snapshotPath: snapshot.snapshotPath,
      containerName,
    });
    replacementStarted = true;
    const updatedAt = nowIso();
    const updated = {
      ...site,
      runtimeId,
      siteId: site.siteId,
      status: "running",
      sourcePath: args.sourcePath || site.sourcePath,
      snapshotPath: snapshot.snapshotPath,
      snapshotFileCount: snapshot.fileCount,
      snapshotTotalBytes: snapshot.totalBytes,
      containerName,
      containerId: started.containerId,
      image: STATIC_SITE_IMAGE,
      hostPort: started.hostPort,
      proxyUrl: `${PUBLIC_BASE_URL}/sites/${site.siteId}/`,
      directUrl: `http://127.0.0.1:${started.hostPort}/`,
      previousContainerName: site.containerName,
      previousSnapshotPath: site.snapshotPath,
      revision,
      updatedAt,
      lastUpdate: {
        sourcePath: args.sourcePath || site.sourcePath,
        snapshotFileCount: snapshot.fileCount,
        snapshotTotalBytes: snapshot.totalBytes,
        updatedAt,
      },
    };

    store.upsertSite(updated);
    const cleanup = await cleanupOldStaticSiteAssets(site);
    const finalUpdated = {
      ...updated,
      cleanup,
    };
    store.upsertSite(finalUpdated, {
      kind: "site_updated",
      siteId: site.siteId,
      runtimeId,
      previousContainerName: site.containerName || null,
      containerName,
      revision,
      cleanup,
    });
    return {
      ...finalUpdated,
    };
  } catch (error) {
    if (replacementStarted) {
      await run("docker", ["rm", "-f", containerName]).catch(() => null);
    }
    removeStaticSiteSnapshot(snapshot.snapshotPath);
    throw error;
  }
}
```

Also update `removeStaticSitePreview` to call `removeStaticSiteContainer(site.containerName)` and use its result instead of duplicating the missing-container logic:

```js
  const removed = await removeStaticSiteContainer(site.containerName);
  const stopped = {
    ...site,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
  };
  store.upsertSite(stopped, {
    kind: "site_stopped",
    siteId: site.siteId,
    runtimeId: site.runtimeId,
    containerName: site.containerName,
    dockerRemoval: removed.removal,
    dockerError: removed.error,
  });
```

- [ ] **Step 4: Run success test and verify it passes**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs --test-name-pattern "static site update preserves site id"
```

Expected: PASS with `1` passing test.

- [ ] **Step 5: Commit Task 1**

```bash
git add control-plane/src/static-site-preview.mjs control-plane/test/static-site-preview.test.mjs
git commit -m "feat: update managed static previews"
```

---

## Task 2: Static Site Update Failure Tests

**Files:**
- Modify: `control-plane/test/static-site-preview.test.mjs`
- Modify: `control-plane/src/static-site-preview.mjs`

- [ ] **Step 1: Write failing validation and replacement-start failure tests**

Append these tests after the Task 1 update success test:

```js
test("static site update validation failure leaves existing site untouched", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `update-invalid-${process.pid}-${Date.now()}`;
  const oldSnapshotPath = join(STATE_DIR, "static-site-snapshots", `${siteId}-old`);
  const { dir, cleanup } = tempDir();
  const source = join(dir, "workspace-site");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, ".env"), "TOKEN=secret\n");
    mkdirSync(oldSnapshotPath, { recursive: true });
    writeFileSync(join(oldSnapshotPath, "index.html"), "<h1>old</h1>\n");
    childProcess.spawn = function spawnShouldNotRun() {
      throw new Error("docker must not run after validation failure");
    };
    syncBuiltinESMExports();

    const { updateStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?update-validation=${Date.now()}`
    );
    await assert.rejects(
      updateStaticSitePreview({
        runtimeId: "local",
        site: {
          siteId,
          runtimeId: "local",
          status: "running",
          sourcePath: "/workspace/site",
          snapshotPath: oldSnapshotPath,
          containerName: `beep-preview-${siteId}`,
          hostPort: 49170,
        },
        args: { sourcePath: "/workspace/site" },
        store: { upsertSite() { throw new Error("site record must not be updated"); } },
        sourceHostPath: source,
        trustedRoot: source,
      }),
      /secret or credential/iu,
    );
    assert.equal(existsSync(oldSnapshotPath), true);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(oldSnapshotPath, { recursive: true, force: true });
    cleanup();
  }
});

test("static site update replacement start failure removes only the new snapshot", async () => {
  const originalSpawn = childProcess.spawn;
  const siteId = `update-start-failure-${process.pid}-${Date.now()}`;
  const oldContainerName = `beep-preview-${siteId}`;
  const oldSnapshotPath = join(STATE_DIR, "static-site-snapshots", `${siteId}-old`);
  const { dir, cleanup } = tempDir();
  const source = join(dir, "workspace-site");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>updated</h1>\n");
    mkdirSync(oldSnapshotPath, { recursive: true });
    writeFileSync(join(oldSnapshotPath, "index.html"), "<h1>old</h1>\n");
    const stub = dockerSpawnStubForUpdate({
      oldContainerName,
      newContainerPrefix: `beep-preview-${siteId}-r2-`,
      failOnRun: true,
    });
    childProcess.spawn = stub.spawn;
    syncBuiltinESMExports();

    const { updateStaticSitePreview } = await import(
      `../src/static-site-preview.mjs?update-start-failure=${Date.now()}`
    );
    await assert.rejects(
      updateStaticSitePreview({
        runtimeId: "local",
        site: {
          siteId,
          runtimeId: "local",
          status: "running",
          sourcePath: "/workspace/site",
          snapshotPath: oldSnapshotPath,
          containerName: oldContainerName,
          hostPort: 49170,
          revision: 1,
        },
        args: { sourcePath: "/workspace/site" },
        store: { upsertSite() { throw new Error("site record must not be updated"); } },
        sourceHostPath: source,
        trustedRoot: source,
      }),
      /replacement container failed/iu,
    );
    assert.equal(existsSync(oldSnapshotPath), true);
    const snapshotRoot = join(STATE_DIR, "static-site-snapshots");
    const leaked = fs.readdirSync(snapshotRoot).filter((entry) => entry.startsWith(`${siteId}-r2-`));
    assert.deepEqual(leaked, []);
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    rmSync(oldSnapshotPath, { recursive: true, force: true });
    cleanup();
  }
});
```

If `fs` is already imported as both default and named import, use `fs.readdirSync(...)` exactly as shown.

- [ ] **Step 2: Run failure tests and verify they fail for current implementation gaps**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs --test-name-pattern "static site update .*failure"
```

Expected before fixes: at least one FAIL, most likely because `sourceHostPath` bypass does not run full snapshot validation or failed replacement cleanup leaks a snapshot.

- [ ] **Step 3: Tighten `updateStaticSitePreview` validation and cleanup**

In `control-plane/src/static-site-preview.mjs`, change the evidence selection block in `updateStaticSitePreview` so test overrides still run snapshot validation and production still runs gatekeeper evidence validation:

```js
  const evidence = sourceHostPath && trustedRoot
    ? { ok: true, hostPath: sourceHostPath, workspaceRoot: trustedRoot }
    : validateStaticSiteSourceForExecution(args);
```

Keep this block, but rely on the existing `createStaticSiteSnapshot` call to catch `.env`, symlink, file count, byte count, depth, and missing `index.html`. Make sure the `catch` block always removes `snapshot.snapshotPath` even when Docker never starts:

```js
  } catch (error) {
    if (replacementStarted) {
      await run("docker", ["rm", "-f", containerName]).catch(() => null);
    }
    removeStaticSiteSnapshot(snapshot.snapshotPath);
    throw error;
  }
```

If the tests show a leaked empty snapshot root entry, ensure `removeStaticSiteSnapshot` receives exactly `snapshot.snapshotPath`, not the old site's path.

- [ ] **Step 4: Run update worker tests**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs --test-name-pattern "static site update"
```

Expected: PASS for all static site update tests.

- [ ] **Step 5: Run full static preview test file**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs
```

Expected: PASS for the full file, including existing create/stop tests.

- [ ] **Step 6: Commit Task 2**

```bash
git add control-plane/src/static-site-preview.mjs control-plane/test/static-site-preview.test.mjs
git commit -m "test: cover static preview update failures"
```

---

## Task 3: Tool Manifest and Broker Wiring

**Files:**
- Modify: `control-plane/src/tool-manifest.mjs`
- Modify: `control-plane/src/tool-broker.mjs`
- Modify: `control-plane/test/tool-broker.test.mjs`

- [ ] **Step 1: Write failing broker test for approved update execution**

Append this test to `control-plane/test/tool-broker.test.mjs`:

```js
test("approved static site update executes through the managed preview updater", async () => {
  const { store, cleanup } = tempStore();
  try {
    const broker = new ToolBroker({ store });
    const approval = store.createApproval({
      runtimeId: RUNTIME_ID,
      toolCallId: "call_update_static",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      risk: "high",
      prompt: "Approve update?",
      reason: "Tool is configured for review.",
    });
    const executing = store.updateApproval(approval.approvalId, { status: "executing" });
    store.upsertSite({
      siteId: "demo-site",
      runtimeId: RUNTIME_ID,
      status: "running",
      sourcePath: "/workspace/api-sessions/agent_beep/site",
      snapshotPath: "/tmp/old-snapshot",
      containerName: "beep-preview-demo-site",
      hostPort: 49170,
      proxyUrl: `${PUBLIC_BASE_URL}/sites/demo-site/`,
      revision: 1,
    });

    broker.updateStaticSitePreview = async (input) => {
      assert.equal(input.runtimeId, RUNTIME_ID);
      assert.equal(input.site.siteId, "demo-site");
      assert.deepEqual(input.args, { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" });
      return {
        siteId: "demo-site",
        status: "running",
        proxyUrl: `${PUBLIC_BASE_URL}/sites/demo-site/`,
        directUrl: "http://127.0.0.1:49199/",
        revision: 2,
      };
    };

    const result = await broker.executeApprovedApproval(executing);

    assert.equal(result.siteId, "demo-site");
    assert.equal(result.revision, 2);
    assert.equal(result.proxyUrl, `${PUBLIC_BASE_URL}/sites/demo-site/`);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run broker test and verify it fails**

Run:

```bash
node --test control-plane/test/tool-broker.test.mjs --test-name-pattern "approved static site update"
```

Expected: FAIL with `No approved broker implementation for preview.container.updateStaticSite` or unknown tool action.

- [ ] **Step 3: Add manifest entry**

In `control-plane/src/tool-manifest.mjs`, add this object immediately after `preview_container_create_static_site`:

```js
  {
    name: "preview_container_update_static_site",
    action: "preview.container.updateStaticSite",
    label: "Update Static Preview Container",
    description:
      "Update an existing managed static-site preview from files already changed inside the runtime workspace while preserving the /sites/<siteId>/ URL.",
    defaultDecision: "review",
    scopes: ["preview.container.updateStaticSite"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["siteId", "sourcePath"],
      properties: {
        siteId: {
          type: "string",
          description: "Existing managed static preview site id returned by preview_container_create_static_site.",
        },
        sourcePath: {
          type: "string",
          description: "Absolute runtime workspace path to the updated static site directory.",
        },
      },
    },
  },
```

Do not add `preview.container.updateStaticSite` to `DEFAULT_ALLOWED_SCOPES`; keeping it absent from default allowed scopes ensures the broker routes it through review.

- [ ] **Step 4: Add broker execution branch**

In `control-plane/src/tool-broker.mjs`, change the import:

```js
import { createStaticSitePreview, updateStaticSitePreview } from "./static-site-preview.mjs";
```

In the `ToolBroker` constructor, store the updater as an injectable property:

```js
    this.updateStaticSitePreview = updateStaticSitePreview;
```

In `executeApprovedApproval`, add this branch after the create branch:

```js
    if (approval.action === "preview.container.updateStaticSite") {
      const siteId = approval.args?.siteId;
      const site = siteId ? this.store.getSite(siteId) : null;
      if (!site) {
        throw new ToolBrokerError(`Unknown siteId: ${siteId}`, 404);
      }
      return this.updateStaticSitePreview({
        runtimeId: approval.runtimeId,
        site,
        args: approval.args || {},
        store: this.store,
      });
    }
```

- [ ] **Step 5: Run broker test**

Run:

```bash
node --test control-plane/test/tool-broker.test.mjs --test-name-pattern "approved static site update"
```

Expected: PASS.

- [ ] **Step 6: Run full broker tests**

Run:

```bash
node --test control-plane/test/tool-broker.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add control-plane/src/tool-manifest.mjs control-plane/src/tool-broker.mjs control-plane/test/tool-broker.test.mjs
git commit -m "feat: expose static preview update tool"
```

---

## Task 4: Gatekeeper Policy for Static Preview Updates

**Files:**
- Modify: `control-plane/src/gatekeeper/evidence.mjs`
- Modify: `control-plane/src/gatekeeper/index.mjs`
- Modify: `control-plane/test/gatekeeper.test.mjs`

- [ ] **Step 1: Write failing gatekeeper allow test for update action**

In `control-plane/test/gatekeeper.test.mjs`, add a helper after `staticSiteDefinition()`:

```js
function staticSiteUpdateDefinition() {
  return TOOL_MANIFEST.find((tool) => tool.action === "preview.container.updateStaticSite");
}
```

Then append this test near the existing static preview allow tests:

```js
test("gatekeeper allows a bounded static preview update when recent context authorizes it", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Update the managed static site demo-site from /workspace/api-sessions/agent_beep/site and keep the same live URL.",
        text:
          "Update the managed static site demo-site from /workspace/api-sessions/agent_beep/site and keep the same live URL.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_allow",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "allow");
    assert.equal(review.decision.scope, "once");
    assert.equal(review.decision.userAuthorization, "medium");
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Write failing gatekeeper denial test for update action**

Append this test near the explicit denial tests:

```js
test("gatekeeper treats explicit static preview update denial as a hard deny", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Do not update the managed static site demo-site from /workspace/api-sessions/agent_beep/site.",
        text:
          "Do not update the managed static site demo-site from /workspace/api-sessions/agent_beep/site.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_deny",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "deny");
    assert.equal(review.decision.userAuthorization, "unknown");
    assert.match(review.decision.auditRationale, /explicitly denied/iu);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 3: Run gatekeeper update tests and verify failure**

Run:

```bash
node --test control-plane/test/gatekeeper.test.mjs --test-name-pattern "static preview update"
```

Expected: FAIL because no local gatekeeper policy and evidence collector are registered for `preview.container.updateStaticSite`.

- [ ] **Step 4: Extend deterministic evidence routing**

In `control-plane/src/gatekeeper/evidence.mjs`, update `collectEvidenceForAction`:

```js
export function collectEvidenceForAction(action, args = {}) {
  if (action === "preview.container.createStaticSite" || action === "preview.container.updateStaticSite") {
    return collectStaticSiteEvidence(args);
  }
  return {
    kind: "unsupported",
    ok: true,
    action,
    note: "No deterministic evidence collector is registered for this action.",
  };
}
```

- [ ] **Step 5: Extend gatekeeper static preview intent parsing**

In `control-plane/src/gatekeeper/index.mjs`, update `pathReferencesForStaticPreview` so `siteId` participates in authorization matching:

```js
  const siteId = typeof args.siteId === "string" ? args.siteId.trim() : "";
```

Then add after the `siteName` handling:

```js
  if (siteId && !genericRefs.has(siteId.toLowerCase())) refs.add(siteId.toLowerCase());
```

Update `hasStaticPreviewIntent`:

```js
function hasStaticPreviewIntent(text) {
  return (
    includesAny(text, [
      "static preview container",
      "managed static",
      "preview_container_create_static_site",
      "preview_container_update_static_site",
    ]) ||
    (includesAny(text, ["static site", "website", "web page", "html", "site"]) &&
      includesAny(text, ["preview", "container", "publish", "serve", "show it", "expose", "create", "update", "redeploy"]))
  );
}
```

Update `hasExplicitStaticPreviewDenial` terms to include update language:

```js
      "update",
      "redeploy",
```

Update the denial regex list:

```js
    /\bnot\s+(?:create|start|run|serve|publish|expose|show|request|open|update|redeploy)\b/u,
```

Update `authScoreForStaticPreview` so authorization for update can score medium:

```js
      includesAny(unit, ["static preview container", "managed static", "preview_container_create_static_site", "preview_container_update_static_site"]) ||
      (includesAny(unit, ["static site", "website", "web page", "html", "site"]) &&
        includesAny(unit, ["preview", "container", "publish", "serve", "show it", "expose", "create", "update", "redeploy"]))
```

Update the low-score fallback:

```js
  if (units.some((unit) => includesAny(unit, ["preview", "website", "site", "html", "update", "redeploy"]))) return "low";
```

Finally, update `localPolicyReview`:

```js
function localPolicyReview({ action, args, context, evidence }) {
  if (action === "preview.container.createStaticSite" || action === "preview.container.updateStaticSite") {
    return localReviewStaticPreview({ args, context, evidence });
  }
```

- [ ] **Step 6: Run focused gatekeeper update tests**

Run:

```bash
node --test control-plane/test/gatekeeper.test.mjs --test-name-pattern "static preview update"
```

Expected: PASS.

- [ ] **Step 7: Run full gatekeeper tests**

Run:

```bash
node --test control-plane/test/gatekeeper.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add control-plane/src/gatekeeper/evidence.mjs control-plane/src/gatekeeper/index.mjs control-plane/test/gatekeeper.test.mjs
git commit -m "feat: review static preview updates"
```

---

## Task 5: Operator Site Update Route

**Files:**
- Modify: `control-plane/src/site-routes.mjs`
- Create: `control-plane/test/site-routes.test.mjs`

- [ ] **Step 1: Write failing site route tests**

Create `control-plane/test/site-routes.test.mjs`:

```js
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { handleSiteRoute } from "../src/site-routes.mjs";

function request(method, url, headers = {}, body = null) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
  return req;
}

function captureResponse() {
  let statusCode = 0;
  let body = "";
  return {
    response: {
      writeHead(status) {
        statusCode = status;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    json() {
      return { statusCode, payload: body ? JSON.parse(body) : null };
    },
  };
}

test("site update route requires operator auth before reading site state", async () => {
  let siteRead = false;
  const req = request("POST", "/api/sites/demo/update", {}, { sourcePath: "/workspace/site" });
  const response = captureResponse();

  await assert.rejects(
    handleSiteRoute({
      request: req,
      response: response.response,
      pathname: "/api/sites/demo/update",
      url: new URL("http://127.0.0.1/api/sites/demo/update"),
      store: {
        getSite() {
          siteRead = true;
          return null;
        },
      },
      requireOperatorAuth() {
        const error = new Error("operator token is invalid");
        error.status = 401;
        throw error;
      },
    }),
    /operator token is invalid/u,
  );

  assert.equal(siteRead, false);
});

test("site update route calls injected updater and returns updated site", async () => {
  const calls = [];
  const site = {
    siteId: "demo",
    runtimeId: "local",
    status: "running",
    sourcePath: "/workspace/old-site",
    proxyUrl: "http://127.0.0.1:8788/sites/demo/",
  };
  const req = request(
    "POST",
    "/api/sites/demo/update",
    { authorization: "Bearer operator" },
    { sourcePath: "/workspace/new-site" },
  );
  const response = captureResponse();

  await handleSiteRoute({
    request: req,
    response: response.response,
    pathname: "/api/sites/demo/update",
    url: new URL("http://127.0.0.1/api/sites/demo/update"),
    store: {
      getSite(siteId) {
        assert.equal(siteId, "demo");
        return site;
      },
    },
    requireOperatorAuth(requestForAuth) {
      assert.equal(requestForAuth.headers.authorization, "Bearer operator");
    },
    updateStaticSitePreview: async (input) => {
      calls.push(input);
      return {
        ...site,
        sourcePath: "/workspace/new-site",
        directUrl: "http://127.0.0.1:49199/",
        revision: 2,
      };
    },
  });

  const { statusCode, payload } = response.json();
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.site.siteId, "demo");
  assert.equal(payload.site.revision, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runtimeId, "local");
  assert.equal(calls[0].site, site);
  assert.deepEqual(calls[0].args, { sourcePath: "/workspace/new-site" });
});
```

- [ ] **Step 2: Run route tests and verify failure**

Run:

```bash
node --test control-plane/test/site-routes.test.mjs
```

Expected: FAIL because `handleSiteRoute` does not accept `updateStaticSitePreview` and does not handle `/update`.

- [ ] **Step 3: Implement update route**

In `control-plane/src/site-routes.mjs`, change imports:

```js
import { removeStaticSitePreview, updateStaticSitePreview as defaultUpdateStaticSitePreview } from "./static-site-preview.mjs";
import { readJsonBody, sendJson, sendNotFound } from "./http-utils.mjs";
```

Change the function signature:

```js
export async function handleSiteRoute({
  request,
  response,
  pathname,
  url,
  store,
  requireOperatorAuth,
  updateStaticSitePreview = defaultUpdateStaticSitePreview,
}) {
```

Add this route before the existing `stop` route:

```js
  if (request.method === "POST" && action === "update") {
    const body = await readJsonBody(request);
    const updated = await updateStaticSitePreview({
      runtimeId: site.runtimeId,
      site,
      args: { sourcePath: String(body.sourcePath || site.sourcePath || "") },
      store,
    });
    sendJson(response, 200, { ok: true, site: updated });
    return;
  }
```

- [ ] **Step 4: Run route tests**

Run:

```bash
node --test control-plane/test/site-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run route-related tests**

Run:

```bash
node --test control-plane/test/site-routes.test.mjs control-plane/test/approval-routes-auth.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add control-plane/src/site-routes.mjs control-plane/test/site-routes.test.mjs
git commit -m "feat: add operator static site update route"
```

---

## Task 6: README and Manifest Verification

**Files:**
- Modify: `control-plane/README.md`
- Test: `control-plane/test/tool-broker.test.mjs`
- Test: `control-plane/test/gatekeeper.test.mjs`

- [ ] **Step 1: Add manifest assertion test**

Append this test to `control-plane/test/tool-broker.test.mjs`:

```js
test("builtin manifest exposes static site update as a reviewed tool", () => {
  const { store, cleanup } = tempStore();
  try {
    const tool = new ToolBroker({ store })
      .manifest()
      .tools.find((candidate) => candidate.action === "preview.container.updateStaticSite");

    assert.equal(tool.name, "preview_container_update_static_site");
    assert.equal(tool.defaultDecision, "review");
    assert.deepEqual(tool.scopes, ["preview.container.updateStaticSite"]);
    assert.deepEqual(tool.inputSchema.required, ["siteId", "sourcePath"]);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run manifest assertion**

Run:

```bash
node --test control-plane/test/tool-broker.test.mjs --test-name-pattern "builtin manifest exposes static site update"
```

Expected: PASS.

- [ ] **Step 3: Update README static preview section**

In `control-plane/README.md`, after the paragraph that describes `preview.container.createStaticSite`, add:

```md
Managed static previews can be updated in place through
`preview.container.updateStaticSite`, exposed to Pi as
`preview_container_update_static_site`. The update action is also restricted:
the runtime can request it, but the control plane revalidates the source path,
builds a fresh read-only snapshot, starts a replacement container, swaps the site
record, and keeps the existing `/sites/<siteId>/` proxy URL stable. The direct
Docker-mapped localhost URL may change after each update.

Operators can exercise the same path with:

```bash
curl -sS -X POST "$CONTROL_PLANE_URL/api/sites/<siteId>/update" \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"sourcePath":"/workspace/api-sessions/agent_beep/site"}'
```
```

- [ ] **Step 4: Run broker and gatekeeper tests**

Run:

```bash
node --test control-plane/test/tool-broker.test.mjs control-plane/test/gatekeeper.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add control-plane/README.md control-plane/test/tool-broker.test.mjs
git commit -m "docs: document static preview updates"
```

---

## Task 7: Full Static Preview Verification

**Files:**
- Verify: `control-plane/src/static-site-preview.mjs`
- Verify: `control-plane/src/site-routes.mjs`
- Verify: `control-plane/src/tool-broker.mjs`
- Verify: `control-plane/src/gatekeeper/index.mjs`
- Verify: `control-plane/src/gatekeeper/evidence.mjs`

- [ ] **Step 1: Run syntax checks**

Run:

```bash
node --check control-plane/src/static-site-preview.mjs
node --check control-plane/src/site-routes.mjs
node --check control-plane/src/tool-broker.mjs
node --check control-plane/src/tool-manifest.mjs
node --check control-plane/src/gatekeeper/index.mjs
node --check control-plane/src/gatekeeper/evidence.mjs
```

Expected: all commands exit `0` with no output.

- [ ] **Step 2: Run focused unit suites**

Run:

```bash
node --test control-plane/test/static-site-preview.test.mjs control-plane/test/site-routes.test.mjs control-plane/test/tool-broker.test.mjs control-plane/test/gatekeeper.test.mjs
```

Expected: PASS for all listed test files.

- [ ] **Step 3: Run route and state regression suites**

Run:

```bash
node --test control-plane/test/approval-routes-auth.test.mjs control-plane/test/state-store.test.mjs control-plane/test/server-boundary.test.mjs
```

Expected: PASS. If `control-plane/test/server-boundary.test.mjs` fails due unrelated dirty local changes already present in the worktree, capture the exact failure and do not change unrelated files.

- [ ] **Step 4: Inspect diff for scope**

Run:

```bash
git diff --stat
git diff -- control-plane/src/static-site-preview.mjs control-plane/src/site-routes.mjs control-plane/src/tool-broker.mjs control-plane/src/tool-manifest.mjs control-plane/src/gatekeeper/index.mjs control-plane/src/gatekeeper/evidence.mjs
```

Expected: diff only covers managed static-site update behavior, manifest/broker/gatekeeper wiring, route support, tests, and docs.

- [ ] **Step 5: Commit verification-only fixes if needed**

If Task 7 revealed a missing import, syntax issue, or test cleanup mistake, fix only that exact issue and commit:

```bash
git add control-plane/src/static-site-preview.mjs control-plane/src/site-routes.mjs control-plane/src/tool-broker.mjs control-plane/src/tool-manifest.mjs control-plane/src/gatekeeper/index.mjs control-plane/src/gatekeeper/evidence.mjs control-plane/test/static-site-preview.test.mjs control-plane/test/site-routes.test.mjs control-plane/test/tool-broker.test.mjs control-plane/test/gatekeeper.test.mjs control-plane/README.md
git commit -m "fix: harden static preview update path"
```

If no fixes are needed, do not create a verification-only commit.

---

## Task 8: Manual End-to-End Proof

**Files:**
- No code files should be edited in this task.

- [ ] **Step 1: Start or confirm local control plane**

Run:

```bash
./scripts/beep-control-plane.sh start
```

Expected: output includes:

```text
beep-control-plane started
```

or:

```text
beep-control-plane already running
```

- [ ] **Step 2: Prepare a runtime workspace static site**

Run:

```bash
mkdir -p .beep-dev/workspace/api-sessions/agent_beep/manual-site
printf '<h1>before</h1>\n' > .beep-dev/workspace/api-sessions/agent_beep/manual-site/index.html
```

Expected: `index.html` exists under `.beep-dev/workspace/api-sessions/agent_beep/manual-site`.

- [ ] **Step 3: Create a static site in the shared control-plane state**

Run this one-off script from the repo root. It calls the same `createStaticSitePreview` worker used by approved broker execution and writes the site record into the same `StateStore` used by the running control plane:

```bash
node --input-type=module <<'EOF'
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR, RUNTIME_ID } from "./control-plane/src/config.mjs";
import { StateStore } from "./control-plane/src/state-store.mjs";
import { createStaticSitePreview } from "./control-plane/src/static-site-preview.mjs";

const sourcePath = "/workspace/api-sessions/agent_beep/manual-site";
const hostPath = join(ROOT_DIR, ".beep-dev/workspace/api-sessions/agent_beep/manual-site");
mkdirSync(hostPath, { recursive: true });
writeFileSync(join(hostPath, "index.html"), "<h1>before</h1>\n");

const store = new StateStore();
store.ensure();
const site = await createStaticSitePreview({
  runtimeId: RUNTIME_ID,
  approvalId: "manual_e2e",
  args: { sourcePath, siteName: "manual-site" },
  store,
});

console.log(JSON.stringify({
  siteId: site.siteId,
  proxyUrl: site.proxyUrl,
  directUrl: site.directUrl,
  revision: site.revision,
}, null, 2));
EOF
```

Expected: JSON includes a `siteId`, `revision: 1`, and `proxyUrl` like:

```text
http://127.0.0.1:8788/sites/<siteId>/
```

- [ ] **Step 4: Confirm initial content**

Run:

```bash
curl -sS http://127.0.0.1:8788/sites/<siteId>/
```

Expected:

```html
<h1>before</h1>
```

- [ ] **Step 5: Update source files and call update route**

Run:

```bash
printf '<h1>after</h1>\n' > .beep-dev/workspace/api-sessions/agent_beep/manual-site/index.html
TOKEN="$(./scripts/beep-control-plane.sh operator-token)"
curl -sS -X POST "http://127.0.0.1:8788/api/sites/<siteId>/update" \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"sourcePath":"/workspace/api-sessions/agent_beep/manual-site"}'
```

Expected JSON includes:

```json
{
  "ok": true,
  "site": {
    "siteId": "<same siteId>",
    "revision": 2,
    "proxyUrl": "http://127.0.0.1:8788/sites/<same siteId>/"
  }
}
```

- [ ] **Step 6: Confirm stable URL serves updated content**

Run:

```bash
curl -sS http://127.0.0.1:8788/sites/<siteId>/
```

Expected:

```html
<h1>after</h1>
```

- [ ] **Step 7: Record manual proof in final response**

Record:

```text
siteId=<siteId>
initialContent=<h1>before</h1>
updatedContent=<h1>after</h1>
proxyUrlStable=true
```

Do not commit manual workspace files under `.beep-dev/`.

---

## Self-Review

Spec coverage:

- Same `/sites/<siteId>/` URL: Task 1 success test, Task 8 manual proof.
- Fresh validated snapshot: Task 1 worker, Task 2 validation tests.
- Replacement container with old cleanup: Task 1 worker and test.
- Failure behavior: Task 2 validation/start failure tests and cleanup assertions.
- Restricted tool path: Task 3 broker, Task 4 gatekeeper, Task 6 manifest test.
- Operator endpoint: Task 5 route tests and implementation.
- Security boundary: Task 4 deterministic review, Task 6 docs, Task 7 regression tests.
- Manual verification: Task 8.

Placeholder scan:

- Red-flag scan passed for unfinished-plan language and undefined helper references. Helpers introduced in tests are defined before use.

Type consistency:

- Tool name: `preview_container_update_static_site`.
- Action: `preview.container.updateStaticSite`.
- Worker: `updateStaticSitePreview`.
- Route: `POST /api/sites/<siteId>/update`.
- Stable URL field: `proxyUrl`.
- Current direct URL field: `directUrl`.
