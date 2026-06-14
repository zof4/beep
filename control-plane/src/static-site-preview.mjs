import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GATEKEEPER_MAX_STATIC_SITE_BYTES,
  GATEKEEPER_MAX_STATIC_SITE_FILES,
  PUBLIC_BASE_URL,
  ROOT_DIR,
  RUNTIME_ID,
  STATE_DIR,
  STATIC_SITE_IMAGE,
} from "./config.mjs";
import {
  collectStaticSiteEvidence,
  fileNameLooksSuspicious,
  GATEKEEPER_MAX_STATIC_SITE_DEPTH,
  GATEKEEPER_MAX_STATIC_SITE_DIRS,
  staticSiteExecutionRejectionReason,
} from "./gatekeeper/evidence.mjs";
import { ToolBrokerError } from "./tool-broker-error.mjs";

const STATIC_SITE_SNAPSHOT_ROOT = join(STATE_DIR, "static-site-snapshots");
const staticSiteLocks = new Map();

function slugify(input) {
  const slug = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return slug || "site";
}

function run(command, args, { cwd = ROOT_DIR } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const error = new ToolBrokerError(
          `${command} ${args.join(" ")} failed with exit code ${code}: ${stderr || stdout}`.trim(),
          500,
        );
        reject(error);
      }
    });
  });
}

function pathIsInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return (
    resolvedCandidate === resolvedRoot ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function validateStaticSiteSourceForExecution(args) {
  const evidence = collectStaticSiteEvidence(args);
  const rejectionReason = staticSiteExecutionRejectionReason(evidence);
  if (rejectionReason) {
    throw new ToolBrokerError(`Static preview source failed execution validation: ${rejectionReason}`, 400);
  }
  return evidence;
}

function snapshotError(message) {
  return new ToolBrokerError(`Static preview source failed snapshot validation: ${message}`, 400);
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function directoryOpenFlags() {
  return constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);
}

function verifyDirectoryIdentity(sourceDir, relativePath) {
  const lstats = lstatSync(sourceDir);
  if (lstats.isSymbolicLink()) {
    throw snapshotError(`${relativePath} is a symlink.`);
  }
  if (!lstats.isDirectory()) {
    throw snapshotError(`${relativePath} is not a directory.`);
  }
  let fd = null;
  try {
    fd = openSync(sourceDir, directoryOpenFlags());
    const openedStats = fstatSync(fd);
    if (!sameFileIdentity(lstats, openedStats)) {
      throw snapshotError(`${relativePath} changed while validating directory identity.`);
    }
    return { dev: openedStats.dev, ino: openedStats.ino };
  } catch (error) {
    if (error instanceof ToolBrokerError) throw error;
    throw snapshotError(
      `${relativePath} could not be opened safely as a directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readRegularFileNoFollow(sourcePath, relativePath, verifyParent, remainingBytes) {
  let fd = null;
  try {
    verifyParent();
    const expectedStats = lstatSync(sourcePath);
    if (expectedStats.isSymbolicLink()) {
      throw snapshotError(`${relativePath} is a symlink.`);
    }
    if (!expectedStats.isFile()) {
      throw snapshotError(`${relativePath} is not a regular file.`);
    }
    verifyParent();
    fd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    if (!stats.isFile() || !sameFileIdentity(expectedStats, stats)) {
      throw snapshotError(`${relativePath} changed while opening file.`);
    }
    if (stats.size > remainingBytes) {
      throw snapshotError(`total bytes exceed configured limit while reading ${relativePath}.`);
    }
    verifyParent();
    const chunks = [];
    let total = 0;
    for (;;) {
      const remaining = remainingBytes - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, remaining + 1)));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > remainingBytes) {
        throw snapshotError(`total bytes exceed configured limit while reading ${relativePath}.`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    verifyParent();
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof ToolBrokerError) throw error;
    throw snapshotError(
      `${relativePath} could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function createStaticSiteSnapshot({
  sourceHostPath,
  siteId,
  snapshotRoot = STATIC_SITE_SNAPSHOT_ROOT,
  trustedRoot = sourceHostPath,
  maxFiles = GATEKEEPER_MAX_STATIC_SITE_FILES,
  maxBytes = GATEKEEPER_MAX_STATIC_SITE_BYTES,
  maxDirs = GATEKEEPER_MAX_STATIC_SITE_DIRS,
  maxDepth = GATEKEEPER_MAX_STATIC_SITE_DEPTH,
}) {
  if (!siteId || typeof siteId !== "string") {
    throw new ToolBrokerError("Static preview snapshot requires a siteId.", 400);
  }

  const resolvedSnapshotRoot = resolve(snapshotRoot);
  const snapshotPath = resolve(resolvedSnapshotRoot, siteId);
  if (snapshotPath === resolvedSnapshotRoot || !pathIsInside(resolvedSnapshotRoot, snapshotPath)) {
    throw new ToolBrokerError("Static preview snapshot path must remain inside the managed snapshot root.", 400);
  }
  if (typeof sourceHostPath !== "string") {
    throw new ToolBrokerError("Static preview snapshot source must be an existing directory.", 400);
  }
  const resolvedSourceHostPath = resolve(sourceHostPath);
  if (snapshotPath === resolvedSourceHostPath || pathIsInside(resolvedSourceHostPath, snapshotPath)) {
    throw new ToolBrokerError("Static preview snapshot root must not be inside the source tree.", 400);
  }
  const resolvedTrustedRoot = resolve(trustedRoot);
  if (!pathIsInside(resolvedTrustedRoot, resolvedSourceHostPath)) {
    throw new ToolBrokerError("Static preview snapshot source must remain inside its trusted workspace root.", 400);
  }
  if (existsSync(snapshotPath)) {
    throw new ToolBrokerError(`Static preview snapshot already exists for ${siteId}.`, 409);
  }

  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  const directoryIdentities = new Map();
  const guardedDirectories = new Set();

  const recordDirectoryIdentity = (sourceDir, relativeDir) => {
    const identity = verifyDirectoryIdentity(sourceDir, relativeDir);
    directoryIdentities.set(sourceDir, identity);
    guardedDirectories.add(sourceDir);
    return identity;
  };

  const assertDirectoryUnchanged = (sourceDir, relativeDir) => {
    const expected = directoryIdentities.get(sourceDir) || recordDirectoryIdentity(sourceDir, relativeDir);
    const current = verifyDirectoryIdentity(sourceDir, relativeDir);
    if (!sameFileIdentity(expected, current)) {
      throw snapshotError(`${relativeDir} changed while creating the snapshot.`);
    }
  };

  const guardLabel = (sourceDir) => {
    if (sourceDir === resolvedSourceHostPath) return ".";
    const relativeToTrustedRoot = relative(resolvedTrustedRoot, sourceDir) || ".";
    return relativeToTrustedRoot;
  };

  const recordTrustedPathComponents = () => {
    recordDirectoryIdentity(resolvedTrustedRoot, guardLabel(resolvedTrustedRoot));
    const relativeSource = relative(resolvedTrustedRoot, resolvedSourceHostPath);
    if (!relativeSource) return;
    let current = resolvedTrustedRoot;
    for (const part of relativeSource.split(sep).filter(Boolean)) {
      current = join(current, part);
      recordDirectoryIdentity(current, guardLabel(current));
    }
  };

  const assertGuardedAncestorsUnchanged = (candidatePath) => {
    const resolvedCandidate = resolve(candidatePath);
    for (const sourceDir of guardedDirectories) {
      if (resolvedCandidate === sourceDir || pathIsInside(sourceDir, resolvedCandidate)) {
        assertDirectoryUnchanged(sourceDir, guardLabel(sourceDir));
      }
    }
  };

  const copyDirectory = (sourceDir, targetDir, depth = 0) => {
    if (depth > maxDepth) {
      throw snapshotError(`directory depth exceeds configured limit of ${maxDepth}.`);
    }
    const relativeDir = relative(resolvedSourceHostPath, sourceDir) || ".";
    assertGuardedAncestorsUnchanged(sourceDir);
    recordDirectoryIdentity(sourceDir, relativeDir);

    dirCount += 1;
    if (dirCount > maxDirs) {
      throw snapshotError(`directory count exceeds configured limit of ${maxDirs}.`);
    }
    mkdirSync(targetDir, { recursive: true, mode: 0o755 });

    assertGuardedAncestorsUnchanged(sourceDir);
    assertDirectoryUnchanged(sourceDir, relativeDir);
    const entries = readdirSync(sourceDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    assertDirectoryUnchanged(sourceDir, relativeDir);
    assertGuardedAncestorsUnchanged(sourceDir);

    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      const relativePath = relative(resolvedSourceHostPath, sourcePath);
      if (fileNameLooksSuspicious(entry.name)) {
        throw snapshotError(`${relativePath} looks like a secret or credential file.`);
      }

      assertGuardedAncestorsUnchanged(sourcePath);
      assertDirectoryUnchanged(sourceDir, relativeDir);
      const entryStats = lstatSync(sourcePath);
      assertDirectoryUnchanged(sourceDir, relativeDir);
      assertGuardedAncestorsUnchanged(sourcePath);
      if (entryStats.isSymbolicLink()) {
        throw snapshotError(`${relativePath} is a symlink.`);
      }
      if (entryStats.isDirectory()) {
        if (depth + 1 > maxDepth) {
          throw snapshotError(`directory depth exceeds configured limit of ${maxDepth}.`);
        }
        copyDirectory(sourcePath, targetPath, depth + 1);
        continue;
      }
      if (!entryStats.isFile()) {
        throw snapshotError(`${relativePath} is not a regular file.`);
      }

      fileCount += 1;
      if (fileCount > maxFiles) {
        throw snapshotError(`file count exceeds configured limit of ${maxFiles}.`);
      }
      const data = readRegularFileNoFollow(sourcePath, relativePath, () =>
        assertGuardedAncestorsUnchanged(sourcePath),
        maxBytes - totalBytes,
      );
      totalBytes += data.length;
      if (totalBytes > maxBytes) {
        throw snapshotError(`total bytes exceed configured limit of ${maxBytes}.`);
      }
      writeFileSync(targetPath, data, { mode: 0o444 });
    }
  };

  recordTrustedPathComponents();
  mkdirSync(resolvedSnapshotRoot, { recursive: true, mode: 0o700 });
  mkdirSync(snapshotPath, { mode: 0o755 });
  try {
    copyDirectory(resolvedSourceHostPath, snapshotPath);
    const snapshotIndexPath = join(snapshotPath, "index.html");
    if (!existsSync(snapshotIndexPath) || !statSync(snapshotIndexPath).isFile()) {
      throw snapshotError("snapshot does not contain a root index.html.");
    }
    return {
      snapshotPath,
      fileCount,
      dirCount,
      totalBytes,
    };
  } catch (error) {
    rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

function removeStaticSiteSnapshot(snapshotPath, snapshotRoot = STATIC_SITE_SNAPSHOT_ROOT) {
  if (!snapshotPath) return;
  const resolvedSnapshotRoot = resolve(snapshotRoot);
  const resolvedSnapshotPath = resolve(snapshotPath);
  if (resolvedSnapshotPath === resolvedSnapshotRoot || !pathIsInside(resolvedSnapshotRoot, resolvedSnapshotPath)) {
    throw new ToolBrokerError("Refusing to remove unmanaged static preview snapshot path.", 500);
  }
  rmSync(resolvedSnapshotPath, { recursive: true, force: true });
}

function isMissingDockerContainerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /No such (?:container|object)/iu.test(message);
}

function nowIso() {
  return new Date().toISOString();
}

function nextSiteRevision(site) {
  const currentRevision = Number.isInteger(site?.revision) && site.revision > 0 ? site.revision : 1;
  return currentRevision + 1;
}

async function withStaticSiteLock(siteId, callback) {
  const previous = staticSiteLocks.get(siteId) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const current = previous.catch(() => null).then(() => gate);
  staticSiteLocks.set(siteId, current);
  await previous.catch(() => null);
  try {
    return await callback();
  } finally {
    release();
    if (staticSiteLocks.get(siteId) === current) {
      staticSiteLocks.delete(siteId);
    }
  }
}

function currentStaticSiteRecord(store, siteId) {
  if (typeof store?.getSite !== "function") return null;
  return store.getSite(siteId);
}

function siteStateMatchesSite(current, site) {
  return (
    current?.siteId === site.siteId &&
    current.runtimeId === site.runtimeId &&
    current.status === site.status &&
    current.containerName === site.containerName &&
    (current.containerId || null) === (site.containerId || null) &&
    (current.revision || null) === (site.revision || null)
  );
}

function assertStaticSiteStateCurrent({ store, site }) {
  if (typeof store?.getSite !== "function") return;
  const current = currentStaticSiteRecord(store, site.siteId);
  if (siteStateMatchesSite(current, site)) return;
  throw new ToolBrokerError(`Static preview site state changed before update could be committed: ${site.siteId}`, 409);
}

function staticPreviewContainerName({ siteId, revision }) {
  return `beep-preview-${siteId}-r${revision}-${randomBytes(3).toString("hex")}`;
}

function snapshotIdForUpdate({ siteId, revision }) {
  return `${siteId}-r${revision}-${randomBytes(4).toString("hex")}`;
}

async function startStaticSiteContainer({
  runtimeId,
  siteId,
  approvalId,
  revision,
  snapshotPath,
  containerName,
  onContainerStarted = null,
}) {
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
  if (onContainerStarted) {
    onContainerStarted({ containerId, containerName });
  }
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
  if (site.snapshotPath && site.containerName && cleanup.oldContainerRemoval === "failed") {
    cleanup.oldSnapshotRemoval = "skipped";
    cleanup.oldSnapshotError = "Old container removal failed; snapshot retained because the old container may still be live.";
  } else if (site.snapshotPath) {
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

function staticServerScript() {
  return `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = "/site";
const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);
http.createServer((req, res) => {
  let decoded = "/";
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    decoded = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }
  const requested = path.normalize(decoded);
  let filePath = path.join(root, requested);
  const relativeFilePath = path.relative(root, filePath);
  if (relativeFilePath === ".." || relativeFilePath.startsWith(".." + path.sep) || path.isAbsolute(relativeFilePath)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": mime.get(path.extname(filePath).toLowerCase()) || "application/octet-stream" });
    res.end(data);
  });
}).listen(8080, "0.0.0.0");
`;
}

export async function createStaticSitePreview({ runtimeId, args, approvalId, store }) {
  if (runtimeId !== RUNTIME_ID) {
    throw new ToolBrokerError(`Unknown runtimeId: ${runtimeId}`, 404);
  }
  const evidence = validateStaticSiteSourceForExecution(args);
  const siteSlug = slugify(args.siteName);
  const siteId = `${siteSlug}-${randomBytes(4).toString("hex")}`;
  const containerName = `beep-preview-${siteId}`;
  const snapshot = createStaticSiteSnapshot({
    sourceHostPath: evidence.hostPath,
    siteId,
    trustedRoot: evidence.workspaceRoot,
  });

  let containerStarted = false;
  try {
    const started = await startStaticSiteContainer({
      runtimeId,
      siteId,
      approvalId,
      revision: 1,
      snapshotPath: snapshot.snapshotPath,
      containerName,
      onContainerStarted: () => {
        containerStarted = true;
      },
    });
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
    store.upsertSite(site);
    return site;
  } catch (error) {
    if (containerStarted) {
      await run("docker", ["rm", "-f", containerName]).catch(() => null);
    }
    removeStaticSiteSnapshot(snapshot.snapshotPath);
    throw error;
  }
}

export async function updateStaticSitePreview({
  runtimeId,
  site,
  args,
  approvalId = null,
  store,
  sourceHostPath = null,
  trustedRoot = null,
}) {
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

  return withStaticSiteLock(site.siteId, async () => {
    const evidence =
      sourceHostPath && trustedRoot
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
    const updateApprovalId = approvalId || "operator";

    let replacementStarted = false;
    let committed = false;
    try {
      const started = await startStaticSiteContainer({
        runtimeId,
        siteId: site.siteId,
        approvalId: updateApprovalId,
        revision,
        snapshotPath: snapshot.snapshotPath,
        containerName,
        onContainerStarted: () => {
          replacementStarted = true;
        },
      });
      assertStaticSiteStateCurrent({ store, site });
      const updatedAt = nowIso();
      const updateSourcePath = args.sourcePath || site.sourcePath;
      const updated = {
        ...site,
        runtimeId,
        siteId: site.siteId,
        status: "running",
        sourcePath: updateSourcePath,
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
          sourcePath: updateSourcePath,
          snapshotFileCount: snapshot.fileCount,
          snapshotTotalBytes: snapshot.totalBytes,
          approvalId: updateApprovalId,
          updatedAt,
        },
      };

      store.upsertSite(updated);
      committed = true;
      const cleanup = await cleanupOldStaticSiteAssets(site);
      const finalUpdated = {
        ...updated,
        cleanup,
      };
      store.upsertSite(finalUpdated, {
        kind: "site_updated",
        siteId: site.siteId,
        runtimeId,
        approvalId: updateApprovalId,
        previousContainerName: site.containerName || null,
        containerName,
        revision,
        cleanup,
      });
      return {
        ...finalUpdated,
      };
    } catch (error) {
      if (!committed) {
        if (replacementStarted) {
          await run("docker", ["rm", "-f", containerName]).catch(() => null);
        }
        removeStaticSiteSnapshot(snapshot.snapshotPath);
      }
      throw error;
    }
  });
}

export async function removeStaticSitePreview({ site, store }) {
  if (!site?.siteId) {
    throw new ToolBrokerError("Site record is missing a managed site id.", 400);
  }
  return withStaticSiteLock(site.siteId, async () => {
    const current = currentStaticSiteRecord(store, site.siteId);
    const target = current || site;
    if (!target?.containerName) {
      throw new ToolBrokerError("Site record is missing a managed container name.", 400);
    }
    if (target.status === "stopped") {
      return target;
    }
    const removed = await removeStaticSiteContainer(target.containerName);
    const stopped = {
      ...target,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
    };
    store.upsertSite(stopped, {
      kind: "site_stopped",
      siteId: target.siteId,
      runtimeId: target.runtimeId,
      containerName: target.containerName,
      dockerRemoval: removed.removal,
      dockerError: removed.error,
    });
    removeStaticSiteSnapshot(target.snapshotPath);
    return stopped;
  });
}
