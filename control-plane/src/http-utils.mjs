import { HOST, PORT } from "./config.mjs";

export function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

export function sendNotFound(response) {
  sendJson(response, 404, { ok: false, error: "not found" });
}

export function parseRequestUrl(request) {
  return new URL(request.url || "/", `http://${request.headers.host || `${HOST}:${PORT}`}`);
}

export async function readJsonBody(request, limitBytes = 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > limitBytes) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    const parseError = new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
    parseError.status = 400;
    throw parseError;
  }
}

export function statusFromError(error, fallback = 500) {
  return Number.isInteger(error?.status) ? error.status : fallback;
}
