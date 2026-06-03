import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  GATEKEEPER_MAX_STATIC_SITE_BYTES,
  GATEKEEPER_MAX_STATIC_SITE_FILES,
  ROOT_DIR,
} from "../config.mjs";

export const GATEKEEPER_MAX_STATIC_SITE_DIRS = 100;
export const GATEKEEPER_MAX_STATIC_SITE_DEPTH = 20;

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

function pathIsInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);
  return (
    resolvedCandidate === resolvedRoot ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function intLimit(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function directoryOpenFlags() {
  return constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);
}

function directoryIdentity(dir, label) {
  let lstats;
  try {
    lstats = lstatSync(dir);
  } catch (error) {
    return {
      ok: false,
      reason: "stat",
      error: `Could not validate directory ${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (lstats.isSymbolicLink()) {
    return {
      ok: false,
      reason: "symlink",
      error: `${label} must not be a symlink.`,
    };
  }
  if (!lstats.isDirectory()) {
    return {
      ok: false,
      reason: "not_directory",
      error: `${label} is not a directory.`,
    };
  }

  let fd = null;
  try {
    fd = openSync(dir, directoryOpenFlags());
    const openedStats = fstatSync(fd);
    if (!sameFileIdentity(lstats, openedStats)) {
      return {
        ok: false,
        reason: "changed",
        error: `${label} changed while validating directory identity.`,
      };
    }
    return {
      ok: true,
      identity: { dev: openedStats.dev, ino: openedStats.ino },
    };
  } catch (error) {
    return {
      ok: false,
      reason: "open",
      error: `Could not open directory ${label} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
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
  if (!pathIsInside(workspaceRoot, hostPath)) {
    return {
      ok: false,
      error: "sourcePath must remain inside the runtime workspace.",
    };
  }
  return { ok: true, workspaceRoot, hostPath };
}

function validateTrustedDirectoryPath(workspaceRoot, hostPath) {
  let current = workspaceRoot;
  const relativeHostPath = relative(workspaceRoot, hostPath);
  const parts = relativeHostPath ? relativeHostPath.split(sep).filter(Boolean) : [];
  const guardedDirectories = [];

  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const label = relative(workspaceRoot, current) || ".";
    const result = directoryIdentity(current, label);
    if (!result.ok) {
      if (result.reason === "symlink") {
        return {
          ok: false,
          error: `sourcePath component ${label} must not be a symlink.`,
        };
      }
      if (result.reason === "not_directory") {
        return {
          ok: false,
          error: part === parts.at(-1) ? "sourcePath does not resolve to a directory." : `${label} is not a directory.`,
        };
      }
      return {
        ok: false,
        error:
          part === parts.at(-1)
            ? "sourcePath does not resolve to an existing workspace path."
            : `Could not validate sourcePath component ${label}: ${result.error}`,
      };
    }
    guardedDirectories.push({
      path: current,
      label,
      identity: result.identity,
    });
  }

  return { ok: true, guardedDirectories };
}

function guardedPathError(guardedDirectories, candidatePath) {
  const resolvedCandidate = resolve(candidatePath);
  for (const guarded of guardedDirectories) {
    if (resolvedCandidate !== guarded.path && !pathIsInside(guarded.path, resolvedCandidate)) {
      continue;
    }
    const current = directoryIdentity(guarded.path, guarded.label);
    if (!current.ok) return current.error;
    if (!sameFileIdentity(guarded.identity, current.identity)) {
      return `${guarded.label} changed during evidence collection.`;
    }
  }
  return null;
}

function indexHtmlExists(hostPath, guardedDirectories) {
  const guardBefore = guardedPathError(guardedDirectories, hostPath);
  if (guardBefore) return { ok: false, error: guardBefore };
  const directoryBefore = directoryIdentity(hostPath, relative(guardedDirectories[0]?.path || hostPath, hostPath) || ".");
  if (!directoryBefore.ok) return directoryBefore;

  let hasIndexHtml = false;
  try {
    hasIndexHtml = lstatSync(join(hostPath, "index.html")).isFile();
  } catch {
    hasIndexHtml = false;
  }

  const guardAfter = guardedPathError(guardedDirectories, hostPath);
  if (guardAfter) return { ok: false, error: guardAfter };
  const directoryAfter = directoryIdentity(hostPath, relative(guardedDirectories[0]?.path || hostPath, hostPath) || ".");
  if (!directoryAfter.ok) return directoryAfter;
  if (!sameFileIdentity(directoryBefore.identity, directoryAfter.identity)) {
    return { ok: false, error: "sourcePath changed while checking index.html." };
  }

  return { ok: true, hasIndexHtml };
}

function walkDirectory(root, { maxFiles, maxBytes, maxDirs, maxDepth, guardedDirectories }) {
  const stack = [{ dir: root, depth: 0 }];
  const suspiciousFiles = [];
  const symlinks = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let truncated = false;

  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) {
      truncated = true;
      return {
        ok: true,
        fileCount,
        dirCount,
        totalBytes,
        suspiciousFiles,
        symlinks,
        truncated,
        limitExceeded: "depth",
      };
    }
    dirCount += 1;
    if (dirCount > maxDirs) {
      truncated = true;
      return {
        ok: true,
        fileCount,
        dirCount,
        totalBytes,
        suspiciousFiles,
        symlinks,
        truncated,
        limitExceeded: "dirs",
      };
    }

    const dirLabel = relative(root, dir) || ".";
    const guardBefore = guardedPathError(guardedDirectories, dir);
    if (guardBefore) {
      return {
        ok: false,
        error: guardBefore,
      };
    }
    const directoryBefore = directoryIdentity(dir, dirLabel);
    if (!directoryBefore.ok) {
      return {
        ok: false,
        error: directoryBefore.error,
      };
    }

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return {
        ok: false,
        error: `Could not read directory during evidence collection: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const guardAfterRead = guardedPathError(guardedDirectories, dir);
    if (guardAfterRead) {
      return {
        ok: false,
        error: guardAfterRead,
      };
    }
    const directoryAfterRead = directoryIdentity(dir, dirLabel);
    if (!directoryAfterRead.ok) {
      return {
        ok: false,
        error: directoryAfterRead.error,
      };
    }
    if (!sameFileIdentity(directoryBefore.identity, directoryAfterRead.identity)) {
      return {
        ok: false,
        error: `${dirLabel} changed during evidence collection.`,
      };
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(root, fullPath);
      if (fileNameLooksSuspicious(entry.name)) {
        suspiciousFiles.push(relativePath);
      }

      const guardBeforeEntry = guardedPathError(guardedDirectories, fullPath);
      if (guardBeforeEntry) {
        return {
          ok: false,
          error: guardBeforeEntry,
        };
      }
      let entryStats;
      try {
        entryStats = lstatSync(fullPath);
      } catch (error) {
        return {
          ok: false,
          error: `Could not validate path during evidence collection: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      const guardAfterEntry = guardedPathError(guardedDirectories, fullPath);
      if (guardAfterEntry) {
        return {
          ok: false,
          error: guardAfterEntry,
        };
      }
      const directoryAfterEntry = directoryIdentity(dir, dirLabel);
      if (!directoryAfterEntry.ok) {
        return {
          ok: false,
          error: directoryAfterEntry.error,
        };
      }
      if (!sameFileIdentity(directoryAfterRead.identity, directoryAfterEntry.identity)) {
        return {
          ok: false,
          error: `${dirLabel} changed during evidence collection.`,
        };
      }

      if (entryStats.isSymbolicLink()) {
        symlinks.push(relativePath);
        continue;
      }

      if (entryStats.isDirectory()) {
        if (depth + 1 > maxDepth) {
          truncated = true;
          return {
            ok: true,
            fileCount,
            dirCount,
            totalBytes,
            suspiciousFiles,
            symlinks,
            truncated,
            limitExceeded: "depth",
          };
        }
        stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (!entryStats.isFile()) continue;

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
      totalBytes += entryStats.size;
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
  const trustedPath = validateTrustedDirectoryPath(workspaceRoot, hostPath);
  if (!trustedPath.ok) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      hostPath,
      workspaceRoot,
      error: trustedPath.error,
    };
  }

  const maxFiles = intLimit(args.maxFiles, GATEKEEPER_MAX_STATIC_SITE_FILES);
  const maxBytes = intLimit(args.maxBytes, GATEKEEPER_MAX_STATIC_SITE_BYTES);
  const maxDirs = intLimit(args.maxDirs, GATEKEEPER_MAX_STATIC_SITE_DIRS);
  const maxDepth = intLimit(args.maxDepth, GATEKEEPER_MAX_STATIC_SITE_DEPTH);
  const indexResult = indexHtmlExists(hostPath, trustedPath.guardedDirectories);
  if (!indexResult.ok) {
    return {
      kind: "static_site",
      ok: false,
      sourcePath: args.sourcePath,
      hostPath,
      workspaceRoot,
      error: indexResult.error,
    };
  }
  const walk = walkDirectory(hostPath, {
    maxFiles,
    maxBytes,
    maxDirs,
    maxDepth,
    guardedDirectories: trustedPath.guardedDirectories,
  });
  return {
    kind: "static_site",
    ok: walk.ok,
    sourcePath: args.sourcePath,
    hostPath,
    workspaceRoot,
    siteName: typeof args.siteName === "string" ? args.siteName : null,
    hasIndexHtml: indexResult.hasIndexHtml,
    maxFiles,
    maxBytes,
    maxDirs,
    maxDepth,
    ...walk,
  };
}

export function staticSiteExecutionRejectionReason(evidence) {
  if (!evidence?.ok) return evidence?.error || "static preview source evidence is invalid.";
  if (!evidence.hasIndexHtml) return "source directory does not contain a root index.html.";
  const limitLabels = {
    files: "file count",
    bytes: "byte",
    dirs: "directory count",
    depth: "depth",
  };
  if (Object.hasOwn(limitLabels, evidence.limitExceeded)) {
    return `source directory exceeds configured ${limitLabels[evidence.limitExceeded]} limit.`;
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
