#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebToolService } from "../control-plane/src/web-tool-service.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES_PATH = resolve(SCRIPT_DIR, "../control-plane/evals/web-tool-cases.jsonl");

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    casesPath: DEFAULT_CASES_PATH,
    providers: [],
    outPath: "",
    includeContent: false,
    includeAnswer: false,
    maxResults: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value.`);
      return argv[index];
    };

    if (arg === "--cases") {
      options.casesPath = resolve(next());
    } else if (arg === "--providers") {
      options.providers = parseCsv(next());
    } else if (arg === "--out") {
      options.outPath = resolve(next());
    } else if (arg === "--include-content") {
      options.includeContent = true;
    } else if (arg === "--include-answer") {
      options.includeAnswer = true;
    } else if (arg === "--max-results") {
      const value = Number.parseInt(next(), 10);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new Error("--max-results must be an integer from 1 through 20.");
      }
      options.maxResults = value;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    "Usage: node scripts/benchmark-web-tools.mjs [options]",
    "",
    "Options:",
    "  --cases <path>          JSONL fixture file. Default: control-plane/evals/web-tool-cases.jsonl",
    "  --providers <csv>       Provider names to compare. Default: all configured search providers.",
    "  --out <path>            Write JSONL records to a file instead of stdout.",
    "  --include-content       Request extracted content when the provider supports it.",
    "  --include-answer        Request provider-generated sourced answers when supported.",
    "  --max-results <1-20>    Override per-case maxResults.",
  ].join("\n");
}

function readCases(path) {
  if (!existsSync(path)) throw new Error(`Case file does not exist: ${path}`);
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSON on ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (typeof parsed.id !== "string" || !parsed.id.trim()) {
        throw new Error(`Case ${path}:${index + 1} must include a non-empty string id.`);
      }
      if (typeof parsed.query !== "string" || !parsed.query.trim()) {
        throw new Error(`Case ${parsed.id} must include a non-empty string query.`);
      }
      return parsed;
    });
}

function providerNamesFor(service, requestedProviders) {
  const providers = service.manifest().providers;
  const byName = new Map(providers.map((provider) => [provider.name, provider]));
  const names = requestedProviders.length > 0
    ? requestedProviders
    : providers
        .filter((provider) => provider.configured && provider.capabilities?.search)
        .map((provider) => provider.name);

  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown provider(s): ${unknown.join(", ")}`);
  }
  if (names.length === 0) {
    throw new Error("No configured search providers found. Set provider API keys or pass --providers to record explicit configuration failures.");
  }
  return names;
}

function recordLine(record) {
  return `${JSON.stringify(record)}\n`;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const service = new WebToolService();
  const cases = readCases(options.casesPath);
  const providers = providerNamesFor(service, options.providers);
  const startedAt = new Date().toISOString();
  const lines = [];

  lines.push(recordLine({
    type: "web_tool_benchmark_start",
    startedAt,
    casesPath: options.casesPath,
    providers,
    includeContent: options.includeContent,
    includeAnswer: options.includeAnswer,
  }));

  for (const testCase of cases) {
    for (const provider of providers) {
      const request = {
        query: testCase.query,
        provider,
        maxResults: options.maxResults || testCase.maxResults || 5,
        freshness: testCase.freshness,
        includeDomains: testCase.includeDomains,
        excludeDomains: testCase.excludeDomains,
        country: testCase.country,
        language: testCase.language,
        includeContent: options.includeContent || testCase.includeContent === true,
        includeAnswer: options.includeAnswer || testCase.includeAnswer === true,
      };
      const start = Date.now();
      try {
        const result = await service.search(request);
        lines.push(recordLine({
          type: "web_tool_benchmark_result",
          ok: true,
          caseId: testCase.id,
          intent: testCase.intent || null,
          provider,
          durationMs: Date.now() - start,
          expectedDomains: testCase.expectedDomains || [],
          request,
          result,
        }));
      } catch (error) {
        lines.push(recordLine({
          type: "web_tool_benchmark_result",
          ok: false,
          caseId: testCase.id,
          intent: testCase.intent || null,
          provider,
          durationMs: Date.now() - start,
          expectedDomains: testCase.expectedDomains || [],
          request,
          status: Number.isInteger(error?.status) ? error.status : null,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  lines.push(recordLine({
    type: "web_tool_benchmark_end",
    startedAt,
    finishedAt: new Date().toISOString(),
  }));

  if (options.outPath) {
    mkdirSync(dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, lines.join(""), "utf8");
  } else {
    process.stdout.write(lines.join(""));
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
