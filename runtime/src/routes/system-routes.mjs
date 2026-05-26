import { existsSync } from "node:fs";
import {
  API_SESSIONS_DIR,
  API_STATE_DIR,
  API_WORKSPACE_DIR,
  CODEX_HOME,
  CONTROL_PLANE_RUNTIME_TOKEN,
  CONTROL_PLANE_TOOL_TIMEOUT_MS,
  CONTROL_PLANE_TOOLS_ENABLED,
  CONTROL_PLANE_TOOLS_EXTENSION_PATH,
  CONTROL_PLANE_URL,
  DEV_ENDPOINTS_ENABLED,
  LCM_CONTEXT_ENABLED,
  LCM_CONTEXT_EXTENSION_PATH,
  LCM_LIFECYCLE_URL,
  LCM_CONTEXT_TIMEOUT_MS,
  LCM_CONTEXT_TOKEN_BUDGET,
  LCM_RECALL_TOOL_TIMEOUT_MS,
  LCM_RECALL_TOOL_URL,
  LCM_RECALL_TOOLS_ENABLED,
  LCM_RECALL_TOOLS_EXTENSION_PATH,
  MODEL_GATEWAY_CREDENTIAL_URL,
  PI_ROOT,
  RUNTIME_CODEX_AUTH_COMPAT_ENABLED,
  STATE_DIR,
  WORKSPACE_DIR,
  loadRuntimeConfig,
  nowIso,
} from "../runtime-common.mjs";
import { jsonResponse } from "../http-utils.mjs";

export const AGENT_ENDPOINTS = [
  "GET /health",
  "GET /capabilities",
  "GET /agent",
  "POST /agent/start",
  "POST /agent/submit",
  "GET /agent/requests",
  "GET /agent/requests/:id",
  "GET /agent/events",
  "GET /agent/summary",
  "POST /agent/steer",
  "POST /agent/follow-up",
  "POST /agent/abort",
  "POST /agent/pause",
  "POST /agent/resume",
  "POST /agent/lcm",
  "GET /agent/lcm/status",
  "POST /agent/lcm/compact",
  "POST /agent/lcm/assemble-preview",
  "POST /agent/lcm/maintain",
  "POST /agent/lcm/rotate",
  "POST /agent/lcm/backup",
  "POST /agent/lcm/reset",
  "GET /agent/lcm/doctor",
  "POST /agent/stop",
];

export const DEV_ENDPOINTS = [
  "GET /sessions",
  "POST /sessions",
  "GET /sessions/:id",
  "GET /sessions/:id/events",
  "GET /sessions/:id/summary",
  "POST /sessions/:id/prompt",
  "POST /sessions/:id/steer",
  "POST /sessions/:id/follow-up",
  "POST /sessions/:id/abort",
  "POST /sessions/:id/rpc",
  "POST /sessions/:id/lcm",
  "DELETE /sessions/:id",
  "POST /runs",
];

const PI_RPC_COMMANDS = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "set_model",
  "get_available_models",
  "set_thinking_level",
  "compact",
  "set_auto_compaction",
  "bash",
  "get_session_stats",
  "get_messages",
  "get_last_assistant_text",
  "get_commands",
];

function authMode() {
  if (MODEL_GATEWAY_CREDENTIAL_URL) return "model-gateway";
  if (RUNTIME_CODEX_AUTH_COMPAT_ENABLED) return "runtime-codex-auth-compat";
  return "unconfigured";
}

export async function handleHealth(_req, res, agentSupervisor) {
  const agent = agentSupervisor.status();
  jsonResponse(res, 200, {
    ok: true,
    service: "beep-agentd",
    time: nowIso(),
    agent: {
      id: agent.id,
      paused: agent.paused,
      queueDepth: agent.queueDepth,
      activeRequestId: agent.activeRequestId,
      sessionPhase: agent.session?.phase || null,
      lastError: agent.lastError,
    },
  });
}

export async function handleCapabilities(_req, res, agentSupervisor) {
  const runtimeConfig = loadRuntimeConfig();
  jsonResponse(res, 200, {
    ok: true,
    schemaVersion: 1,
    runner: {
      harness: "pi",
      transport: "pi-rpc",
      provider: "openai-codex",
      auth: authMode(),
      codexEndpoint: "https://chatgpt.com/backend-api/codex/responses",
    },
    daemon: {
      name: "beep-agentd",
      agentId: agentSupervisor.id,
      autostart: agentSupervisor.status().autostart,
      role: "Long-running Beep agent supervisor inside the runtime container.",
    },
    lcmContext: {
      enabled: LCM_CONTEXT_ENABLED,
      extensionPath: LCM_CONTEXT_EXTENSION_PATH,
      tokenBudget: Number(LCM_CONTEXT_TOKEN_BUDGET),
      timeoutMs: Number(LCM_CONTEXT_TIMEOUT_MS),
      route: "POST /internal/lcm/context",
      lifecycleRoute: "POST /internal/lcm/lifecycle",
      lifecycleUrl: LCM_LIFECYCLE_URL,
    },
    lcmRecallTools: {
      enabled: LCM_RECALL_TOOLS_ENABLED,
      extensionPath: LCM_RECALL_TOOLS_EXTENSION_PATH,
      tools: ["lcm_grep", "lcm_describe", "lcm_expand_query"],
      delegatedTools: ["lcm_grep", "lcm_describe", "lcm_expand"],
      timeoutMs: Number(LCM_RECALL_TOOL_TIMEOUT_MS),
      route: "POST /internal/lcm/tool",
      url: LCM_RECALL_TOOL_URL,
    },
    controlPlaneTools: {
      enabled: CONTROL_PLANE_TOOLS_ENABLED,
      extensionPath: CONTROL_PLANE_TOOLS_EXTENSION_PATH,
      extensionLoaded:
        CONTROL_PLANE_TOOLS_ENABLED &&
        Boolean(CONTROL_PLANE_URL) &&
        Boolean(CONTROL_PLANE_RUNTIME_TOKEN) &&
        existsSync(CONTROL_PLANE_TOOLS_EXTENSION_PATH),
      url: CONTROL_PLANE_URL || null,
      timeoutMs: Number(CONTROL_PLANE_TOOL_TIMEOUT_MS),
      tools: ["preview_port_expose", "preview_container_create_static_site", "web_search", "web_fetch"],
    },
    dev: {
      endpointsEnabled: DEV_ENDPOINTS_ENABLED,
      endpoints: DEV_ENDPOINTS_ENABLED ? DEV_ENDPOINTS : [],
    },
    current: runtimeConfig,
    paths: {
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      apiStateDir: API_STATE_DIR,
      apiSessionsDir: API_SESSIONS_DIR,
      apiWorkspaceDir: API_WORKSPACE_DIR,
      piRoot: PI_ROOT,
      codexHome: CODEX_HOME,
    },
    endpoints: DEV_ENDPOINTS_ENABLED ? [...AGENT_ENDPOINTS, ...DEV_ENDPOINTS] : AGENT_ENDPOINTS,
    piRpcCommands: PI_RPC_COMMANDS,
  });
}
