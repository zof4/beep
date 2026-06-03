const RUNTIME_STOPPED_ERROR = "runtime is not running";
const UNSAFE_RUNTIME_STATUS_KEYS = new Set([
  "cwd",
  "events",
  "lastassistanttext",
  "finalassistanttext",
  "assistantfinaltext",
  "assistanttext",
  "assistantmessage",
  "finaltext",
  "contextprojection",
  "systempromptaddition",
  "transcript",
  "transcripttext",
  "rawprompt",
  "history",
  "messages",
  "conversations",
  "promptresult",
  "stderrtail",
  "stdouttail",
  "workspace",
]);
const UNSAFE_RUNTIME_STATUS_SUFFIXES = [
  "path",
  "paths",
  "root",
  "roots",
  "dir",
  "dirs",
  "directory",
  "directories",
  "file",
  "files",
  "log",
  "logs",
  "tail",
  "tails",
];
const UNSAFE_RUNTIME_STATUS_SUFFIX_PATTERN =
  /(?:^|[_-])(path|paths|root|roots|dir|dirs|directory|directories|file|files|log|logs|tail|tails)$|(?:Path|Paths|Root|Roots|Dir|Dirs|Directory|Directories|File|Files|Log|Logs|Tail|Tails)$/u;
const COMMON_ABSOLUTE_PATH_PATTERN =
  /(?<![:/])\/(?:workspace|state|lcm|runtime|history|tmp|var|private|Users)(?:\/(?:[A-Z][A-Za-z0-9._~@%+=:-]*(?: [A-Z][A-Za-z0-9._~@%+=:-]*)+|[A-Za-z0-9._~@%+=:-]+))+/gu;
const FILE_URL_ABSOLUTE_PATH_PATTERN = /file:\/\/\/[^\s"'`<>{}|\\^$[\];,]+/gu;
const UNIX_ABSOLUTE_PATH_PATTERN = /(?<![:/])\/[^\s"'`<>{}|\\^$[\];,]+/gu;

function errorString(error) {
  return error instanceof Error ? error.message : String(error);
}

function redactRuntimeString(value) {
  return String(value)
    .replace(FILE_URL_ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(COMMON_ABSOLUTE_PATH_PATTERN, "[redacted-path]")
    .replace(UNIX_ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function runtimeErrorString(error) {
  return redactRuntimeString(errorString(error));
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
  const projected = projectFields(request, [
    "requestId",
    "runtimeId",
    "runtimeRequestId",
    "status",
    "message",
    "error",
    "createdAt",
    "updatedAt",
  ]);
  if (projected.error !== null) projected.error = redactRuntimeString(projected.error);
  return projected;
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
  const compact = String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return (
    UNSAFE_RUNTIME_STATUS_KEYS.has(compact) ||
    UNSAFE_RUNTIME_STATUS_SUFFIXES.includes(compact) ||
    UNSAFE_RUNTIME_STATUS_SUFFIX_PATTERN.test(String(key))
  );
}

function isScalarTelemetry(value) {
  return value === null || typeof value === "number" || typeof value === "boolean";
}

function sanitizeOperationalObject(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeOperationalObject(entry));
  if (typeof value === "string") return redactRuntimeString(value);
  if (!isPlainObject(value)) return value;

  const sanitized = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isUnsafeStatusKey(key)) {
      if (isScalarTelemetry(nested)) sanitized[key] = nested;
      continue;
    }
    sanitized[key] = sanitizeOperationalObject(nested);
  }
  return sanitized;
}

function summarizeAgentEvents(events) {
  if (!isPlainObject(events)) return null;
  const sanitized = {};
  for (const [key, value] of Object.entries(events)) {
    if (isUnsafeStatusKey(key)) continue;
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
  if (isPlainObject(response) && Object.hasOwn(response, "lcm")) {
    return isPlainObject(response.lcm) ? sanitizeOperationalObject(response.lcm) : null;
  }
  if (isPlainObject(response) && isPlainObject(response.status)) {
    return sanitizeOperationalObject(response.status);
  }
  if (isPlainObject(response)) return sanitizeOperationalObject(response);
  return null;
}

function runtimePayloadError(response, fallback) {
  return redactRuntimeString(response?.error || response?.message || fallback);
}

function hindsightMemoryStatus(agentSummary) {
  const hindsightMemory = isPlainObject(agentSummary?.hindsightMemory) ? agentSummary.hindsightMemory : null;
  const latest = hindsightMemory?.latest !== undefined ? sanitizeOperationalObject(hindsightMemory.latest) : null;
  let telemetry = hindsightMemory?.telemetry !== undefined ? sanitizeOperationalObject(hindsightMemory.telemetry) : null;
  const aggregateTelemetry = {};
  for (const field of ["enabled", "total", "byKind", "failures"]) {
    if (hindsightMemory?.[field] !== undefined) aggregateTelemetry[field] = sanitizeOperationalObject(hindsightMemory[field]);
  }
  if (Object.keys(aggregateTelemetry).length > 0) {
    telemetry = {
      ...(isPlainObject(telemetry) ? telemetry : {}),
      ...aggregateTelemetry,
    };
  }
  return {
    available: Boolean(hindsightMemory && (latest !== null || telemetry !== null)),
    latest,
    telemetry: telemetry && Object.keys(telemetry).length > 0 ? telemetry : null,
  };
}

function latestContextInjection(agentSummary) {
  const lcmContextInjection = isPlainObject(agentSummary?.lcmContextInjection) ? agentSummary.lcmContextInjection : null;
  if (lcmContextInjection?.latest === undefined) return null;
  return sanitizeOperationalObject(lcmContextInjection.latest);
}

function publicRuntimeStatus(runtime) {
  return sanitizeOperationalObject(runtime);
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
    runtime = publicRuntimeStatus(await runtimeManager.status());
  } catch (error) {
    runtime = publicRuntimeStatus({
      running: false,
      error: runtimeErrorString(error),
    });
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
    if (agentSummaryResponse?.ok === false) {
      agent.error = runtimePayloadError(agentSummaryResponse, "runtime summary unavailable");
    } else {
      rawAgentSummary = agentSummaryPayload(agentSummaryResponse);
      agent.summary = safeAgentSummary(agentSummaryResponse);
      agent.available = true;
      memory.lcm.latestContextInjection = latestContextInjection(rawAgentSummary);
      memory.hindsight = hindsightMemoryStatus(rawAgentSummary);
    }
  } catch (error) {
    agent.error = runtimeErrorString(error);
  }

  try {
    const lcmResponse = await forwardRuntimeRequest("/agent/lcm/status");
    if (lcmResponse?.ok === false) {
      memory.lcm.error = runtimePayloadError(lcmResponse, "runtime LCM status unavailable");
    } else {
      memory.lcm.status = lcmStatusFromResponse(lcmResponse);
      if (memory.lcm.status) {
        memory.lcm.available = true;
      } else {
        memory.lcm.error = "runtime LCM status unavailable";
      }
    }
  } catch (error) {
    memory.lcm.error = runtimeErrorString(error);
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
