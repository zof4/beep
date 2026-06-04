# Agent Context Observability Design

## Goal

Build a backend-first memory and context observability surface for the first usable Beep system. The operator should be able to ask one endpoint whether the long-running Pi agent is carrying useful context, whether LCM and Hindsight are healthy, whether the next turn is near context pressure, and whether adjacent capabilities such as web search are configured.

This slice deliberately comes before first-class web search execution. It gives the system a stable instrument panel before the agent depends on more external tools.

## Scope

In scope:

- Runtime endpoint: `GET /agent/context`.
- Control-plane proxy endpoint: `GET /api/agent/context`.
- Sanitized memory/context status assembled from existing runtime state.
- Context budget, pressure, and warning calculation.
- LCM ingest and context-injection status.
- Hindsight retain/recall status.
- Agent session continuity signals.
- Web-search readiness status only.
- Tests for runtime shape, control-plane proxying, sanitation, and warning behavior.
- Documentation updates that make the live memory path accurate.

Out of scope:

- A UI dashboard.
- New LCM recall tools.
- Actual web-search execution tools.
- Provider-native OpenAI hosted `web_search`.
- Raw transcript, raw memory file, or message-body exposure.
- Replacing `/api/backend/status`; this endpoint is a clearer companion contract.

## Design Summary

Add a purpose-built context status contract rather than expecting callers to infer memory health from `/api/backend/status` or `/agent/summary`. The runtime owns the data assembly because LCM, Hindsight, Pi session telemetry, and context injection telemetry live in the runtime house. The control plane exposes the same sanitized payload through the operator API.

The endpoint should be safe to open in the browser. It must not include user messages, assistant messages, raw memory snippets, raw Hindsight memories, file contents, or full event logs. It returns counts, budgets, timestamps, booleans, IDs, and short error strings only.

## Endpoint Contract

`GET /agent/context` returns:

```json
{
  "ok": true,
  "schemaVersion": 1,
  "time": "2026-06-04T00:00:00.000Z",
  "agent": {
    "id": "beep",
    "phase": "idle",
    "queueDepth": 0,
    "activeRequestId": null,
    "lastCompletedRequestId": "agent_req_...",
    "lastError": null
  },
  "model": {
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "thinking": "low",
    "estimatedContextWindowTokens": 128000
  },
  "context": {
    "tokenBudget": 128000,
    "estimatedTokens": 10301,
    "pressure": "low",
    "remainingTokens": 117699,
    "lastInjectionAt": "2026-06-04T00:00:00.000Z",
    "lastInjectionOk": true,
    "inputMessageCount": 61,
    "outputMessageCount": 62
  },
  "lcm": {
    "available": true,
    "conversationCount": 1,
    "messageCount": 57,
    "contextItemCount": 57,
    "summaryCount": 0,
    "messageTokens": 13485,
    "summaryTokens": 0,
    "lastIngestRequestId": "agent_req_...",
    "lastIngestOk": true,
    "lastIngestError": null
  },
  "hindsight": {
    "available": true,
    "latestRetainOk": true,
    "latestRecallOk": true,
    "latestError": null,
    "telemetryCount": 40,
    "failureCount": 24
  },
  "webSearch": {
    "mode": "disabled",
    "configured": false,
    "provider": null,
    "agentToolAvailable": false,
    "notes": ["Web search execution is planned for the next backend slice."]
  },
  "warnings": []
}
```

Field names may vary slightly to match existing runtime helpers, but the semantics should stay stable. All warning messages should be operator-facing and safe to display.

## Pressure And Warnings

Context pressure is derived from `estimatedTokens / tokenBudget` when both values are available:

- `unknown`: token budget or estimate is missing.
- `low`: less than 60%.
- `medium`: 60% through 79%.
- `high`: 80% through 94%.
- `critical`: 95% or higher.

Warnings should be emitted when:

- LCM is unavailable.
- LCM context injection is enabled but the latest injection failed.
- No context injection telemetry exists after the agent has processed requests.
- The latest completed request has a memory ingest error.
- Hindsight is unavailable when configured.
- Hindsight retain or recall has a recent failure.
- Context pressure is high or critical.
- Web search is requested by settings later but no executable backend is configured.

## Data Flow

Runtime:

1. Read the current runtime config for provider, model, and thinking level.
2. Read the canonical agent supervisor state and active Pi session state.
3. Read the latest LCM context injection telemetry from the session state path.
4. Read LCM status using the existing LCM service/status path.
5. Read Hindsight memory telemetry through the existing memory coordinator/session files.
6. Build warnings from the normalized status object.
7. Return only sanitized fields.

Control plane:

1. Add `/api/agent/context` to the runtime agent route map.
2. Require operator auth like the other agent-read routes.
3. Forward to runtime `/agent/context`.
4. Preserve runtime status codes and JSON errors.

## Web Search Placement

Web search should come after this slice. The context endpoint should still include `webSearch` readiness now so the next slice has a natural home for status.

The recommended next web-search slice is:

- Add web-search settings beside model/thinking settings.
- Register Pi tools such as `web_search` and `web_open` through a runtime extension.
- Route those tools to the control-plane broker.
- Audit search calls, source metadata, and failures.
- Use Codex and OpenAI Responses API `web_search` as the reference contract for modes, citations, sources, location, filters, and context size.
- Evaluate a later Pi provider patch for hosted OpenAI `web_search` once the brokered path works.

This keeps external network authority in the control plane while still leaving a future path to provider-native search.

## Error Handling

The endpoint should degrade rather than fail whenever possible:

- If one subsystem cannot be read, return `ok: true` with that subsystem marked unavailable and add a warning.
- Return HTTP 500 only when the runtime cannot build the top-level response at all.
- Return HTTP 401/403 through the control plane when operator auth is missing or invalid.
- Do not include stack traces in JSON responses.
- Keep short error strings, request IDs, and timestamps when useful for debugging.

## Testing

Runtime tests:

- Builds a context payload with healthy LCM, Hindsight, and injection telemetry.
- Emits warnings when LCM is unavailable.
- Emits warnings when latest context injection failed.
- Calculates `low`, `medium`, `high`, `critical`, and `unknown` pressure.
- Sanitizes message bodies and raw memory content out of the response.

Control-plane tests:

- `GET /api/agent/context` maps to runtime `/agent/context`.
- Operator auth is required.
- Runtime validation and error responses are preserved.
- CORS behavior matches the existing agent settings/status routes.

Live smoke proof:

- Start the control plane and runtime stack.
- Submit two requests through `/api/requests`.
- Open `/api/agent/context`.
- Verify LCM message counts increased, latest injection is present, Hindsight status is present, context pressure is calculated, and no raw transcript text appears.

## Success Criteria

- The user can open `http://127.0.0.1:18789/api/agent/context` and understand whether memory/context is healthy.
- The endpoint explains degraded memory without breaking normal request handling.
- The endpoint provides enough backend structure for a later UI without requiring UI work now.
- The endpoint creates a clear readiness slot for first-class web search.
