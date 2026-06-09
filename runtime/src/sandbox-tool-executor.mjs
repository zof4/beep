import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { sandboxToolErrorResult, sandboxToolOkResult } from "./sandbox-tool-protocol.mjs";

const DEFAULT_OUTPUT_CAP_BYTES = 128 * 1024;

function textContent(text) {
  return [{ type: "text", text: String(text ?? "") }];
}

function bufferText(value) {
  return Buffer.from(String(value ?? ""), "utf8");
}

function truncateOutput(text, capBytes = DEFAULT_OUTPUT_CAP_BYTES) {
  const buffer = bufferText(text);
  if (buffer.length <= capBytes) return { text: String(text), truncated: false };
  return {
    text: `${buffer.subarray(0, capBytes).toString("utf8")}\n[output truncated at ${capBytes} bytes]`,
    truncated: true,
  };
}

function containedWorkspacePath(cwd, path = ".") {
  const root = resolve(cwd || "/workspace");
  const fullPath = resolve(root, String(path || "."));
  const rel = relative(root, fullPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(fullPath) === resolve(root, "..")) {
    throw Object.assign(new Error(`Path escapes outside workspace: ${path}`), { status: 400 });
  }
  return { root, fullPath };
}

function positiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function posixRelative(root, fullPath) {
  const rel = relative(root, fullPath);
  return rel ? rel.split(sep).join("/") : ".";
}

function spawnCapture(command, args, { cwd, timeoutMs }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || cwd,
        TMPDIR: process.env.TMPDIR || "/tmp",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs || 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveResult({ exitCode: null, signal: null, stdout, stderr: error.message, timedOut });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolveResult({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

async function runBash(request) {
  const command = String(request.args.command || "");
  if (!command) throw Object.assign(new Error("bash command is required."), { status: 400 });
  const { root } = containedWorkspacePath(request.cwd, ".");

  return new Promise((resolveResult) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: root,
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || root,
        TMPDIR: process.env.TMPDIR || "/tmp",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeoutMs || 60_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolveResult(
        sandboxToolErrorResult({
          toolCallId: request.toolCallId,
          error: error.message,
          details: { toolName: "bash", timedOut },
        }),
      );
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const combined = stderr ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout;
      const output = truncateOutput(combined || "(no output)");
      const details = {
        exitCode,
        signal,
        stdout,
        stderr,
        truncated: output.truncated,
        timedOut,
      };

      if (exitCode === 0 && !signal && !timedOut) {
        resolveResult(
          sandboxToolOkResult({
            toolCallId: request.toolCallId,
            content: textContent(output.text),
            details,
          }),
        );
      } else {
        resolveResult(
          sandboxToolErrorResult({
            toolCallId: request.toolCallId,
            error: output.text || `bash exited with ${exitCode ?? signal}`,
            details,
          }),
        );
      }
    });
  });
}

async function runRead(request) {
  const { fullPath } = containedWorkspacePath(request.cwd, request.args.path);
  const content = await readFile(fullPath, "utf8");
  const offset = positiveInteger(request.args.offset, 1);
  const limit = positiveInteger(request.args.limit, null);
  const lines = content.split(/\r?\n/u);
  const selected = limit === null ? lines.slice(offset - 1) : lines.slice(offset - 1, offset - 1 + limit);
  const text = offset === 1 && limit === null ? content : selected.join("\n");
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(text),
    details: { path: fullPath, offset, limit, lineCount: lines.length },
  });
}

async function runWrite(request) {
  const { fullPath } = containedWorkspacePath(request.cwd, request.args.path);
  const content = String(request.args.content ?? "");
  await mkdir(dirname(fullPath), { recursive: true });
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
  const { fullPath } = containedWorkspacePath(request.cwd, request.args.path);
  const edits = normalizeEditArgs(request.args);
  const originalContent = await readFile(fullPath, "utf8");
  const nextContent = applyExactEdits(originalContent, edits, request.args.path);
  await writeFile(fullPath, nextContent);
  const patch = simplePatch(request.args.path, originalContent, nextContent);
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(`Successfully replaced ${edits.length} block(s) in ${request.args.path}.`),
    details: {
      diff: patch,
      patch,
      firstChangedLine: firstChangedLine(originalContent, nextContent),
    },
  });
}

async function runLs(request) {
  const { fullPath } = containedWorkspacePath(request.cwd, request.args.path || ".");
  const limit = positiveInteger(request.args.limit, 500);
  const entries = await readdir(fullPath, { withFileTypes: true });
  const lines = entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort();
  const selected = lines.slice(0, limit);
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(selected.length ? selected.join("\n") : "(empty directory)"),
    details: {
      path: fullPath,
      entryCount: entries.length,
      ...(lines.length > limit ? { entryLimitReached: limit } : {}),
    },
  });
}

async function runGrep(request) {
  const pattern = String(request.args.pattern || "");
  if (!pattern) throw Object.assign(new Error("grep pattern is required."), { status: 400 });
  const path = request.args.path || ".";
  const { root, fullPath } = containedWorkspacePath(request.cwd, path);
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
      details: { exitCode: result.exitCode },
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
  const { fullPath } = containedWorkspacePath(request.cwd, path);
  const limit = positiveInteger(request.args.limit, 1000);
  const matcher = compileFindMatcher(request.args.pattern);
  const results = [];
  await collectFindMatches(fullPath, fullPath, matcher, results, limit);
  return sandboxToolOkResult({
    toolCallId: request.toolCallId,
    content: textContent(results.length ? results.join("\n") : "No files found matching pattern"),
    details: {
      path: fullPath,
      resultCount: results.length,
      ...(results.length >= limit ? { resultLimitReached: limit } : {}),
    },
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
  const { fullPath } = containedWorkspacePath(cwd, path);
  const stats = await stat(fullPath);
  return {
    path: fullPath,
    type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
    bytes: stats.isFile() ? stats.size : null,
  };
}
