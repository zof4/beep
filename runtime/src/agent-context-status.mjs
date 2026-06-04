export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

const DEFAULT_WEB_SEARCH_NOTE = "Web search execution is planned for the next backend slice.";

function usableNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function shortString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

export function calculateContextPressure({ estimatedTokens, tokenBudget }) {
  if (!usableNumber(estimatedTokens) || !usableNumber(tokenBudget) || estimatedTokens < 0 || tokenBudget <= 0) {
    return {
      pressure: "unknown",
      remainingTokens: null,
      ratio: null,
    };
  }

  const ratio = estimatedTokens / tokenBudget;
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
    remainingTokens: tokenBudget - estimatedTokens,
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
  const tokenBudget = usableNumber(latestInjection?.tokenBudget)
    ? latestInjection.tokenBudget
    : lcmContextTokenBudget;
  const estimatedTokens = usableNumber(latestInjection?.estimatedTokens)
    ? latestInjection.estimatedTokens
    : null;
  const pressure = calculateContextPressure({ estimatedTokens, tokenBudget });
  const completedRequest = latestCompletedRequest(requests);
  const hindsightTelemetry = sessionStatus?.hindsightMemory || {};
  const hindsightHistory = Array.isArray(hindsightTelemetry.history) ? hindsightTelemetry.history : [];
  const latestRetain = latestHindsightEvent(hindsightHistory, "hindsight_retain");
  const latestRecall = latestHindsightEvent(hindsightHistory, "hindsight_recall");
  const latestFailedHindsight = latestFailedHindsightEvent(hindsightHistory);
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
    statusError: shortString(lcmStatusError),
    lastIngestRequestId: completedRequest?.id || null,
    lastIngestOk: completedRequest?.lcm?.ok ?? null,
    lastIngestError: shortString(completedRequest?.memoryError || completedRequest?.lcm?.error),
  };

  const hindsight = {
    available: hindsightConfigured ? hindsightTelemetry?.enabled === true : false,
    configured: hindsightConfigured,
    enabled: hindsightTelemetry?.enabled === true,
    latestRetainOk: latestRetain?.ok ?? null,
    latestRecallOk: latestRecall?.ok ?? null,
    latestError: shortString(latestFailedHindsight?.error),
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
      lastError: shortString(agentStatus?.lastError),
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
    completedRequest,
    latestRetain,
    latestRecall,
    requestCount: sortRequests(requests).length,
  });

  return status;
}

function buildWarnings({ status, latestInjection, completedRequest, latestRetain, latestRecall, requestCount }) {
  const warnings = [];

  if (!status.lcm.available) {
    warnings.push(
      status.lcm.statusError
        ? `LCM is unavailable: ${status.lcm.statusError}`
        : "LCM is unavailable.",
    );
  }

  if (status.context.enabled && latestInjection?.ok === false) {
    warnings.push(
      shortString(latestInjection.error)
        ? `LCM context injection failed: ${shortString(latestInjection.error)}`
        : "LCM context injection failed.",
    );
  }

  if (status.context.enabled && !latestInjection && requestCount > 0) {
    warnings.push("LCM context injection has no telemetry after processed requests.");
  }

  if (completedRequest?.memoryError || completedRequest?.lcm?.ok === false) {
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
      shortString(latestRetain.error)
        ? `Hindsight retain failed: ${shortString(latestRetain.error)}`
        : "Hindsight retain failed.",
    );
  }

  if (latestRecall?.ok === false) {
    warnings.push(
      shortString(latestRecall.error)
        ? `Hindsight recall failed: ${shortString(latestRecall.error)}`
        : "Hindsight recall failed.",
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
