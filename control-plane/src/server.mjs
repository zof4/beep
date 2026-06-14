import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { DEFAULT_REQUEST_TIMEOUT_MS, HOST, PORT, RUNTIME_AUTH_PATH, RUNTIME_ID } from "./config.mjs";
import { handleApprovalRoute } from "./approval-routes.mjs";
import { buildBackendStatus } from "./backend-status.mjs";
import { resolveCodexCredentialFromAuthPath } from "./codex-token.mjs";
import { parseRequestUrl, readJsonBody, sendJson, sendNotFound, statusFromError } from "./http-utils.mjs";
import { handleNotesDemoRoute } from "./notes/demo-web.mjs";
import { handleNotesRoute } from "./notes/routes.mjs";
import { buildLocalProxyOptions } from "./proxy-utils.mjs";
import { handleRequestRoute } from "./request-routes.mjs";
import { handleRuntimeAgentRoute, unsafeRuntimeAgentRequestTargetError } from "./runtime-agent-routes.mjs";
import { RuntimeManager } from "./runtime-manager.mjs";
import { handleSiteRoute } from "./site-routes.mjs";
import { StateStore } from "./state-store.mjs";
import { ToolBroker, hostPortForContainerPort, validatePreviewPort } from "./tool-broker.mjs";
import { Gatekeeper } from "./gatekeeper/index.mjs";

export function createDefaultComponents() {
  const store = new StateStore();
  const runtimeManager = new RuntimeManager({ store });
  const gatekeeper = new Gatekeeper({ store });
  const toolBroker = new ToolBroker({ store, gatekeeper });
  return { store, runtimeManager, gatekeeper, toolBroker };
}

async function proxyLocalPort(request, response, hostPort, suffixPath) {
  const options = buildLocalProxyOptions(request, hostPort, suffixPath);
  const upstream = httpRequest(options, (upstreamResponse) => {
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

function matchingExposure(store, runtimeId, containerPort) {
  const exposure = store.readState().exposures?.[`${runtimeId}:${containerPort}`] || null;
  if (!exposure || exposure.runtimeId !== runtimeId || Number(exposure.containerPort) !== containerPort) return null;
  const expectedHostPort = hostPortForContainerPort(containerPort);
  if (Number(exposure.hostPort) !== expectedHostPort) return null;
  return { ...exposure, hostPort: expectedHostPort };
}

export function createControlPlaneHandler({ store, runtimeManager, toolBroker, localPortProxy = proxyLocalPort }) {
  function requireRuntimeAuth(request) {
    const expected = `Bearer ${store.ensureRuntimeToken()}`;
    if (request.headers.authorization !== expected) {
      const error = new Error("runtime capability token is invalid");
      error.status = 401;
      throw error;
    }
  }

  function requireModelCredentialAuth(request) {
    const expected = `Bearer ${store.ensureModelCredentialToken()}`;
    if (request.headers.authorization !== expected) {
      const error = new Error("model credential capability token is invalid");
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

  async function forwardRuntimeRequest(path, { method = "GET", body = null } = {}) {
    const headers = body ? { "content-type": "application/json" } : {};
    return runtimeManager.proxyToRuntime(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function proxyPreview(request, response, runtimeId, containerPort, suffixPath) {
    if (runtimeId !== RUNTIME_ID) {
      sendJson(response, 404, { ok: false, error: `Unknown runtimeId: ${runtimeId}` });
      return;
    }
    validatePreviewPort(containerPort);
    const exposure = matchingExposure(store, runtimeId, containerPort);
    if (!exposure) {
      sendJson(response, 404, { ok: false, error: `Unknown preview exposure: ${runtimeId}:${containerPort}` });
      return;
    }
    if (exposure.status === "stopped") {
      sendJson(response, 410, { ok: false, error: `Preview exposure is stopped: ${runtimeId}:${containerPort}` });
      return;
    }
    await localPortProxy(request, response, exposure.hostPort, suffixPath);
  }

  async function handle(request, response) {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    const url = parseRequestUrl(request);
    const pathname = url.pathname.replace(/\/+$/u, "") || "/";
    const unsafeAgentPathError = unsafeRuntimeAgentRequestTargetError(request.url, pathname);
    if (unsafeAgentPathError) {
      sendJson(response, 400, { ok: false, error: unsafeAgentPathError });
      return;
    }

    if (pathname === "/notes" || pathname.startsWith("/notes/")) {
      if (handleNotesDemoRoute({ request, response, pathname })) return;
    }

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
      requireOperatorAuth(request);
      const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1000);
      sendJson(response, 200, { ok: true, audit: store.listAudit(limit) });
      return;
    }

    if (request.method === "GET" && pathname === "/api/backend/status") {
      requireOperatorAuth(request);
      sendJson(
        response,
        200,
        await buildBackendStatus({
          store,
          runtimeManager,
          toolBroker,
          forwardRuntimeRequest,
        }),
      );
      return;
    }

    if (request.method === "GET" && pathname === `/api/runtimes/${RUNTIME_ID}`) {
      requireOperatorAuth(request);
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

    if (request.method === "POST" && pathname === "/api/requests") {
      requireOperatorAuth(request);
      const body = await readJsonBody(request);
      await runtimeManager.ensureRuntime();
      const controlPlaneRequest = store.createAgentRequest({
        runtimeId: RUNTIME_ID,
        message: String(body.message || ""),
        status: "forwarding",
        source: "api",
      });
      const runtimeBody = {
        message: String(body.message || ""),
        waitForCompletion: body.waitForCompletion !== false,
        timeoutMs: Number(body.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS),
      };
      try {
        const result = await forwardRuntimeRequest("/agent/submit", { method: "POST", body: runtimeBody });
        store.updateAgentRequest(controlPlaneRequest.requestId, {
          status: result?.ok === false ? "failed" : "submitted",
          runtimeRequestId: result?.request?.id || null,
          runtimeResult: result,
          error: result?.ok === false ? result?.error || result?.request?.error || "Runtime request failed." : null,
        });
        sendJson(response, 200, { ok: true, requestId: controlPlaneRequest.requestId, result });
      } catch (error) {
        store.updateAgentRequest(controlPlaneRequest.requestId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return;
    }

    if (pathname === "/api/requests" || pathname.startsWith("/api/requests/")) {
      await handleRequestRoute({
        request,
        response,
        pathname,
        url,
        store,
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

    if (pathname === "/api/notes" || pathname.startsWith("/api/notes/")) {
      const handled = await handleNotesRoute({
        request,
        response,
        pathname,
        store,
        requireOperatorAuth,
        forwardRuntimeRequest,
      });
      if (handled) return;
    }

    if (pathname === "/api/agent" || pathname.startsWith("/api/agent/")) {
      await handleRuntimeAgentRoute({
        request,
        response,
        pathname,
        url,
        requireOperatorAuth,
        forwardRuntimeRequest,
      });
      return;
    }

    if (request.method === "POST" && pathname === "/internal/model/credential") {
      requireModelCredentialAuth(request);
      const body = await readJsonBody(request);
      const credential = await resolveCodexCredentialFromAuthPath(RUNTIME_AUTH_PATH);
      store.appendAudit({
        kind: "model_credential",
        runtimeId: RUNTIME_ID,
        provider: body.provider || "openai-codex",
        model: body.model || null,
        runtimeSessionId: body.runtimeSessionId || null,
        decision: "allow",
        source: credential.source,
      });
      sendJson(response, 200, {
        ok: true,
        apiKey: credential.apiKey,
        source: credential.source,
        expiresAt: credential.expiresAt,
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
      await localPortProxy(request, response, Number(site.hostPort), siteMatch[2] || "");
      return;
    }

    sendNotFound(response);
  }

  return async function controlPlaneHandler(request, response) {
    try {
      await handle(request, response);
    } catch (error) {
      const status = statusFromError(error);
      sendJson(response, status, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function createControlPlaneServer(components = createDefaultComponents()) {
  const handler = createControlPlaneHandler(components);
  const server = createServer(handler);
  return { server, handler, ...components };
}

export function startControlPlaneServer() {
  const { server, store, runtimeManager } = createControlPlaneServer();

  server.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });

  server.listen(PORT, HOST, async () => {
    store.ensure();
    store.ensureRuntimeToken();
    store.ensureRuntimeApiToken();
    store.ensureModelCredentialToken();
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

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startControlPlaneServer();
}
