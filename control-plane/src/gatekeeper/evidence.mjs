import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GATEKEEPER_MAX_STATIC_SITE_BYTES,
  GATEKEEPER_MAX_STATIC_SITE_FILES,
  ROOT_DIR,
} from "../config.mjs";

const SECRET_NAME_PATTERNS = [
  /^\.env(?:[.\-].*)?$/iu,
  /^\.npmrc$/iu,
  /^\.pypirc$/iu,
  /^id_rsa$/iu,
  /^id_ed25519$/iu,
  /^.*(?:secret|token|credential|private[-_]?key).*$/iu,
];

export function fileNameLooksSuspicious(name) {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function runtimeWorkspacePathToHostPath(sourcePath) {
  if (typeof sourcePath !== "string" || (sourcePath !== "/workspace" && !sourcePath.startsWith("/workspace/"))) {
    return {
      ok: false,
      error: "sourcePath must be an absolute path inside /workspace.",
    };
  }
  if (sourcePath.includes("\0")) {
    return {
      ok: false,
      error: "sourcePath contains an invalid NUL byte.",
    };
  }

  const workspaceRoot = resolve(ROOT_DIR, ".beep-dev/workspace");
  const relativeSource = sourcePath === "/workspace" ? "" : sourcePath.slice("/workspace/".length);
  const hostPath = resolve(workspaceRoot, relativeSource);
  const relativeHostPath = relative(workspaceRoot, hostPath);
  const pathWithinWorkspace =
    hostPath === workspaceRoot ||
    (relativeHostPath !== ".." && !relativeHostPath.startsWith(`..${sep}`) && !isAbsolute(relativeHostPath));
  if (!pathWithinWorkspace) {
    return {
      ok: false,
      error: "sourcePath must remain inside the runtime workspace.",
    };
  }
  return { ok: true, workspaceRoot, hostPath };
}

function walkDirectory(root, { maxFiles, maxBytes }) {
  const stack = [root];
  const suspiciousFiles = [];
  const symlinks = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let truncated = false;

  while (stack.length) {
    const dir = stack.pop();
    dirCount += 1;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return {
        ok: false,
        error: `Could not read directory during evidence collection: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(root, fullPath);
      if (fileNameLooksSuspicious(entry.name)) {
        suspiciousFiles.push(relativePath);
      }

      if (entry.isSymbolicLink()) {
        symlinks.push(relativePath);
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      fileCount += 1;
      if (fileCount > maxFiles) {
        truncated = true;
        return {
          ok: true,
          fileCount,
          dirCount,
          totalBytes,
          suspiciousFiles,
          symlinks,
          truncated,
          limitExceeded: "files",
        };
      }
      try {
        totalBytes += statSync(fullPath).size;
      } catch {
        fileCount -= 1;
      }
      if (totalBytes > maxBytes) {
        truncated = true;
        return {
          ok: true,
          fileCount,
          dirCount,
          totalBytes,
          suspiciousFiles,
          symlinks,
          truncated,
          limitExceeded: "bytes",
        };
      }
    }
  }

  return {
    ok: true,
    fileCount,
    dirCount,
    totalBytes,
    suspiciousFiles,
    symlinks,
    truncated,
    limitExceeded: null,
  };
}

export function collectStaticSiteEvidence(args = {}) {
  const pathResult = runtimeWorkspacePathToHostPath(args.sourcePath);
  if (!pathResult.ok) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      error: pathResult.error,
    };
  }

  const { hostPath, workspaceRoot } = pathResult;
  if (!existsSync(hostPath)) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      hostPath,
      workspaceRoot,
      error: "sourcePath does not resolve to an existing workspace path.",
    };
  }

  let stats;
  let lstats;
  try {
    lstats = lstatSync(hostPath);
    stats = statSync(hostPath);
  } catch (error) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      hostPath,
      workspaceRoot,
      error: `Could not stat sourcePath: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (lstats.isSymbolicLink()) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      hostPath,
      workspaceRoot,
      error: "sourcePath must not be a symlink.",
    };
  }

  if (!stats.isDirectory()) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      hostPath,
      workspaceRoot,
      error: "sourcePath does not resolve to a directory.",
    };
  }

  const indexPath = join(hostPath, "index.html");
  const hasIndexHtml = existsSync(indexPath) && !lstatSync(indexPath).isSymbolicLink() && statSync(indexPath).isFile();
  const walk = walkDirectory(hostPath, {
    maxFiles: GATEKEEPER_MAX_STATIC_SITE_FILES,
    maxBytes: GATEKEEPER_MAX_STATIC_SITE_BYTES,
  });
  return {
    kind: "static_site",
    ok: walk.ok,
    sourcePath: args.sourcePath,
    hostPath,
    workspaceRoot,
    siteName: typeof args.siteName === "string" ? args.siteName : null,
    hasIndexHtml,
    maxFiles: GATEKEEPER_MAX_STATIC_SITE_FILES,
    maxBytes: GATEKEEPER_MAX_STATIC_SITE_BYTES,
    ...walk,
  };
}

export function staticSiteExecutionRejectionReason(evidence) {
  if (!evidence?.ok) return evidence?.error || "static preview source evidence is invalid.";
  if (!evidence.hasIndexHtml) return "source directory does not contain a root index.html.";
  if (evidence.limitExceeded === "files" || evidence.limitExceeded === "bytes") {
    return `source directory exceeds configured ${evidence.limitExceeded} limit.`;
  }
  if (Array.isArray(evidence.suspiciousFiles) && evidence.suspiciousFiles.length > 0) {
    return `source directory contains suspicious secret-like files: ${evidence.suspiciousFiles.join(", ")}.`;
  }
  if (Array.isArray(evidence.symlinks) && evidence.symlinks.length > 0) {
    return `source directory contains symlinks: ${evidence.symlinks.join(", ")}.`;
  }
  return null;
}

export function collectEvidenceForAction(action, args = {}) {
  if (action === "preview.container.createStaticSite") {
    return collectStaticSiteEvidence(args);
  }
  return {
    kind: "unsupported",
    ok: true,
    action,
    note: "No deterministic evidence collector is registered for this action.",
  };
}
