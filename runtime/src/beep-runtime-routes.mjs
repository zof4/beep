import {
  API_AGENTS_DIR,
  API_HOST,
  API_PORT,
  API_SESSIONS_DIR,
  API_STATE_DIR,
  API_WORKSPACE_DIR,
  ensureDir,
} from "./runtime-common.mjs";
import { devEndpointDisabled, jsonResponse, routeError } from "./http-utils.mjs";
import { handleAgentRoute } from "./routes/agent-routes.mjs";
import { handleCreateSession, handleRun, handleSessionRoute, listSessionStatuses } from "./routes/dev-routes.mjs";
import { handleInternalRoute } from "./routes/internal-lcm-routes.mjs";
import { handleCapabilities, handleHealth } from "./routes/system-routes.mjs";

export { routeError } from "./http-utils.mjs";

export function createDispatcher({ sessions, agentSupervisor, lcmController }) {
  ensureDir(API_STATE_DIR);
  ensureDir(API_SESSIONS_DIR);
  ensureDir(API_AGENTS_DIR);
  ensureDir(API_WORKSPACE_DIR);

  return async function dispatch(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${API_HOST}:${API_PORT}`}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const context = { sessions, agentSupervisor, lcmController };

    if (req.method === "GET" && url.pathname === "/health") {
      await handleHealth(req, res, agentSupervisor);
      return;
    }
    if (req.method === "GET" && url.pathname === "/capabilities") {
      await handleCapabilities(req, res, agentSupervisor);
      return;
    }
    if (url.pathname === "/sessions" && req.method === "GET") {
      if (devEndpointDisabled(res)) return;
      jsonResponse(res, 200, { ok: true, sessions: listSessionStatuses(sessions) });
      return;
    }
    if (url.pathname === "/sessions" && req.method === "POST") {
      if (devEndpointDisabled(res)) return;
      await handleCreateSession(req, res, context);
      return;
    }
    if (url.pathname === "/runs" && req.method === "POST") {
      if (devEndpointDisabled(res)) return;
      await handleRun(req, res, context);
      return;
    }
    if (parts[0] === "internal") {
      await handleInternalRoute(req, res, url, parts, context);
      return;
    }
    if (parts[0] === "agent") {
      await handleAgentRoute(req, res, url, parts, context);
      return;
    }
    if (parts[0] === "sessions") {
      if (devEndpointDisabled(res)) return;
      await handleSessionRoute(req, res, url, parts, context);
      return;
    }
    routeError(res, 404, `Unknown route: ${req.method} ${url.pathname}`);
  };
}
