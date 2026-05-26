import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { DEFAULT_REQUEST_TIMEOUT_MS, HOST, PORT, RUNTIME_AUTH_PATH, RUNTIME_ID } from "./config.mjs";
import { handleApprovalRoute } from "./approval-routes.mjs";
import { parseRequestUrl, readJsonBody, sendJson, sendNotFound, statusFromError } from "./http-utils.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";
import { handleSiteRoute } from "./site-routes.mjs";
import { StateStore } from "./state-store.mjs";
import { ToolBroker, hostPortForContainerPort, validatePreviewPort } from "./tool-broker.mjs";

const store = new StateStore();
const runtimeManager = new RuntimeManager({ store });
const toolBroker = new ToolBroker({ store });

function requireRuntimeAuth(request) {
  const expected = `Bearer ${store.ensureRuntimeToken()}`;
  if (request.headers.authorization !== expected) {
    const error = new Error("runtime capability token is invalid");
    error.status = 401;
    throw error;
  }
}

function requireOperatorAuth(request) {
  const expected = `Bearer ${store.ensureOperatorToken()}`;
  if (request.headers.authorization !== expected) {
    const error = new Error("operator token is invalid");
    error.status = 401;
    throw error;
  }
}

function loadControlPlaneAccessToken() {
  const auth = JSON.parse(readFileSync(RUNTIME_AUTH_PATH, "utf8"));
  const token = auth?.tokens?.access_token || auth?.OPENAI_API_KEY || auth?.apiKey;
  if (typeof token !== "string" || token.length === 0) {
    const error = new Error(`${RUNTIME_AUTH_PATH} does not contain tokens.access_token or OPENAI_API_KEY.`);
    error.status = 503;
    throw error;
  }
  return token;
}

async function forwardRuntimeRequest(path, { method = "GET", body = null } = {}) {
  const headers = body ? { "content-type": "application/json" } : {};
  return runtimeManager.proxyToRuntime(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function proxyLocalPort(request, response, hostPort, suffixPath) {
  const targetBase = new URL(request.url || "/", `http://127.0.0.1:${hostPort}`);
  const targetPath = `/${suffixPath || ""}${targetBase.search}`;
  const options = {
    protocol: targetBase.protocol,
    hostname: targetBase.hostname,
    port: targetBase.port,
    method: request.method,
    path: targetPath,
    headers: {
      ...request.headers,
      host: `${targetBase.hostname}:${targetBase.port}`,
    },
  };
  const client = targetBase.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = client(options, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    sendJson(response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hint: "Make sure the dev server is running in the runtime container and bound to 0.0.0.0.",
    });
  });
  request.pipe(upstream);
}

async function proxyPreview(request, response, runtimeId, containerPort, suffixPath) {
  if (runtimeId !== RUNTIME_ID) {
    sendJson(response, 404, { ok: false, error: `Unknown runtimeId: ${runtimeId}` });
    return;
  }
  validatePreviewPort(containerPort);
  await proxyLocalPort(request, response, hostPortForContainerPort(containerPort), suffixPath);
}

async function handle(request, response) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const url = parseRequestUrl(request);
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      service: "beep-control-plane",
      runtimeId: RUNTIME_ID,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/tools") {
    sendJson(response, 200, { ok: true, ...toolBroker.manifest() });
    return;
  }

  if (request.method === "GET" && pathname === "/api/audit") {
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1000);
    sendJson(response, 200, { ok: true, audit: store.listAudit(limit) });
    return;
  }

  if (request.method === "GET" && pathname === `/api/runtimes/${RUNTIME_ID}`) {
    sendJson(response, 200, { ok: true, runtime: await runtimeManager.status() });
    return;
  }

  if (request.method === "POST" && pathname === `/api/runtimes/${RUNTIME_ID}/start`) {
    requireOperatorAuth(request);
    sendJson(response, 200, { ok: true, runtime: await runtimeManager.ensureRuntime({ rebuild: true }) });
    return;
  }

  if (request.method === "POST" && pathname === `/api/runtimes/${RUNTIME_ID}/stop`) {
    requireOperatorAuth(request);
    sendJson(response, 200, { ok: true, runtime: await runtimeManager.stopRuntime() });
    return;
  }

  if (pathname === "/api/approvals" || pathname.startsWith("/api/approvals/")) {
    await handleApprovalRoute({
      request,
      response,
      pathname,
      url,
      store,
      toolBroker,
      requireOperatorAuth,
    });
    return;
  }

  if (pathname === "/api/sites" || pathname.startsWith("/api/sites/")) {
    await handleSiteRoute({
      request,
      response,
      pathname,
      url,
      store,
      requireOperatorAuth,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/requests") {
    const body = await readJsonBody(request);
    await runtimeManager.ensureRuntime();
    const runtimeBody = {
      message: String(body.message || ""),
      waitForCompletion: body.waitForCompletion !== false,
      timeoutMs: Number(body.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS),
    };
    const result = await forwardRuntimeRequest("/agent/submit", { method: "POST", body: runtimeBody });
    sendJson(response, 200, { ok: true, result });
    return;
  }

  if (request.method === "GET" && pathname === "/api/agent") {
    sendJson(response, 200, { ok: true, agent: await forwardRuntimeRequest("/agent") });
    return;
  }

  if (request.method === "GET" && pathname === "/api/agent/events") {
    sendJson(response, 200, await forwardRuntimeRequest(`/agent/events${url.search}`));
    return;
  }

  if (request.method === "GET" && pathname === "/api/agent/summary") {
    sendJson(response, 200, await forwardRuntimeRequest("/agent/summary"));
    return;
  }

  if (request.method === "POST" && pathname === "/internal/model/credential") {
    requireRuntimeAuth(request);
    const body = await readJsonBody(request);
    const token = loadControlPlaneAccessToken();
    store.appendAudit({
      kind: "model_credential",
      runtimeId: RUNTIME_ID,
      provider: body.provider || "openai-codex",
      model: body.model || null,
      runtimeSessionId: body.runtimeSessionId || null,
      decision: "allow",
    });
    sendJson(response, 200, {
      ok: true,
      apiKey: token,
      source: "control-plane-dev-auth",
      expiresAt: null,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/internal/tools/call") {
    requireRuntimeAuth(request);
    const body = await readJsonBody(request);
    const result = await toolBroker.call(body);
    sendJson(response, result.ok ? 200 : result.status === "needs_review" ? 202 : 403, result);
    return;
  }

  const previewMatch = pathname.match(/^\/preview\/([^/]+)\/(\d+)(?:\/(.*))?$/u);
  if (previewMatch) {
    await proxyPreview(request, response, previewMatch[1], Number(previewMatch[2]), previewMatch[3] || "");
    return;
  }

  const siteMatch = pathname.match(/^\/sites\/([^/]+)(?:\/(.*))?$/u);
  if (siteMatch) {
    const site = store.getSite(siteMatch[1]);
    if (!site) {
      sendJson(response, 404, { ok: false, error: `Unknown siteId: ${siteMatch[1]}` });
      return;
    }
    if (site.status === "stopped") {
      sendJson(response, 410, { ok: false, error: `Site is stopped: ${siteMatch[1]}` });
      return;
    }
    await proxyLocalPort(request, response, Number(site.hostPort), siteMatch[2] || "");
    return;
  }

  sendNotFound(response);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    const status = statusFromError(error);
    sendJson(response, status, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

server.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

server.listen(PORT, HOST, async () => {
  store.ensure();
  store.ensureRuntimeToken();
  store.ensureOperatorToken();
  console.log(`beep-control-plane listening on http://${HOST}:${PORT}`);
  if (process.env.BEEP_CONTROL_PLANE_AUTOSTART === "1") {
    try {
      await runtimeManager.ensureRuntime({ rebuild: true });
      console.log(`runtime ${RUNTIME_ID} is ready`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
});
