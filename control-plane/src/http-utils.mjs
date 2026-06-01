import { HOST, PORT, PUBLIC_BASE_URL } from "./config.mjs";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function corsOrigin() {
  try {
    return new URL(process.env.BEEP_CONTROL_PLANE_CORS_ORIGIN || PUBLIC_BASE_URL).origin;
  } catch {
    return `http://${HOST}:${PORT}`;
  }
}

export function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": corsOrigin(),
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    vary: "Origin",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

export function sendNotFound(response) {
  sendJson(response, 404, { ok: false, error: "not found" });
}

export function parseRequestUrl(request) {
  const url = request.url || "/";
  try {
    return new URL(url, `http://${request.headers?.host || `${HOST}:${PORT}`}`);
  } catch {
    try {
      return new URL(url, `http://${HOST}:${PORT}`);
    } catch {
      return new URL("/", `http://${HOST}:${PORT}`);
    }
  }
}

export async function readJsonBody(request, limitBytes = 1024 * 1024) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > limitBytes) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  let body = "";
  try {
    body = utf8Decoder.decode(Buffer.concat(chunks, totalBytes));
  } catch (error) {
    const decodeError = new Error(`invalid UTF-8 body: ${error instanceof Error ? error.message : String(error)}`);
    decodeError.status = 400;
    throw decodeError;
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
  const status = error?.status;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return Number.isInteger(fallback) && fallback >= 400 && fallback <= 599 ? fallback : 500;
}
