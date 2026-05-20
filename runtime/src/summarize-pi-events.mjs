import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const [eventsPath, workspacePath, summaryPath, statusArg] = process.argv.slice(2);

if (!eventsPath || !workspacePath || !summaryPath || statusArg === undefined) {
  console.error("usage: summarize-pi-events.mjs <events.jsonl> <workspace> <summary.json> <exit-status>");
  process.exit(64);
}

function readJsonl(path) {
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

const events = readJsonl(eventsPath);
const parseErrors = events.filter((event) => event.type === "parse_error");
const eventTypes = events.reduce((counts, event) => {
  const type = event.type || event.event || "unknown";
  counts[type] = (counts[type] || 0) + 1;
  return counts;
}, {});
const serializedEvents = events.map((event) => JSON.stringify(event));
const commandMentions = serializedEvents.filter((line) => /pwd|ls -la|node --version|uname -a|pi-proof-calculator|pi-proof-result/.test(line)).length;
const errorMentions = serializedEvents.filter((line) => /error|failed|exception/i.test(line)).length;
const proofFiles = {
  calculator: fileInfo(join(workspacePath, "pi-proof-calculator.mjs")),
  result: fileInfo(join(workspacePath, "pi-proof-result.json")),
  report: fileInfo(join(workspacePath, "pi-proof-report.md")),
};
const proofFilesExist = Object.values(proofFiles).every((file) => file.exists && file.bytes > 0);
const proofResult = readJsonIfExists(join(workspacePath, "pi-proof-result.json"));

const summary = {
  ok: Number(statusArg) === 0 && parseErrors.length === 0 && proofFilesExist,
  exitStatus: Number(statusArg),
  events: {
    path: eventsPath,
    basename: basename(eventsPath),
    total: events.length,
    byType: eventTypes,
    commandMentions,
    errorMentions,
    parseErrors: parseErrors.length,
  },
  workspace: {
    path: workspacePath,
    entries: listWorkspace(workspacePath),
    proofFiles,
    proofFilesExist,
    proofResult,
  },
  lcm: readJsonIfExists(join(dirname(summaryPath), "lcm-summary.json")),
};

writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
