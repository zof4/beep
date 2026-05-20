import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [eventsPath, workspacePath, summaryPath, statusArg] = process.argv.slice(2);

if (!eventsPath || !workspacePath || !summaryPath || statusArg === undefined) {
  console.error("usage: summarize-codex-events.mjs <events.jsonl> <workspace> <summary.json> <exit-status>");
  process.exit(64);
}

function readEvents(path) {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse_error", message: error.message, line };
      }
    });
}

function listWorkspace(path) {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path)
    .map((entry) => {
      const fullPath = join(path, entry);
      const stat = statSync(fullPath);
      return {
        name: entry,
        type: stat.isDirectory() ? "directory" : "file",
        bytes: stat.isFile() ? stat.size : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fileInfo(path) {
  if (!existsSync(path)) {
    return { exists: false, bytes: null };
  }

  const stat = statSync(path);
  return { exists: true, bytes: stat.size };
}

function readJsonIfExists(path) {
  if (!existsSync(path)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { parseError: error.message };
  }
}

const events = readEvents(eventsPath);
const completedItems = events
  .filter((event) => event.type === "item.completed" && event.item)
  .map((event) => event.item);
const commandItems = completedItems.filter((item) => item.type === "command_execution");
const fileChangeItems = completedItems.filter((item) => item.type === "file_change");
const agentMessages = completedItems.filter((item) => item.type === "agent_message");
const failures = events.filter((event) => event.type === "turn.failed" || event.type === "error" || event.type === "parse_error");
const usageEvent = [...events].reverse().find((event) => event.type === "turn.completed");
const successfulCommandItems = commandItems.filter((item) => item.status === "completed" && item.exit_code === 0);
const failedCommandItems = commandItems.filter((item) => item.status !== "completed" || item.exit_code !== 0);
const proofFiles = {
  calculator: fileInfo(join(workspacePath, "proof-calculator.mjs")),
  result: fileInfo(join(workspacePath, "proof-result.json")),
  report: fileInfo(join(workspacePath, "proof-report.md")),
};
const proofResult = readJsonIfExists(join(workspacePath, "proof-result.json"));
const proofFilesExist = Object.values(proofFiles).every((file) => file.exists && file.bytes > 0);

const summary = {
  ok: Number(statusArg) === 0 && failures.length === 0 && successfulCommandItems.length >= 3 && proofFilesExist,
  exitStatus: Number(statusArg),
  events: {
    path: eventsPath,
    basename: basename(eventsPath),
    total: events.length,
    threadStarted: events.filter((event) => event.type === "thread.started").length,
    turnStarted: events.filter((event) => event.type === "turn.started").length,
    turnCompleted: events.filter((event) => event.type === "turn.completed").length,
    turnFailed: events.filter((event) => event.type === "turn.failed").length,
    completedItems: completedItems.length,
    commandExecutions: commandItems.length,
    successfulCommandExecutions: successfulCommandItems.length,
    failedCommandExecutions: failedCommandItems.length,
    fileChanges: fileChangeItems.length,
    agentMessages: agentMessages.length,
  },
  usage: usageEvent?.usage ?? null,
  commands: commandItems.map((item) => ({
    command: item.command,
    exitCode: item.exit_code,
    status: item.status,
  })),
  fileChanges: fileChangeItems.flatMap((item) => item.changes ?? []),
  workspace: {
    path: workspacePath,
    entries: listWorkspace(workspacePath),
    proofFiles,
    proofFilesExist,
    proofResult,
  },
  failures: failures.map((event) => event.message ?? event.error?.message ?? event.item?.message ?? event),
  lcm: readJsonIfExists(join(dirname(summaryPath), "lcm-summary.json")),
};

writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
