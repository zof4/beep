import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  PUBLIC_BASE_URL,
  ROOT_DIR,
  RUNTIME_ID,
  STATIC_SITE_IMAGE,
} from "./config.mjs";
import { ToolBrokerError } from "./tool-broker-error.mjs";

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

function runtimeWorkspacePathToHostPath(sourcePath) {
  if (typeof sourcePath !== "string" || (sourcePath !== "/workspace" && !sourcePath.startsWith("/workspace/"))) {
    throw new ToolBrokerError("sourcePath must be an absolute path inside /workspace.", 400);
  }
  if (sourcePath.includes("\0")) {
    throw new ToolBrokerError("sourcePath contains an invalid NUL byte.", 400);
  }
  const workspaceRoot = resolve(ROOT_DIR, ".beep-dev/workspace");
  const relativeSource = sourcePath === "/workspace" ? "" : sourcePath.slice("/workspace/".length);
  const hostPath = resolve(workspaceRoot, relativeSource);
  const relativeHostPath = relative(workspaceRoot, hostPath);
  const pathWithinWorkspace =
    hostPath === workspaceRoot ||
    (relativeHostPath !== ".." && !relativeHostPath.startsWith(`..${sep}`) && !isAbsolute(relativeHostPath));
  if (!pathWithinWorkspace) {
    throw new ToolBrokerError("sourcePath must remain inside the runtime workspace.", 400);
  }
  if (!existsSync(hostPath) || !statSync(hostPath).isDirectory()) {
    throw new ToolBrokerError(`sourcePath does not resolve to an existing workspace directory: ${sourcePath}`, 400);
  }
  return hostPath;
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
  const hostPath = runtimeWorkspacePathToHostPath(args.sourcePath);
  const siteSlug = slugify(args.siteName);
  const siteId = `${siteSlug}-${randomBytes(4).toString("hex")}`;
  const containerName = `beep-preview-${siteId}`;

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
    `beep.approval_id=${approvalId}`,
    "--read-only",
    "--tmpfs",
    "/tmp:size=64m,mode=1777",
    "-p",
    "127.0.0.1::8080",
    "-v",
    `${hostPath}:/site:ro`,
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
  const hostPort = Number(portMatch[1]);
  const site = {
    siteId,
    runtimeId,
    approvalId,
    siteName: siteSlug,
    status: "running",
    sourcePath: args.sourcePath,
    containerName,
    containerId,
    image: STATIC_SITE_IMAGE,
    hostPort,
    proxyUrl: `${PUBLIC_BASE_URL}/sites/${siteId}/`,
    directUrl: `http://127.0.0.1:${hostPort}/`,
  };
  store.upsertSite(site);
  return site;
}

export async function removeStaticSitePreview({ site, store }) {
  if (!site?.siteId || !site?.containerName) {
    throw new ToolBrokerError("Site record is missing a managed container name.", 400);
  }
  if (site.status === "stopped") {
    return site;
  }
  await run("docker", ["rm", "-f", site.containerName]);
  const stopped = {
    ...site,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
  };
  store.upsertSite(stopped);
  store.appendAudit({
    kind: "site_stopped",
    siteId: site.siteId,
    runtimeId: site.runtimeId,
    containerName: site.containerName,
  });
  return stopped;
}
