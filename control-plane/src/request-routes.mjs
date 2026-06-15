import { sendJson, sendNotFound } from "./http-utils.mjs";
import { redactBeepInput, summarizeBeepInput } from "../../shared/native-input.mjs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PUBLIC_REQUEST_FIELDS = [
  "schemaVersion",
  "requestId",
  "runtimeId",
  "runtimeRequestId",
  "inputSummary",
  "redactedInput",
  "status",
  "source",
  "error",
  "runtimeResult",
  "createdAt",
  "updatedAt",
];
const UNSAFE_REQUEST_IDS = new Set(["__proto__", "prototype", "constructor"]);

function parseLimit(value) {
  if (!value) return DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/u.test(value)) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return Math.min(parsed, MAX_LIMIT);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableString(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : String(value);
}

function publicRuntimeRequest(request) {
  if (!isPlainObject(request)) return null;
  return {
    id: stableString(request.id),
    status: stableString(request.status),
    createdAt: stableString(request.createdAt),
    startedAt: stableString(request.startedAt),
    completedAt: stableString(request.completedAt),
    error: stableString(request.error),
  };
}

function publicRuntimeResult(runtimeResult) {
  if (!isPlainObject(runtimeResult)) return null;
  return {
    ok: typeof runtimeResult.ok === "boolean" ? runtimeResult.ok : null,
    error: stableString(runtimeResult.error),
    request: publicRuntimeRequest(runtimeResult.request),
  };
}

function publicInputSummary(record) {
  if (record.inputSummary) return record.inputSummary;
  if (!Array.isArray(record.input) || record.input.length === 0) return null;
  try {
    return summarizeBeepInput(record.input);
  } catch {
    return null;
  }
}

function publicRedactedInput(record) {
  if (!Array.isArray(record.input) || record.input.length === 0) return [];
  try {
    return redactBeepInput(record.input);
  } catch {
    return [];
  }
}

function publicRequest(record) {
  const response = {};
  for (const field of PUBLIC_REQUEST_FIELDS) {
    if (field === "runtimeResult") {
      response[field] = publicRuntimeResult(record[field]);
    } else if (field === "inputSummary") {
      response[field] = publicInputSummary(record);
    } else if (field === "redactedInput") {
      response[field] = publicRedactedInput(record);
    } else {
      response[field] = record[field] ?? null;
    }
  }
  return response;
}

function isValidRequestId(requestId) {
  return typeof requestId === "string" && requestId.trim() !== "" && !UNSAFE_REQUEST_IDS.has(requestId);
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method not allowed" });
}

export async function handleRequestRoute({ request, response, pathname, url, store, requireOperatorAuth }) {
  requireOperatorAuth(request);
  const parts = pathname.split("/").filter(Boolean);
  const requestId = parts[2] || null;

  if (request.method === "GET" && parts.length === 2) {
    const limit = parseLimit(url.searchParams.get("limit"));
    const runtimeId = url.searchParams.get("runtimeId") || null;
    const requests = store.listAgentRequests({ runtimeId, limit }).map(publicRequest);
    sendJson(response, 200, { ok: true, requests });
    return;
  }

  if (request.method === "GET" && parts.length === 3 && requestId) {
    if (!isValidRequestId(requestId)) {
      sendJson(response, 400, { ok: false, error: `Invalid requestId: ${requestId}` });
      return;
    }
    const agentRequest = store.getAgentRequest(requestId);
    if (!agentRequest) {
      sendJson(response, 404, { ok: false, error: `Unknown requestId: ${requestId}` });
      return;
    }
    sendJson(response, 200, { ok: true, request: publicRequest(agentRequest) });
    return;
  }

  if (parts.length === 2 || parts.length === 3) {
    sendMethodNotAllowed(response);
    return;
  }

  sendNotFound(response);
}
