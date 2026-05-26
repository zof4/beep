import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PiRpcSession } from "../pi-rpc-session.mjs";
import {
  API_SESSIONS_DIR,
  parseJsonl,
  readJsonFile,
  safeNumber,
} from "../runtime-common.mjs";
import { jsonResponse, readRequestJson, routeError, textResponse } from "../http-utils.mjs";

function getSession(sessions, id) {
  return sessions.get(id) || null;
}

function readSessionStatus(sessions, id) {
  const active = getSession(sessions, id);
  if (active) return active.status();
  return readJsonFile(join(API_SESSIONS_DIR, id, "status.json"), null);
}

function readPiRuntimeOptions(body) {
  const options = {};
  for (const key of [
    "noSession",
    "noBuiltinTools",
    "noContextFiles",
    "noSkills",
    "noPromptTemplates",
    "noThemes",
    "loadLcmContextExtension",
    "loadLcmRecallToolsExtension",
    "loadControlPlaneToolsExtension",
  ]) {
    if (typeof body[key] === "boolean") options[key] = body[key];
  }
  if (Array.isArray(body.toolAllowlist)) {
    options.toolAllowlist = body.toolAllowlist.filter((name) => typeof name === "string" && name.trim()).map(String);
  }
  if (typeof body.systemPrompt === "string") {
    options.systemPrompt = body.systemPrompt;
  }
  return options;
}

export function listSessionStatuses(sessions) {
  const seen = new Set();
  const active = [...sessions.values()].map((session) => {
    seen.add(session.id);
    return session.status();
  });
  const inactive = readdirSync(API_SESSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !seen.has(entry.name))
    .map((entry) => readSessionStatus(sessions, entry.name))
    .filter(Boolean);
  return [...active, ...inactive].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export async function handleCreateSession(req, res, { sessions, lcmController }) {
  const body = await readRequestJson(req);
  const session = await PiRpcSession.start({
    model: body.model,
    thinking: body.thinking,
    prefix: body.prefix,
    sessions,
    lcmController,
    ...readPiRuntimeOptions(body),
  });
  jsonResponse(res, 201, { ok: true, session: session.status() });
}

export async function handleRun(req, res, { sessions, lcmController }) {
  const body = await readRequestJson(req);
  const prompt = body.prompt || body.message;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    routeError(res, 400, "POST /runs requires a prompt string.");
    return;
  }
  const session = await PiRpcSession.start({
    model: body.model,
    thinking: body.thinking,
    prefix: body.prefix || "run",
    sessions,
    lcmController,
    ...readPiRuntimeOptions(body),
  });
  let promptResult;
  let lcm = null;
  try {
    promptResult = await session.prompt(prompt, {
      waitForCompletion: true,
      timeoutMs: body.timeoutMs,
      streamingBehavior: body.streamingBehavior,
    });
    if (body.recordLcm !== false) {
      lcm = await session.recordLcm({ force: Boolean(body.forceLcm) });
    }
  } finally {
    if (body.closeOnComplete !== false) {
      await session.stop();
      sessions.delete(session.id);
    }
  }
  jsonResponse(res, 200, {
    ok: true,
    runId: session.id,
    session: readSessionStatus(sessions, session.id) || session.status(),
    prompt: promptResult,
    lcm,
  });
}

export async function handleSessionRoute(req, res, url, parts, { sessions }) {
  const id = parts[1];
  const action = parts[2] || "";
  if (!id) {
    routeError(res, 404, "Missing session id.");
    return;
  }

  if (req.method === "GET" && action === "") {
    const status = readSessionStatus(sessions, id);
    if (!status) {
      routeError(res, 404, `Unknown session: ${id}`);
      return;
    }
    jsonResponse(res, 200, { ok: true, session: status });
    return;
  }

  if (req.method === "GET" && action === "events") {
    const status = readSessionStatus(sessions, id);
    if (!status) {
      routeError(res, 404, `Unknown session: ${id}`);
      return;
    }
    const events = parseJsonl(status.eventsPath);
    const limit = safeNumber(url.searchParams.get("limit"), events.length);
    const selected = events.slice(Math.max(0, events.length - limit));
    if (url.searchParams.get("format") === "ndjson") {
      textResponse(res, 200, `${selected.map((event) => JSON.stringify(event)).join("\n")}\n`, {
        "content-type": "application/x-ndjson; charset=utf-8",
      });
      return;
    }
    jsonResponse(res, 200, { ok: true, sessionId: id, total: events.length, events: selected });
    return;
  }

  if (req.method === "GET" && action === "summary") {
    const active = getSession(sessions, id);
    if (active) {
      jsonResponse(res, 200, { ok: true, summary: active.writeSummary() });
      return;
    }
    const summary = readJsonFile(join(API_SESSIONS_DIR, id, "summary.json"), null);
    if (!summary) {
      routeError(res, 404, `No summary for session: ${id}`);
      return;
    }
    jsonResponse(res, 200, { ok: true, summary });
    return;
  }

  const session = getSession(sessions, id);
  if (!session) {
    routeError(res, 404, `Session is not active: ${id}`);
    return;
  }

  if (req.method === "DELETE" && action === "") {
    const status = await session.stop();
    sessions.delete(id);
    jsonResponse(res, 200, { ok: true, session: status });
    return;
  }

  if (req.method !== "POST") {
    routeError(res, 405, "Unsupported method for session route.");
    return;
  }

  const body = await readRequestJson(req);

  if (action === "prompt") {
    const result = await session.prompt(body.message || body.prompt, {
      waitForCompletion: Boolean(body.waitForCompletion),
      timeoutMs: body.timeoutMs,
      streamingBehavior: body.streamingBehavior,
    });
    jsonResponse(res, result.response?.success === false ? 422 : 200, { ok: result.response?.success !== false, result });
    return;
  }

  if (action === "steer") {
    const response = await session.send({ type: "steer", message: body.message, images: body.images });
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "follow-up") {
    const response = await session.send({ type: "follow_up", message: body.message, images: body.images });
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "abort") {
    const response = await session.send({ type: "abort" });
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "rpc") {
    const command = body.command || body;
    if (!command || typeof command.type !== "string") {
      routeError(res, 400, "POST /sessions/:id/rpc requires a command object with type.");
      return;
    }
    const response = await session.send(command, body.timeoutMs);
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "lcm") {
    const lcm = await session.recordLcm({ force: Boolean(body.force) });
    jsonResponse(res, 200, { ok: true, lcm, summary: session.writeSummary() });
    return;
  }

  routeError(res, 404, `Unknown session action: ${action}`);
}
