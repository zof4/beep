const RUNTIME_STOPPED_ERROR = "runtime is not running";

function errorString(error) {
  return error instanceof Error ? error.message : String(error);
}

function generatedAtFrom(now) {
  const value = typeof now === "function" ? now() : new Date();
  return value instanceof Date ? value.toISOString() : String(value);
}

function projectFields(record, fields) {
  const projected = {};
  for (const field of fields) {
    projected[field] = record?.[field] ?? null;
  }
  return projected;
}

function projectAgentRequest(request) {
  return projectFields(request, [
    "requestId",
    "runtimeId",
    "runtimeRequestId",
    "status",
    "message",
    "error",
    "createdAt",
    "updatedAt",
  ]);
}

function projectApproval(approval) {
  return projectFields(approval, [
    "approvalId",
    "runtimeId",
    "toolCallId",
    "action",
    "status",
    "risk",
    "prompt",
    "createdAt",
    "updatedAt",
  ]);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnsafeStatusKey(key) {
  return (
    /path$/iu.test(key) ||
    /paths$/iu.test(key) ||
    key === "path" ||
    key === "workspace" ||
    key === "events" ||
    key === "lastAssistantText" ||
    key === "transcriptText" ||
    key === "rawPrompt" ||
    key === "messages" ||
    key === "promptResult" ||
    key === "stderrTail" ||
    key === "stdoutTail"
  );
}

function sanitizeOperationalObject(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeOperationalObject(entry));
  if (!isPlainObject(value)) return value;

  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isUnsafeStatusKey(key)) continue;
    sanitized[key] = sanitizeOperationalObject(nested);
  }
  return sanitized;
}

function summarizeAgentEvents(events) {
  if (!isPlainObject(events)) return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(events)) {
    if (key === "path") continue;
    sanitized[key] = sanitizeOperationalObject(value);
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function safeAgentSummary(agentSummaryResponse) {
  const summary = isPlainObject(agentSummaryResponse?.summary) ? agentSummaryResponse.summary : agentSummaryResponse;
  if (!isPlainObject(summary)) return null;

  const safe = {};
  for (const field of ["ok", "sessionId", "provider", "model", "thinking", "phase", "createdAt", "updatedAt"]) {
    if (summary[field] !== undefined) safe[field] = summary[field];
  }

  const events = summarizeAgentEvents(summary.events);
  if (events) safe.events = events;

  if (isPlainObject(summary.lcm)) {
    safe.lcm = sanitizeOperationalObject(summary.lcm);
  }

  return safe;
}

function agentSummaryPayload(agentSummaryResponse) {
  return isPlainObject(agentSummaryResponse?.summary) ? agentSummaryResponse.summary : agentSummaryResponse;
}

function lcmStatusFromResponse(response) {
  if (isPlainObject(response?.lcm)) return sanitizeOperationalObject(response.lcm);
  if (isPlainObject(response?.status)) return sanitizeOperationalObject(response.status);
  if (isPlainObject(response)) return sanitizeOperationalObject(response);
  return null;
}

function hindsightMemoryStatus(agentSummary) {
  const hindsightMemory = isPlainObject(agentSummary?.hindsightMemory) ? agentSummary.hindsightMemory : null;
  const latest = hindsightMemory?.latest !== undefined ? sanitizeOperationalObject(hindsightMemory.latest) : null;
  const telemetry = hindsightMemory?.telemetry !== undefined ? sanitizeOperationalObject(hindsightMemory.telemetry) : null;
  return {
    available: Boolean(hindsightMemory && (latest !== null || telemetry !== null)),
    latest,
    telemetry,
  };
}

function latestContextInjection(agentSummary) {
  const lcmContextInjection = isPlainObject(agentSummary?.lcmContextInjection) ? agentSummary.lcmContextInjection : null;
  if (lcmContextInjection?.latest === undefined) return null;
  return sanitizeOperationalObject(lcmContextInjection.latest);
}

function buildControlPlaneStatus({ store, toolBroker }) {
  return {
    recentRequests: store.listAgentRequests({ limit: 10 }).map(projectAgentRequest),
    pendingApprovals: store.listApprovals({ status: "pending", limit: 20 }).map(projectApproval),
    recentAudit: store.listAudit(25),
    tools: toolBroker.manifest(),
  };
}

export async function buildBackendStatus({
  store,
  runtimeManager,
  toolBroker,
  forwardRuntimeRequest,
  now = () => new Date().toISOString(),
}) {
  const generatedAt = generatedAtFrom(now);
  const controlPlane = buildControlPlaneStatus({ store, toolBroker });

  let runtime;
  try {
    runtime = await runtimeManager.status();
  } catch (error) {
    runtime = {
      running: false,
      error: errorString(error),
    };
  }

  const agent = {
    available: false,
    error: null,
    summary: null,
  };
  const memory = {
    lcm: {
      available: false,
      error: null,
      status: null,
      latestContextInjection: null,
    },
    hindsight: {
      available: false,
      latest: null,
      telemetry: null,
    },
  };

  if (!runtime?.running) {
    agent.error = runtime?.error || RUNTIME_STOPPED_ERROR;
    memory.lcm.error = runtime?.error || RUNTIME_STOPPED_ERROR;
    return {
      ok: true,
      schemaVersion: 1,
      generatedAt,
      runtime,
      agent,
      memory,
      controlPlane,
    };
  }

  let rawAgentSummary = null;
  try {
    const agentSummaryResponse = await forwardRuntimeRequest("/agent/summary");
    rawAgentSummary = agentSummaryPayload(agentSummaryResponse);
    agent.summary = safeAgentSummary(agentSummaryResponse);
    agent.available = true;
    memory.lcm.latestContextInjection = latestContextInjection(rawAgentSummary);
    memory.hindsight = hindsightMemoryStatus(rawAgentSummary);
  } catch (error) {
    agent.error = errorString(error);
  }

  try {
    const lcmResponse = await forwardRuntimeRequest("/agent/lcm/status");
    memory.lcm.status = lcmStatusFromResponse(lcmResponse);
    memory.lcm.available = true;
  } catch (error) {
    memory.lcm.error = errorString(error);
  }

  return {
    ok: true,
    schemaVersion: 1,
    generatedAt,
    runtime,
    agent,
    memory,
    controlPlane,
  };
}
