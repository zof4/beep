import { RUNTIME_API_URL } from "../config.mjs";
import { RuntimeManager } from "../runtime-manager.mjs";

function textFromValue(value, maxChars = 20_000) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function textFromInputSummary(inputSummary) {
  if (!isPlainObject(inputSummary)) return "";
  return typeof inputSummary.textPreview === "string" ? inputSummary.textPreview.trim() : "";
}

function textFromInputParts(input) {
  if (!Array.isArray(input)) return "";
  return input
    .filter((part) => isPlainObject(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/gu, " ")
    .slice(0, 20_000);
}

function userTextFromRequest(request) {
  const redactedInputText = textFromInputParts(request.redactedInput);
  if (redactedInputText) return redactedInputText;

  const inputText = textFromInputParts(request.input);
  if (inputText) return inputText;

  const summaryText = textFromInputSummary(request.inputSummary);
  if (summaryText) return summaryText;

  return typeof request.message === "string" ? request.message.trim() : "";
}

function isSensitivePayloadKey(key) {
  return /^(data|imageData|base64|b64_json|bytes|blob)$/iu.test(String(key));
}

function sanitizeContextString(value, key) {
  if (isSensitivePayloadKey(key) || /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    return "[redacted]";
  }
  return value;
}

function sanitizeContextValue(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => sanitizeContextValue(entry, key));
  if (typeof value === "string") return sanitizeContextString(value, key);
  if (!isPlainObject(value)) return value;

  const sanitized = {};
  for (const [nestedKey, nested] of Object.entries(value)) {
    sanitized[nestedKey] = sanitizeContextValue(nested, nestedKey);
  }
  return sanitized;
}

async function fetchRuntimeJson(path, { runtimeManager = null, timeoutMs = 1500, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (runtimeManager) {
      const payload = await runtimeManager.proxyToRuntime(path, { headers, signal: controller.signal });
      return { ok: true, payload };
    }
    const response = await fetch(`${RUNTIME_API_URL}${path}`, { headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, error: payload?.error || response.statusText };
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function collectRuntimeRequestText(requestsPayload) {
  const requests = Array.isArray(requestsPayload?.requests) ? requestsPayload.requests : [];
  return requests
    .slice(0, 8)
    .map((request) => {
      const userText = userTextFromRequest(request);
      return [
        `request ${request.id || "unknown"} status=${request.status || "unknown"}`,
        userText ? `user: ${userText}` : null,
        request.finalText ? `assistant-final: ${request.finalText}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function requestMatchesToolCall(request, toolCallId) {
  if (!toolCallId) return false;
  const scalarIds = [request.toolCallId, request.runtimeRequestId, request.requestId, request.id];
  if (scalarIds.some((id) => id === toolCallId)) return true;
  return Array.isArray(request.toolCallIds) && request.toolCallIds.includes(toolCallId);
}

function collectControlPlaneRequestText(store, runtimeId, toolCallId) {
  if (!store?.listAgentRequests) return "";
  return store
    .listAgentRequests({ runtimeId, limit: 12 })
    .filter((request) => requestMatchesToolCall(request, toolCallId))
    .map((request) => {
      const userText = userTextFromRequest(request);
      return [
        `control-plane-request ${request.requestId || "unknown"} status=${request.status || "unknown"}`,
        request.runtimeRequestId ? `runtime-request-id: ${request.runtimeRequestId}` : null,
        userText ? `user: ${userText}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function collectEventText(eventsPayload) {
  const events = Array.isArray(eventsPayload?.events) ? eventsPayload.events : [];
  return events
    .slice(-40)
    .map((event, index) => `[${index + 1}] ${textFromValue(sanitizeContextValue(event), 2000)}`)
    .join("\n");
}

export async function collectGatekeeperContext({
  store = null,
  runtimeId = null,
  toolCallId = null,
  runtimeManager = null,
} = {}) {
  const verifiedRuntimeManager =
    runtimeManager || (typeof store?.ensureRuntimeApiToken === "function" ? new RuntimeManager({ store }) : null);
  const [requests, events, summary] = await Promise.all([
    fetchRuntimeJson("/agent/requests", { runtimeManager: verifiedRuntimeManager }),
    fetchRuntimeJson("/agent/events?limit=80", { runtimeManager: verifiedRuntimeManager }),
    fetchRuntimeJson("/agent/summary", { runtimeManager: verifiedRuntimeManager }),
  ]);

  const sections = [];
  const authorizationText = collectControlPlaneRequestText(store, runtimeId, toolCallId);
  if (authorizationText.trim()) {
    sections.push(`CONTROL-PLANE USER REQUESTS\n${authorizationText}`);
  }
  if (requests.ok) {
    const requestText = collectRuntimeRequestText(requests.payload);
    if (requestText.trim()) sections.push(`RECENT REQUESTS\n${requestText}`);
  }
  if (events.ok) {
    const eventText = collectEventText(events.payload);
    if (eventText.trim()) sections.push(`RECENT AGENT EVENTS\n${eventText}`);
  }
  if (summary.ok && summary.payload?.summary) {
    sections.push(`CURRENT AGENT SUMMARY\n${textFromValue(summary.payload.summary, 5000)}`);
  }

  const errors = [requests, events, summary]
    .filter((result) => !result.ok)
    .map((result) => result.error || `HTTP ${result.status}`);

  return {
    ok: sections.length > 0,
    text: sections.join("\n\n").slice(0, 30_000),
    authorizationText: authorizationText.slice(0, 20_000),
    errors,
  };
}
