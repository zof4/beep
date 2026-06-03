import { sendJson, sendNotFound } from "./http-utils.mjs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PUBLIC_REQUEST_FIELDS = [
  "schemaVersion",
  "requestId",
  "runtimeId",
  "runtimeRequestId",
  "message",
  "status",
  "source",
  "error",
  "runtimeResult",
  "createdAt",
  "updatedAt",
];

function parseLimit(value) {
  if (!value) return DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/u.test(value)) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return Math.min(parsed, MAX_LIMIT);
}

function publicRequest(record) {
  const response = {};
  for (const field of PUBLIC_REQUEST_FIELDS) {
    response[field] = record[field] ?? null;
  }
  return response;
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
