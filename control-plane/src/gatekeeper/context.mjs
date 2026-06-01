import { RUNTIME_API_URL } from "../config.mjs";

function textFromValue(value, maxChars = 20_000) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxChars);
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return String(value).slice(0, maxChars);
  }
}

async function fetchRuntimeJson(path, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${RUNTIME_API_URL}${path}`, { signal: controller.signal });
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
    .map((request) =>
      [
        `request ${request.id || "unknown"} status=${request.status || "unknown"}`,
        request.message ? `user: ${request.message}` : null,
        request.finalText ? `assistant-final: ${request.finalText}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function collectControlPlaneRequestText(store, runtimeId) {
  if (!store?.listAgentRequests) return "";
  return store
    .listAgentRequests({ runtimeId, limit: 12 })
    .map((request) =>
      [
        `control-plane-request ${request.requestId || "unknown"} status=${request.status || "unknown"}`,
        request.runtimeRequestId ? `runtime-request-id: ${request.runtimeRequestId}` : null,
        request.message ? `user: ${request.message}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

function collectEventText(eventsPayload) {
  const events = Array.isArray(eventsPayload?.events) ? eventsPayload.events : [];
  return events
    .slice(-40)
    .map((event, index) => `[${index + 1}] ${textFromValue(event, 2000)}`)
    .join("\n");
}

export async function collectGatekeeperContext({ store = null, runtimeId = null } = {}) {
  const [requests, events, summary] = await Promise.all([
    fetchRuntimeJson("/agent/requests"),
    fetchRuntimeJson("/agent/events?limit=80"),
    fetchRuntimeJson("/agent/summary"),
  ]);

  const sections = [];
  const authorizationText = collectControlPlaneRequestText(store, runtimeId);
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
