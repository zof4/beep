import { readJsonBody, sendJson } from "./http-utils.mjs";

const GET_ROUTES = new Map([
  ["/api/agent", "/agent"],
  ["/api/agent/summary", "/agent/summary"],
  ["/api/agent/requests", "/agent/requests"],
  ["/api/agent/lcm/status", "/agent/lcm/status"],
  ["/api/agent/lcm/doctor", "/agent/lcm/doctor"],
]);

const POST_ROUTES = new Map([
  ["/api/agent/lcm", "/agent/lcm"],
  ["/api/agent/lcm/compact", "/agent/lcm/compact"],
  ["/api/agent/lcm/maintain", "/agent/lcm/maintain"],
  ["/api/agent/lcm/backup", "/agent/lcm/backup"],
  ["/api/agent/lcm/assemble-preview", "/agent/lcm/assemble-preview"],
  ["/api/agent/lcm/rotate", "/agent/lcm/rotate"],
]);

function rawPathFromRequestTarget(requestTarget = "") {
  const rawTarget = String(requestTarget || "/");
  const withoutOrigin = rawTarget.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/u, "") || "/";
  return withoutOrigin.split(/[?#]/u, 1)[0] || "/";
}

function isRuntimeAgentPath(pathname) {
  return pathname === "/api/agent" || pathname?.startsWith("/api/agent/");
}

function unsafeEncodedPathError(requestTarget) {
  const rawPath = rawPathFromRequestTarget(requestTarget);
  for (const rawComponent of rawPath.split("/")) {
    let decodedComponent = "";
    try {
      decodedComponent = decodeURIComponent(rawComponent);
    } catch {
      return "unsafe encoded path component";
    }
    if (decodedComponent === "." || decodedComponent === "..") {
      return "unsafe encoded path component";
    }
    if (decodedComponent.includes("/") || decodedComponent.includes("\\")) {
      return "unsafe encoded path component";
    }
  }
  return null;
}

export function unsafeRuntimeAgentRequestTargetError(requestTarget, normalizedPathname = null) {
  const rawPath = rawPathFromRequestTarget(requestTarget);
  const needsValidation = isRuntimeAgentPath(rawPath) || isRuntimeAgentPath(normalizedPathname);
  return needsValidation ? unsafeEncodedPathError(requestTarget) : null;
}

function runtimeProxyErrorPayload(error) {
  const payload = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  const upstreamStatus = error?.upstreamStatus ?? error?.status;
  if (Number.isInteger(upstreamStatus)) {
    payload.upstreamStatus = upstreamStatus;
  }
  if (error?.payload !== undefined) {
    payload.upstream = error.payload;
  }
  return payload;
}

function routeFor(pathname, url) {
  if (pathname === "/api/agent/events") {
    return { method: "GET", runtimePath: `/agent/events${url.search}` };
  }
  if (GET_ROUTES.has(pathname)) {
    return { method: "GET", runtimePath: GET_ROUTES.get(pathname) };
  }
  if (POST_ROUTES.has(pathname)) {
    return { method: "POST", runtimePath: POST_ROUTES.get(pathname) };
  }

  const requestMatch = pathname.match(/^\/api\/agent\/requests\/([^/]+)$/u);
  if (requestMatch) {
    return { method: "GET", runtimePath: `/agent/requests/${requestMatch[1]}` };
  }

  return null;
}

export async function handleRuntimeAgentRoute({
  request,
  response,
  pathname,
  url,
  requireOperatorAuth,
  forwardRuntimeRequest,
}) {
  requireOperatorAuth(request);

  const unsafePathError = unsafeRuntimeAgentRequestTargetError(request.url, pathname);
  if (unsafePathError) {
    sendJson(response, 400, { ok: false, error: unsafePathError });
    return;
  }

  const route = routeFor(pathname, url);
  if (!route) {
    sendJson(response, 404, { ok: false, error: "not found" });
    return;
  }

  if (request.method !== route.method) {
    sendJson(response, 405, { ok: false, error: "method not allowed" });
    return;
  }

  const options = { method: route.method };
  if (route.method === "POST") {
    options.body = await readJsonBody(request);
  }

  let result = null;
  try {
    result = await forwardRuntimeRequest(route.runtimePath, options);
  } catch (error) {
    sendJson(response, 502, runtimeProxyErrorPayload(error));
    return;
  }
  sendJson(response, result?.ok === false ? 502 : 200, result);
}
