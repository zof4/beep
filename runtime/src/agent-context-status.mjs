export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const DEFAULT_WEB_SEARCH_NOTE = "Web search execution is planned for the next backend slice.";

function usableNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim();
}

function statusSafeError(value, fallback) {
  return hasText(value) ? fallback : null;
}

function normalizeTokenCount(value) {
  return usableNumber(value) ? Math.max(0, Math.round(value)) : null;
}

function roundRatio(value) {
  return Math.round(value * 10_000) / 10_000;
}

function sortRequests(requests) {
  return Object.values(requests || {}).sort((left, right) => {
    const leftSequence = usableNumber(left?.sequence) ? left.sequence : -1;
    const rightSequence = usableNumber(right?.sequence) ? right.sequence : -1;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
}

function latestCompletedRequest(requests) {
  return sortRequests(requests)
    .filter((request) => request?.status === "completed")
    .at(-1) || null;
}

function latestCompletedLcmIngestRequest(requests) {
  return sortRequests(requests)
    .filter((request) => (
      request?.status === "completed"
      && (request?.lcm || hasText(request?.memoryError))
    ))
    .at(-1) || null;
}

function latestHindsightEvent(history, kind) {
  return (Array.isArray(history) ? history : [])
    .filter((event) => event?.kind === kind)
    .at(-1) || null;
}

function latestFailedHindsightEvent(history) {
  return (Array.isArray(history) ? history : [])
    .filter((event) => event?.ok === false)
    .at(-1) || null;
}

export function calculateContextPressure({ estimatedTokens, tokenBudget } = {}) {
  const normalizedEstimatedTokens = normalizeTokenCount(estimatedTokens);
  const normalizedTokenBudget = normalizeTokenCount(tokenBudget);
  if (normalizedEstimatedTokens === null || normalizedTokenBudget === null || normalizedTokenBudget <= 0) {
    return {
      pressure: "unknown",
      remainingTokens: null,
      ratio: null,
    };
  }

  const ratio = roundRatio(normalizedEstimatedTokens / normalizedTokenBudget);
  let pressure = "low";
  if (ratio >= 0.95) {
    pressure = "critical";
  } else if (ratio >= 0.8) {
    pressure = "high";
  } else if (ratio >= 0.6) {
    pressure = "medium";
  }

  return {
    pressure,
    remainingTokens: Math.max(0, normalizedTokenBudget - normalizedEstimatedTokens),
    ratio,
  };
}

export function buildAgentContextStatus({
  nowIso = () => new Date().toISOString(),
  runtimeConfig = {},
  agentStatus = {},
  sessionStatus = {},
  requests = {},
  lcmStatus = null,
  lcmStatusError = null,
  lcmContextEnabled = false,
  lcmContextTokenBudget = DEFAULT_CONTEXT_WINDOW_TOKENS,
  hindsightConfigured = false,
  webSearch = null,
} = {}) {
  const latestInjection = sessionStatus?.lcmContextInjection?.latest || null;
  const tokenBudget = normalizeTokenCount(latestInjection?.tokenBudget)
    ?? normalizeTokenCount(lcmContextTokenBudget)
    ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const estimatedTokens = normalizeTokenCount(latestInjection?.estimatedTokens) !== null
    ? normalizeTokenCount(latestInjection.estimatedTokens)
    : null;
  const pressure = calculateContextPressure({ estimatedTokens, tokenBudget });
  const completedRequest = latestCompletedRequest(requests);
  const lcmIngestRequest = latestCompletedLcmIngestRequest(requests);
  const hindsightTelemetry = sessionStatus?.hindsightMemory || {};
  const hindsightHistory = Array.isArray(hindsightTelemetry.history) ? hindsightTelemetry.history : [];
  const latestRetain = latestHindsightEvent(hindsightHistory, "hindsight_retain");
  const latestRecall = latestHindsightEvent(hindsightHistory, "hindsight_recall");
  const latestFailedHindsight = latestFailedHindsightEvent(hindsightHistory);
  const hindsightObserved = Boolean((hindsightTelemetry?.total ?? hindsightHistory.length) > 0 || hindsightHistory.length > 0);
  const hindsightLatestFailure = latestRetain?.ok === false || latestRecall?.ok === false;
  const hindsightAvailable = hindsightConfigured
    && hindsightObserved
    && !hindsightLatestFailure
    && (latestRetain?.ok === true || latestRecall?.ok === true || (hindsightTelemetry?.failures ?? 0) === 0);
  const lcmAvailable = lcmStatus?.ok === true;
  const webSearchStatus = {
    mode: webSearch?.mode || "disabled",
    configured: webSearch?.configured === true,
    provider: webSearch?.provider || null,
    agentToolAvailable: webSearch?.agentToolAvailable === true,
    notes: Array.isArray(webSearch?.notes) ? webSearch.notes : [DEFAULT_WEB_SEARCH_NOTE],
  };

  const lcm = {
    available: lcmAvailable,
    conversationCount: lcmStatus?.rowCounts?.conversations ?? 0,
    messageCount: lcmStatus?.rowCounts?.messages ?? 0,
    contextItemCount: lcmStatus?.rowCounts?.context_items ?? 0,
    summaryCount: lcmStatus?.rowCounts?.summaries ?? 0,
    messageTokens: lcmStatus?.totals?.messageTokens ?? 0,
    summaryTokens: lcmStatus?.totals?.summaryTokens ?? 0,
    summarizedSourceTokens: lcmStatus?.totals?.summarizedSourceTokens ?? 0,
    statusError: statusSafeError(lcmStatusError, "LCM status error."),
    lastIngestRequestId: lcmIngestRequest?.id || null,
    lastIngestOk: lcmIngestRequest?.lcm?.ok ?? null,
    lastIngestError: statusSafeError(lcmIngestRequest?.memoryError || lcmIngestRequest?.lcm?.error, "LCM ingest failed."),
  };

  const hindsight = {
    available: hindsightAvailable,
    configured: hindsightConfigured,
    enabled: hindsightTelemetry?.enabled === true,
    observed: hindsightObserved,
    latestRetainOk: latestRetain?.ok ?? null,
    latestRecallOk: latestRecall?.ok ?? null,
    latestError: statusSafeHindsightError(latestFailedHindsight),
    telemetryCount: hindsightTelemetry?.total ?? hindsightHistory.length,
    failureCount: hindsightTelemetry?.failures ?? hindsightHistory.filter((event) => event?.ok === false).length,
  };

  const status = {
    ok: true,
    schemaVersion: 1,
    time: nowIso(),
    agent: {
      id: agentStatus?.id || "beep",
      phase: sessionStatus?.phase || "unknown",
      queueDepth: agentStatus?.queueDepth ?? 0,
      activeRequestId: agentStatus?.activeRequestId || null,
      lastCompletedRequestId: completedRequest?.id || null,
      lastError: statusSafeError(agentStatus?.lastError, "Agent error."),
    },
    model: {
      provider: runtimeConfig?.provider || "openai-codex",
      model: sessionStatus?.model || runtimeConfig?.model || null,
      thinking: sessionStatus?.thinking || runtimeConfig?.thinking || null,
      estimatedContextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    },
    context: {
      tokenBudget,
      estimatedTokens,
      pressure: pressure.pressure,
      remainingTokens: pressure.remainingTokens,
      ratio: pressure.ratio,
      lastInjectionAt: latestInjection?.at || null,
      lastInjectionOk: latestInjection?.ok ?? null,
      inputMessageCount: latestInjection?.inputMessageCount ?? null,
      outputMessageCount: latestInjection?.outputMessageCount ?? null,
      enabled: lcmContextEnabled === true || sessionStatus?.lcmContextInjection?.enabled === true,
      telemetryCount: sessionStatus?.lcmContextInjection?.total ?? 0,
      failureCount: sessionStatus?.lcmContextInjection?.failures ?? 0,
    },
    lcm,
    hindsight,
    webSearch: webSearchStatus,
    warnings: [],
  };

  status.warnings = buildWarnings({
    status,
    latestInjection,
    lcmIngestRequest,
    latestRetain,
    latestRecall,
    requestCount: sortRequests(requests).length,
  });

  return status;
}

function statusSafeHindsightError(event) {
  if (!hasText(event?.error)) return null;
  if (event?.kind === "hindsight_retain") return "Hindsight retain failed.";
  if (event?.kind === "hindsight_recall") return "Hindsight recall failed.";
  return "Hindsight error.";
}

function buildWarnings({ status, latestInjection, lcmIngestRequest, latestRetain, latestRecall, requestCount }) {
  const warnings = [];

  if (!status.lcm.available) {
    warnings.push(
      status.lcm.statusError
        ? `LCM is unavailable: ${status.lcm.statusError}`
        : "LCM is unavailable.",
    );
  }

  if (status.context.enabled && latestInjection?.ok === false) {
    warnings.push("LCM context injection failed.");
  }

  if (status.context.enabled && !latestInjection && requestCount > 0) {
    warnings.push("LCM context injection has no telemetry after processed requests.");
  }

  if (lcmIngestRequest?.memoryError || lcmIngestRequest?.lcm?.ok === false) {
    warnings.push(
      status.lcm.lastIngestError
        ? `latest completed request has memory ingest errors: ${status.lcm.lastIngestError}`
        : "latest completed request has memory ingest errors.",
    );
  }

  if (status.hindsight.configured && !status.hindsight.available) {
    warnings.push("Hindsight is unavailable.");
  }

  if (latestRetain?.ok === false) {
    warnings.push(
      "Hindsight retain failed.",
    );
  }

  if (latestRecall?.ok === false) {
    warnings.push(
      "Hindsight recall failed.",
    );
  }

  if (status.context.pressure === "high" || status.context.pressure === "critical") {
    warnings.push(`Context pressure is ${status.context.pressure}.`);
  }

  if (status.webSearch.configured && !status.webSearch.agentToolAvailable) {
    warnings.push("Web search is configured but no agent tool is available.");
  }

  return warnings;
}
