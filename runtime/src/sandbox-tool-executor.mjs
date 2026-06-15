import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sandboxToolErrorResult, sandboxToolOkResult } from "./sandbox-tool-protocol.mjs";

const DEFAULT_OUTPUT_CAP_BYTES = 128 * 1024;
const PROCESS_GROUP_KILL_GRACE_MS = 500;

function textContent(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

function bufferText(value) {
  return Buffer.from(String(value ?? ""), "utf8");
}

function outputTruncationMarker(capBytes = DEFAULT_OUTPUT_CAP_BYTES) {
  return `\n[output truncated at ${capBytes} bytes]`;
}

function truncateOutput(text, capBytes = DEFAULT_OUTPUT_CAP_BYTES) {
  const buffer = bufferText(text);
  if (buffer.length <= capBytes) return { text: String(text), truncated: false, bytes: buffer.length };
  return {
    text: `${buffer.subarray(0, capBytes).toString("utf8")}${outputTruncationMarker(capBytes)}`,
    truncated: true,
    bytes: capBytes,
  };
}

function boundedTextCollector(capBytes = DEFAULT_OUTPUT_CAP_BYTES) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (truncated) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8");
      const remaining = capBytes - bytes;
      if (buffer.length <= remaining) {
        chunks.push(buffer.toString("utf8"));
        bytes += buffer.length;
        return;
      }
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining).toString("utf8"));
      }
      bytes = capBytes;
      truncated = true;
    },
    value() {
      const text = chunks.join("");
      return {
        text: truncated ? `${text}${outputTruncationMarker(capBytes)}` : text,
        truncated,
        bytes,
      };
    },
  };
}

function isPathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertPathInside(root, candidate, path) {
  if (!isPathInside(resolve(root), resolve(candidate))) {
    throw Object.assign(new Error(`Path escapes outside workspace: ${path}`), { status: 400 });
  }
}

function containedWorkspacePath(cwd, path = ".") {
  const root = resolve(cwd || "/workspace");
  const fullPath = resolve(root, String(path || "."));
  assertPathInside(root, fullPath, path);
  return { root, fullPath };
}

function isNotFound(error) {
  return error?.code === "ENOENT";
}

async function containedExistingPath(cwd, path = ".") {
  const { root, fullPath } = containedWorkspacePath(cwd, path);
  const realRoot = await realpath(root);
  const realFullPath = await realpath(fullPath);
  assertPathInside(realRoot, realFullPath, path);
  return { root, fullPath, realRoot, realFullPath };
}

async function nearestExistingAncestor(root, path) {
  let current = path;
  for (;;) {
    assertPathInside(root, current, path);
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function validateExistingTargetIfPresent(realRoot, fullPath, path) {
  try {
    await lstat(fullPath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const realFullPath = await realpath(fullPath);
  assertPathInside(realRoot, realFullPath, path);
  return realFullPath;
}

async function containedWritePath(cwd, path = ".") {
  const { root, fullPath } = containedWorkspacePath(cwd, path);
  const realRoot = await realpath(root);
  const parentPath = fullPath === root ? root : dirname(fullPath);
  const ancestor = await nearestExistingAncestor(root, parentPath);
  const realAncestor = await realpath(ancestor);
  assertPathInside(realRoot, realAncestor, path);

  await mkdir(parentPath, { recursive: true });
  const realParent = await realpath(parentPath);
  assertPathInside(realRoot, realParent, path);
  const realFullPath = await validateExistingTargetIfPresent(realRoot, fullPath, path);
  return { root, fullPath, realRoot, realParent, realFullPath };
}

function positiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function posixRelative(root, fullPath) {
  const rel = relative(root, fullPath);
  return rel ? rel.split(sep).join("/") : ".";
}

function processEnv(cwd) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || cwd,
    TMPDIR: process.env.TMPDIR || "/tmp",
  };
}

function signalProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function terminateProcessTree(child) {
  try {
    signalProcessTree(child, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  return setTimeout(() => {
    try {
      signalProcessTree(child, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, PROCESS_GROUP_KILL_GRACE_MS);
}

function spawnCapture(command, args, { cwd, timeoutMs, input = undefined }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: processEnv(cwd),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = boundedTextCollector();
    const stderr = boundedTextCollector();
    let timedOut = false;
    let killTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      killTimer = terminateProcessTree(child);
    }, timeoutMs || 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const stdoutValue = stdout.value();
      const stderrValue = truncateOutput(error.message);
      resolveResult({
        exitCode: null,
        signal: null,
        stdout: stdoutValue.text,
        stderr: stderrValue.text,
        stdoutTruncated: stdoutValue.truncated,
        stderrTruncated: stderrValue.truncated,
        truncated: stdoutValue.truncated || stderrValue.truncated,
        timedOut,
        spawnError: error.message,
      });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const stdoutValue = stdout.value();
      const stderrValue = stderr.value();
      resolveResult({
        exitCode,
        signal,
        stdout: stdoutValue.text,
        stderr: stderrValue.text,
        stdoutTruncated: stdoutValue.truncated,
        stderrTruncated: stderrValue.truncated,
        truncated: stdoutValue.truncated || stderrValue.truncated,
        timedOut,
      });
    });
    child.stdin.end(input === undefined ? undefined : input);
  });
}

async function runBash(request) {
  const command = String(request.args.command || "");
  if (!command) throw Object.assign(new Error("bash command is required."), { status: 400 });
  const { root } = containedWorkspacePath(request.cwd, ".");

  const result = await spawnCapture("bash", ["-lc", command], { cwd: root, timeoutMs: request.timeoutMs });
  const combined = result.stderr ? `${result.stdout}${result.stdout ? "\n" : ""}${result.stderr}` : result.stdout;
  const output = truncateOutput(combined || "(no output)");
  const details = {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    truncated: output.truncated || result.truncated,
    timedOut: result.timedOut,
  };

  if (!result.spawnError && result.exitCode === 0 && !result.signal && !result.timedOut) {
    return sandboxToolOkResult({
      toolCallId: request.toolCallId,
      content: textContent(output.text),
      details,
    });
  }

  return sandboxToolErrorResult({
    toolCallId: request.toolCallId,
    error: output.text || result.spawnError || `bash exited with ${result.exitCode ?? result.signal}`,
    details,
  });
}

async function runRead(request) {
  const { fullPath, realFullPath } = await containedExistingPath(request.cwd, request.args.path);
  const content = await readFile(realFullPath, "utf8");
  const offset = positiveInteger(request.args.offset, 1);
  const limit = positiveInteger(request.args.limit, null);
  const lines = content.split(/\r?\n/u);
  const selected = limit === null ? lines.slice(offset - 1) : lines.slice(offset - 1, offset - 1 + limit);
  const text = offset === 1 && limit === null ? content : selected.join("\n");
  const output = truncateOutput(text);
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(output.text),
    details: {
      path: fullPath,
      offset,
      limit,
      lineCount: lines.length,
      bytes: Buffer.byteLength(content),
      truncated: output.truncated,
    },
  });
}

async function runWrite(request) {
  const { fullPath } = await containedWritePath(request.cwd, request.args.path);
  const content = String(request.args.content ?? "");
  await writeFile(fullPath, content);
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(`Successfully wrote ${content.length} bytes to ${request.args.path}`),
    details: { path: fullPath, bytes: Buffer.byteLength(content) },
  });
}

function normalizeEditArgs(args = {}) {
  let edits = args.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = [];
    }
  }
  if (!Array.isArray(edits)) edits = [];
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits = [...edits, { oldText: args.oldText, newText: args.newText }];
  }
  return edits;
}

function countOccurrences(content, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function firstChangedLine(oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < max; index += 1) {
    if (oldLines[index] !== newLines[index]) return index + 1;
  }
  return undefined;
}

function simplePatch(path, oldContent, newContent) {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const max = Math.max(oldLines.length, newLines.length);
  const lines = [`--- ${path}`, `+++ ${path}`, "@@"];
  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine === newLine) {
      if (oldLine !== undefined) lines.push(` ${oldLine}`);
    } else {
      if (oldLine !== undefined) lines.push(`-${oldLine}`);
      if (newLine !== undefined) lines.push(`+${newLine}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function applyExactEdits(originalContent, edits, path) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw Object.assign(new Error("Edit tool input is invalid. edits must contain at least one replacement."), {
      status: 400,
    });
  }

  const matches = edits.map((edit, index) => {
    if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") {
      throw Object.assign(new Error(`edits[${index}] must include string oldText and newText in ${path}.`), {
        status: 400,
      });
    }
    if (edit.oldText.length === 0) {
      throw Object.assign(new Error(`edits[${index}].oldText must not be empty in ${path}.`), { status: 400 });
    }
    const occurrences = countOccurrences(originalContent, edit.oldText);
    if (occurrences === 0) {
      throw Object.assign(
        new Error(
          `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
        ),
        { status: 400 },
      );
    }
    if (occurrences > 1) {
      throw Object.assign(
        new Error(
          `Found ${occurrences} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
        ),
        { status: 400 },
      );
    }
    return {
      index,
      start: originalContent.indexOf(edit.oldText),
      length: edit.oldText.length,
      newText: edit.newText,
    };
  });

  matches.sort((left, right) => left.start - right.start);
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const current = matches[index];
    if (previous.start + previous.length > current.start) {
      throw Object.assign(
        new Error(
          `edits[${previous.index}] and edits[${current.index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
        ),
        { status: 400 },
      );
    }
  }

  let nextContent = originalContent;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    nextContent =
      nextContent.slice(0, match.start) + match.newText + nextContent.slice(match.start + match.length);
  }
  if (nextContent === originalContent) {
    throw Object.assign(new Error(`Edit made no changes in ${path}.`), { status: 400 });
  }
  return nextContent;
}

async function runEdit(request) {
  const { realFullPath } = await containedExistingPath(request.cwd, request.args.path);
  const edits = normalizeEditArgs(request.args);
  const originalContent = await readFile(realFullPath, "utf8");
  const nextContent = applyExactEdits(originalContent, edits, request.args.path);
  await writeFile(realFullPath, nextContent);
  const patch = truncateOutput(simplePatch(request.args.path, originalContent, nextContent));
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(`Successfully replaced ${edits.length} block(s) in ${request.args.path}.`),
    details: {
      diff: patch.text,
      patch: patch.text,
      patchTruncated: patch.truncated,
      firstChangedLine: firstChangedLine(originalContent, nextContent),
    },
  });
}

async function runLs(request) {
  const { fullPath } = await containedExistingPath(request.cwd, request.args.path || ".");
  const limit = positiveInteger(request.args.limit, 500);
  const entries = await readdir(fullPath, { withFileTypes: true });
  const lines = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort();
  const selected = lines.slice(0, limit);
  const output = truncateOutput(selected.length ? selected.join("\n") : "(empty directory)");
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(output.text),
    details: {
      path: fullPath,
      entryCount: entries.length,
      truncated: output.truncated,
      ...(lines.length > limit ? { entryLimitReached: limit } : {}),
    },
  });
}

async function runGrep(request) {
  const pattern = String(request.args.pattern || "");
  if (!pattern) throw Object.assign(new Error("grep pattern is required."), { status: 400 });
  const path = request.args.path || ".";
  const { root, fullPath } = await containedExistingPath(request.cwd, path);
  const limit = positiveInteger(request.args.limit, 100);
  const context = positiveInteger(request.args.context, 0);
  const args = ["--line-number", "--color", "never"];
  if (request.args.ignoreCase === true) args.push("--ignore-case");
  if (request.args.literal === true) args.push("--fixed-strings");
  if (context > 0) args.push("--context", String(context));
  if (typeof request.args.glob === "string" && request.args.glob) args.push("--glob", request.args.glob);
  args.push("--", pattern, posixRelative(root, fullPath));

  const result = await spawnCapture("rg", args, { cwd: root, timeoutMs: request.timeoutMs });
  if (result.exitCode === 1 && !result.stdout) {
    return sandboxToolOkResult({
      toolCallId: request.toolCallId,
      content: textContent("No matches found"),
      details: { exitCode: result.exitCode, truncated: result.truncated },
    });
  }
  if (result.exitCode !== 0 || result.signal || result.timedOut) {
    return sandboxToolErrorResult({
      toolCallId: request.toolCallId,
      error: result.stderr || `grep exited with ${result.exitCode ?? result.signal}`,
      details: result,
    });
  }

  const lines = result.stdout
    .trimEnd()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.replace(/^\.\//u, ""));
  const selected = lines.slice(0, limit);
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(selected.length ? selected.join("\n") : "No matches found"),
    details: {
      exitCode: result.exitCode,
      matchCount: lines.length,
      truncated: result.truncated,
      ...(lines.length > limit ? { matchLimitReached: limit } : {}),
    },
  });
}

function globPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "u");
}

function compileFindMatcher(pattern) {
  const raw = String(pattern || "");
  if (!raw) throw Object.assign(new Error("find pattern is required."), { status: 400 });
  if (raw.includes("*") || raw.includes("?")) {
    const glob = globPatternToRegExp(raw);
    return (relPath, name) => glob.test(relPath) || glob.test(name);
  }
  try {
    const regex = new RegExp(raw, "u");
    return (relPath, name) => regex.test(relPath) || regex.test(name) || relPath.includes(raw) || name.includes(raw);
  } catch {
    return (relPath, name) => relPath.includes(raw) || name.includes(raw);
  }
}

async function collectFindMatches(root, currentDir, matcher, results, limit) {
  if (results.length >= limit) return;
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = resolve(currentDir, entry.name);
    const relPath = posixRelative(root, fullPath);
    if (entry.isDirectory()) {
      await collectFindMatches(root, fullPath, matcher, results, limit);
    } else if (entry.isFile() && matcher(relPath, entry.name)) {
      results.push(relPath);
      if (results.length >= limit) return;
    }
  }
}

async function runFind(request) {
  const path = request.args.path || ".";
  const { fullPath } = await containedExistingPath(request.cwd, path);
  const limit = positiveInteger(request.args.limit, 1000);
  const matcher = compileFindMatcher(request.args.pattern);
  const results = [];
  await collectFindMatches(fullPath, fullPath, matcher, results, limit);
  const output = truncateOutput(results.length ? results.join("\n") : "No files found matching pattern");
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(output.text),
    details: {
      path: fullPath,
      resultCount: results.length,
      truncated: output.truncated,
      ...(results.length >= limit ? { resultLimitReached: limit } : {}),
    },
  });
}

async function runDynamicCli(request) {
  const dynamicTool = request.dynamicTool;
  if (!dynamicTool?.command?.argv?.length) {
    throw Object.assign(new Error("dynamic_cli requires dynamicTool.command.argv."), { status: 400 });
  }

  const { root } = containedWorkspacePath(request.cwd, ".");
  const scriptPath = dynamicTool.command.argv[1];
  const scriptCandidate = resolve(root, scriptPath);
  assertPathInside(root, scriptCandidate, scriptPath);
  const realRoot = await realpath(root);
  const realScriptPath = await realpath(scriptCandidate);
  assertPathInside(realRoot, realScriptPath, scriptPath);

  const input = JSON.stringify({
    action: dynamicTool.action,
    args: request.args,
    toolCallId: request.toolCallId,
  });
  const result = await spawnCapture(dynamicTool.command.argv[0], dynamicTool.command.argv.slice(1), {
    cwd: realRoot,
    timeoutMs: dynamicTool.command.timeoutMs || request.timeoutMs,
    input,
  });
  const combined = result.stderr ? `${result.stdout}${result.stdout ? "\n" : ""}${result.stderr}` : result.stdout;
  const output = truncateOutput(combined || "(no output)");
  const details = {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    truncated: output.truncated || result.truncated,
    timedOut: result.timedOut,
    ...(result.spawnError ? { spawnError: result.spawnError } : {}),
  };

  if (!result.spawnError && result.exitCode === 0 && !result.signal && !result.timedOut) {
    return sandboxToolOkResult({
      toolCallId: request.toolCallId,
      content: textContent(output.text),
      details,
    });
  }

  return sandboxToolErrorResult({
    toolCallId: request.toolCallId,
    error: output.text || result.spawnError || `dynamic_cli exited with ${result.exitCode ?? result.signal}`,
    details,
  });
}

export async function executeSandboxTool(request) {
  try {
    if (request.toolName === "bash") return await runBash(request);
    if (request.toolName === "read") return await runRead(request);
    if (request.toolName === "write") return await runWrite(request);
    if (request.toolName === "edit") return await runEdit(request);
    if (request.toolName === "ls") return await runLs(request);
    if (request.toolName === "grep") return await runGrep(request);
    if (request.toolName === "find") return await runFind(request);
    if (request.toolName === "dynamic_cli") return await runDynamicCli(request);
    throw Object.assign(new Error(`Unsupported sandbox tool: ${request.toolName}`), { status: 400 });
  } catch (error) {
    return sandboxToolErrorResult({
      toolCallId: request.toolCallId,
      error: error instanceof Error ? error.message : String(error),
      details: { toolName: request.toolName, status: error?.status || 500 },
    });
  }
}

export async function describeSandboxPath(cwd, path = ".") {
  const { fullPath, realFullPath } = await containedExistingPath(cwd, path);
  const stats = await stat(realFullPath);
  return {
    path: fullPath,
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
    bytes: stats.isFile() ? stats.size : null,
  };
}
