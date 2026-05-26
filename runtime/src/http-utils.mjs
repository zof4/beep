import { DEV_ENDPOINTS_ENABLED, MAX_REQUEST_BYTES } from "./runtime-common.mjs";

export function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function textResponse(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function routeError(res, status, message, details = undefined) {
  jsonResponse(res, status, { ok: false, error: message, ...(details ? { details } : {}) });
}

export async function readRequestJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`), {
      statusCode: 400,
    });
  }
}

export function devEndpointDisabled(res) {
  if (DEV_ENDPOINTS_ENABLED) return false;
  routeError(res, 404, "This endpoint is available only when BEEP_RUNTIME_DEV_ENDPOINTS=1.");
  return true;
}
