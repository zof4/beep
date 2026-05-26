const MAX_RESULT_CHARS = 40_000;
const DEFAULT_GREP_LIMIT = 50;
const MAX_GREP_LIMIT = 200;
const DEFAULT_EXPAND_FILE_BYTES = 32_768;
const MAX_EXPAND_FILE_BYTES = 512_000;
const DEFAULT_EXPAND_QUERY_CANDIDATE_LIMIT = 8;
const MAX_EXPAND_QUERY_CANDIDATE_LIMIT = 50;
const DEFAULT_EXPAND_QUERY_DEPTH = 3;
const MAX_EXPAND_QUERY_DEPTH = 8;
const DEFAULT_EXPAND_QUERY_TOKEN_CAP = 12_000;
const MAX_EXPAND_QUERY_TOKEN_CAP = 64_000;
const DEFAULT_EXPAND_QUERY_MAX_ANSWER_TOKENS = 2_000;
const MAX_EXPAND_QUERY_MAX_ANSWER_TOKENS = 16_000;

export const LCM_RECALL_TOOL_NAMES = new Set(["lcm_grep", "lcm_describe", "lcm_expand", "lcm_expand_query"]);
const activeExpandQueries = new Set();

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function jsonTextResult(payload) {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

function toRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readString(params, key, fallback = "") {
  const value = params[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function readBoolean(params, key, fallback = false) {
  return typeof params[key] === "boolean" ? params[key] : fallback;
}

function readPositiveInteger(params, key, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readStringArray(params, key, max = 50) {
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

function parseIsoTimestampParam(params, key) {
  const raw = params[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${key} must be a valid ISO timestamp.`);
  }
  return parsed;
}

function formatDisplayTime(value, timezone = "UTC") {
  if (value == null) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function truncateSnippet(content, maxLen = 200) {
  const singleLine = String(content ?? "").replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLen - 3))}...`;
}

function truncateBlock(content, maxLen = 1_200) {
  const text = String(content ?? "").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 15)).trimEnd()}\n[truncated]`;
}

function findRegexSyntaxInFullTextQuery(pattern) {
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (escaped) {
      escaped = false;
      if (!inQuote && char && /[bBdDsSwW]/u.test(char)) return "regex character escape";
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (char === "|") return "alternation";
    if (char === "." && (next === "*" || next === "+" || next === "?")) return "wildcard";
    if (char === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) return "character class";
    }
    if (char === "^" && (index === 0 || /\s/u.test(pattern[index - 1] ?? ""))) return "anchor";
    if (char === "$" && (index === pattern.length - 1 || /\s/u.test(next ?? ""))) return "anchor";
  }

  return null;
}

function validateFullTextPattern(pattern) {
  const syntax = findRegexSyntaxInFullTextQuery(pattern);
  if (!syntax) return null;
  return [
    `full_text mode does not support regex syntax (${syntax}).`,
    `Use mode: "regex" for \`${pattern}\`, or rewrite the full_text query`,
    "as 1-3 literal terms or one quoted phrase.",
  ].join(" ");
}

async function conversationForSession({ engine, sessionId, sessionKey }) {
  const store = engine.getConversationStore();
  const normalizedSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (normalizedSessionKey && typeof store.getConversationBySessionKey === "function") {
    const byKey = await store.getConversationBySessionKey(normalizedSessionKey);
    if (byKey) return byKey;
  }

  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) return null;
  return store.getConversationBySessionId(normalizedSessionId);
}

async function conversationFamilyIds({ engine, conversationId, sessionId, sessionKey }) {
  const store = engine.getConversationStore();
  if (typeof store.getConversationFamilyIds !== "function") return [conversationId];
  const familyIds = await store.getConversationFamilyIds({ conversationId, sessionId, sessionKey });
  return Array.isArray(familyIds) && familyIds.length > 0 ? familyIds : [conversationId];
}

async function resolveConversationScope({ engine, sessionId, sessionKey, params }) {
  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    return {
      conversationId: explicitConversationId,
      conversationIds: [explicitConversationId],
      allConversations: false,
    };
  }

  if (params.allConversations === true) {
    return {
      conversationId: undefined,
      conversationIds: undefined,
      allConversations: true,
    };
  }

  const conversation = await conversationForSession({ engine, sessionId, sessionKey });
  if (!conversation) {
    return {
      conversationId: undefined,
      conversationIds: undefined,
      allConversations: false,
    };
  }

  const ids = await conversationFamilyIds({
    engine,
    conversationId: conversation.conversationId,
    sessionId,
    sessionKey,
  });
  return {
    conversationId: conversation.conversationId,
    conversationIds: ids,
    allConversations: false,
  };
}

function formatConversationScope(scope) {
  if (scope.allConversations) return "**Conversation scope:** all conversations";
  if (scope.conversationId == null) return "**Conversation scope:** none";
  const familyCount = scope.conversationIds?.length ?? 0;
  if (familyCount > 1) {
    return `**Conversation scope:** session family rooted at ${scope.conversationId} (${familyCount} segments)`;
  }
  return `**Conversation scope:** ${scope.conversationId}`;
}

function normalizeSummaryIds(ids) {
  const seen = new Set();
  const normalized = [];
  for (const id of ids || []) {
    const value = typeof id === "string" ? id.trim() : "";
    if (!value || seen.has(value)) continue;
    normalized.push(value);
    seen.add(value);
  }
  return normalized;
}

function scopeAllowsConversation(scope, conversationId) {
  if (scope.allConversations) return true;
  const allowed = new Set(scope.conversationIds ?? [scope.conversationId]);
  return allowed.has(conversationId);
}

function upsertExpandCandidate(candidates, candidate) {
  const existing = candidates.get(candidate.summaryId);
  if (!existing) {
    candidates.set(candidate.summaryId, candidate);
    return;
  }
  candidates.set(candidate.summaryId, {
    ...existing,
    source:
      existing.source === "explicit" || candidate.source === "explicit"
        ? "explicit"
        : existing.source === "message_search" || candidate.source === "message_search"
          ? "message_search"
          : "summary_search",
    requiresMessageExpansion: existing.requiresMessageExpansion || candidate.requiresMessageExpansion,
    matchedAt:
      existing.matchedAt && candidate.matchedAt
        ? existing.matchedAt.getTime() >= candidate.matchedAt.getTime()
          ? existing.matchedAt
          : candidate.matchedAt
        : existing.matchedAt || candidate.matchedAt,
  });
}

function compareExpandCandidates(left, right) {
  const sourceRank = { explicit: 3, message_search: 2, summary_search: 1 };
  const sourceDelta = (sourceRank[right.source] || 0) - (sourceRank[left.source] || 0);
  if (sourceDelta !== 0) return sourceDelta;
  const recencyDelta = (right.matchedAt?.getTime() ?? 0) - (left.matchedAt?.getTime() ?? 0);
  if (recencyDelta !== 0) return recencyDelta;
  return left.summaryId.localeCompare(right.summaryId);
}

async function addExplicitSummaryCandidates({ retrieval, conversationScope, summaryIds, candidates }) {
  for (const summaryId of normalizeSummaryIds(summaryIds)) {
    const described = await retrieval.describe(summaryId);
    if (!described || described.type !== "summary" || !described.summary) {
      throw new Error(`Summary not found: ${summaryId}`);
    }
    if (!scopeAllowsConversation(conversationScope, described.summary.conversationId)) {
      throw new Error(
        `Summary ${summaryId} is outside the current conversation scope. Use allConversations=true for cross-conversation expansion.`,
      );
    }
    upsertExpandCandidate(candidates, {
      summaryId,
      conversationId: described.summary.conversationId,
      kind: described.summary.kind,
      content: described.summary.content,
      tokenCount: Number(described.summary.tokenCount || 0),
      matchedAt: described.summary.latestAt || described.summary.createdAt,
      source: "explicit",
      requiresMessageExpansion: false,
    });
  }
}

async function addSummarySearchCandidates({ retrieval, conversationScope, query, candidateLimit, candidates }) {
  const result = await retrieval.grep({
    query,
    mode: "full_text",
    scope: "summaries",
    conversationId: conversationScope.conversationId,
    conversationIds: conversationScope.conversationIds,
    limit: candidateLimit,
    sort: "hybrid",
  });
  for (const summary of result.summaries || []) {
    if (!scopeAllowsConversation(conversationScope, summary.conversationId)) continue;
    const described = await retrieval.describe(summary.summaryId);
    if (!described || described.type !== "summary" || !described.summary) continue;
    upsertExpandCandidate(candidates, {
      summaryId: summary.summaryId,
      conversationId: summary.conversationId,
      kind: described.summary.kind,
      content: described.summary.content,
      tokenCount: Number(described.summary.tokenCount || 0),
      matchedAt: summary.createdAt || described.summary.latestAt || described.summary.createdAt,
      source: "summary_search",
      requiresMessageExpansion: false,
    });
  }
  return result.summaries?.length || 0;
}

async function addMessageFallbackCandidates({ engine, retrieval, conversationScope, query, candidateLimit, candidates }) {
  const summaryStore = typeof engine.getSummaryStore === "function" ? engine.getSummaryStore() : null;
  if (
    !summaryStore ||
    typeof summaryStore.getConversationMaxSummaryDepth !== "function" ||
    typeof summaryStore.getLeafSummaryLinksForMessageIds !== "function"
  ) {
    return 0;
  }

  const scopedIds = conversationScope.conversationIds?.length
    ? conversationScope.conversationIds
    : conversationScope.conversationId != null
      ? [conversationScope.conversationId]
      : [];
  if (!conversationScope.allConversations && scopedIds.length === 0) return 0;

  if (scopedIds.length > 0) {
    const depths = await Promise.all(
      scopedIds.map(async (conversationId) => summaryStore.getConversationMaxSummaryDepth(conversationId)),
    );
    if (!depths.every((depth) => typeof depth === "number" && depth <= 1)) {
      return 0;
    }
  }

  const messageResult = await retrieval.grep({
    query,
    mode: "full_text",
    scope: "messages",
    conversationId: conversationScope.conversationId,
    conversationIds: conversationScope.conversationIds,
    limit: candidateLimit,
    sort: "hybrid",
  });

  const messageIdsByConversationId = new Map();
  for (const message of messageResult.messages || []) {
    if (!scopeAllowsConversation(conversationScope, message.conversationId)) continue;
    const messageIds = messageIdsByConversationId.get(message.conversationId) ?? [];
    messageIds.push(message.messageId);
    messageIdsByConversationId.set(message.conversationId, messageIds);
  }

  for (const [conversationId, messageIds] of messageIdsByConversationId.entries()) {
    const links = await summaryStore.getLeafSummaryLinksForMessageIds(conversationId, messageIds);
    for (const link of links || []) {
      const described = await retrieval.describe(link.summaryId);
      if (!described || described.type !== "summary" || !described.summary) continue;
      upsertExpandCandidate(candidates, {
        summaryId: link.summaryId,
        conversationId,
        kind: described.summary.kind,
        content: described.summary.content,
        tokenCount: Number(described.summary.tokenCount || 0),
        matchedAt: described.summary.latestAt || described.summary.createdAt,
        source: "message_search",
        requiresMessageExpansion: true,
      });
    }
  }

  return messageResult.messages?.length || 0;
}

function pushBoundedLine(lines, state, line = "") {
  if (state.outputTruncated) return false;
  const text = String(line);
  if (state.chars + text.length + 1 > MAX_RESULT_CHARS) {
    lines.push("*(truncated - more expansion output available)*");
    state.outputTruncated = true;
    return false;
  }
  lines.push(text);
  state.chars += text.length + 1;
  return true;
}

async function selectExpandCandidates({ engine, retrieval, conversationScope, query, summaryIds, candidateLimit }) {
  const candidates = new Map();
  await addExplicitSummaryCandidates({
    retrieval,
    conversationScope,
    summaryIds,
    candidates,
  });
  let summaryMatchCount = 0;
  let messageMatchCount = 0;
  if (query) {
    summaryMatchCount = await addSummarySearchCandidates({
      retrieval,
      conversationScope,
      query,
      candidateLimit,
      candidates,
    });
    if (summaryMatchCount === 0) {
      messageMatchCount = await addMessageFallbackCandidates({
        engine,
        retrieval,
        conversationScope,
        query,
        candidateLimit,
        candidates,
      });
    }
  }
  const selectedCandidates = Array.from(candidates.values())
    .sort(compareExpandCandidates)
    .slice(0, candidateLimit);
  return { selectedCandidates, summaryMatchCount, messageMatchCount };
}

function restrictScopeToExpansionGrant(scope, expansionGrant) {
  if (!expansionGrant) return scope;
  const allowed = new Set(expansionGrant.allowedConversationIds || []);
  if (allowed.size === 0) {
    throw new Error("Delegated expansion grant has no allowed conversation scope.");
  }
  const rawRequestedIds = scope.allConversations
    ? [...allowed]
    : (scope.conversationIds ?? [scope.conversationId]).filter((id) => id != null);
  const requestedIds = rawRequestedIds.length > 0 ? rawRequestedIds : [...allowed];
  const scopedIds = requestedIds.filter((id) => allowed.has(id));
  if (scopedIds.length === 0) {
    throw new Error("lcm_expand request is outside the delegated expansion grant scope.");
  }
  return {
    conversationId: scopedIds[0],
    conversationIds: scopedIds,
    allConversations: false,
  };
}

function formatNoCandidates({ title, prompt, query, conversationScope, summaryMatchCount, messageMatchCount }) {
  return textResult(
    [
      title,
      prompt ? `**Prompt:** ${prompt}` : null,
      query ? `**Query:** \`${query}\`` : null,
      formatConversationScope(conversationScope),
      "",
      "No matching summaries found for this scope.",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    {
      candidateCount: 0,
      summaryMatchCount,
      messageMatchCount,
      expandedSummaryCount: 0,
      totalSourceTokens: 0,
      truncated: false,
    },
  );
}

async function renderExpandedEvidence({
  retrieval,
  timezone,
  title,
  prompt,
  query,
  explicitSummaryIds,
  conversationScope,
  selectedCandidates,
  summaryMatchCount,
  messageMatchCount,
  maxDepth,
  tokenCap,
  includeMessages,
  recallContract,
}) {
  const lines = [];
  const outputState = { chars: 0, outputTruncated: false };
  const citedIds = new Set();
  const sourceConversationIds = new Set();
  let totalSourceTokens = 0;
  let expandedSummaryCount = 0;
  let messageCount = 0;
  let truncated = false;

  pushBoundedLine(lines, outputState, title);
  if (prompt) pushBoundedLine(lines, outputState, `**Prompt:** ${prompt}`);
  if (query) pushBoundedLine(lines, outputState, `**Query:** \`${query}\``);
  if (explicitSummaryIds.length > 0) {
    pushBoundedLine(lines, outputState, `**Explicit summaries:** ${explicitSummaryIds.join(", ")}`);
  }
  pushBoundedLine(lines, outputState, `**Max depth:** ${maxDepth} | **Token cap:** ${tokenCap}`);
  pushBoundedLine(lines, outputState, formatConversationScope(conversationScope));
  pushBoundedLine(
    lines,
    outputState,
    `**Candidates:** ${selectedCandidates.length} selected (${summaryMatchCount} summary matches, ${messageMatchCount} message matches)`,
  );
  pushBoundedLine(lines, outputState, "");
  pushBoundedLine(lines, outputState, "## Candidate Selection");
  for (const candidate of selectedCandidates) {
    sourceConversationIds.add(candidate.conversationId);
    pushBoundedLine(
      lines,
      outputState,
      `- [${candidate.summaryId}] conv=${candidate.conversationId} kind=${candidate.kind} source=${candidate.source} tok=${candidate.tokenCount} matched=${formatDisplayTime(candidate.matchedAt, timezone)}`,
    );
  }
  pushBoundedLine(lines, outputState, "");
  pushBoundedLine(lines, outputState, "## Expanded Evidence");

  for (const candidate of selectedCandidates) {
    if (totalSourceTokens >= tokenCap || outputState.outputTruncated) {
      truncated = true;
      break;
    }
    const remainingForRoot = tokenCap - totalSourceTokens;
    if (candidate.tokenCount > remainingForRoot) {
      truncated = true;
      break;
    }
    totalSourceTokens += candidate.tokenCount;
    expandedSummaryCount += 1;
    citedIds.add(candidate.summaryId);

    pushBoundedLine(lines, outputState, "");
    pushBoundedLine(lines, outputState, `### ${candidate.summaryId}`);
    pushBoundedLine(
      lines,
      outputState,
      `meta conv=${candidate.conversationId} kind=${candidate.kind} source=${candidate.source} tok=${candidate.tokenCount}`,
    );
    pushBoundedLine(lines, outputState, "summary");
    pushBoundedLine(lines, outputState, truncateBlock(candidate.content));

    const remaining = tokenCap - totalSourceTokens;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const expanded = await retrieval.expand({
      summaryId: candidate.summaryId,
      depth: maxDepth,
      includeMessages: includeMessages || candidate.requiresMessageExpansion,
      tokenCap: remaining,
    });
    totalSourceTokens += Number(expanded.estimatedTokens || 0);
    if (expanded.truncated) truncated = true;

    if (expanded.children.length > 0) {
      pushBoundedLine(lines, outputState, "children");
      for (const child of expanded.children) {
        citedIds.add(child.summaryId);
        pushBoundedLine(
          lines,
          outputState,
          `- [${child.summaryId}] kind=${child.kind} tok=${child.tokenCount}: ${truncateSnippet(child.content, 600)}`,
        );
      }
    }

    if (expanded.messages.length > 0) {
      pushBoundedLine(lines, outputState, "messages");
      for (const message of expanded.messages) {
        messageCount += 1;
        pushBoundedLine(
          lines,
          outputState,
          `- [msg#${message.messageId}] ${message.role} tok=${message.tokenCount}: ${truncateSnippet(message.content, 800)}`,
        );
      }
    }
  }

  if (outputState.outputTruncated) truncated = true;
  if (recallContract) {
    pushBoundedLine(lines, outputState, "");
    pushBoundedLine(lines, outputState, "## Recall Contract");
    pushBoundedLine(lines, outputState, recallContract);
  }

  return textResult(lines.join("\n"), {
    candidateCount: selectedCandidates.length,
    summaryMatchCount,
    messageMatchCount,
    expandedSummaryCount,
    messageCount,
    citedIds: Array.from(citedIds),
    sourceConversationIds: Array.from(sourceConversationIds).sort((left, right) => left - right),
    totalSourceTokens,
    truncated,
    maxDepth,
    tokenCap,
    includeMessages,
  });
}

async function executeLcmExpand({ engine, sessionId, sessionKey, params, expansionGrant }) {
  if (!expansionGrant) {
    return jsonTextResult({
      errorCode: "LCM_EXPAND_REQUIRES_DELEGATED_GRANT",
      error: "lcm_expand is only available inside delegated LCM expansion sessions.",
      recovery: "Main agents should call lcm_expand_query, which creates a scoped delegated expansion session.",
    });
  }
  const retrieval = engine.getRetrieval();
  const timezone = engine.timezone || "UTC";
  const explicitSummaryIds = readStringArray(params, "summaryIds", MAX_EXPAND_QUERY_CANDIDATE_LIMIT);
  const query = readString(params, "query");
  if (explicitSummaryIds.length === 0 && !query) {
    throw new Error("lcm_expand requires summaryIds or query.");
  }
  if (query) {
    const fullTextPatternError = validateFullTextPattern(query);
    if (fullTextPatternError) return jsonTextResult({ error: fullTextPatternError });
  }
  const rawConversationScope = await resolveConversationScope({ engine, sessionId, sessionKey, params });
  const conversationScope = restrictScopeToExpansionGrant(rawConversationScope, expansionGrant);
  const candidateLimit = readPositiveInteger(params, "candidateLimit", DEFAULT_EXPAND_QUERY_CANDIDATE_LIMIT, {
    min: 1,
    max: MAX_EXPAND_QUERY_CANDIDATE_LIMIT,
  });
  const maxDepth = readPositiveInteger(params, "maxDepth", DEFAULT_EXPAND_QUERY_DEPTH, {
    min: 1,
    max: MAX_EXPAND_QUERY_DEPTH,
  });
  const requestedTokenCap = readPositiveInteger(params, "tokenCap", expansionGrant.tokenCap, {
    min: 1,
    max: MAX_EXPAND_QUERY_TOKEN_CAP,
  });
  const tokenCap = Math.min(requestedTokenCap, expansionGrant.tokenCap);
  const includeMessages = readBoolean(params, "includeMessages", true);
  const { selectedCandidates, summaryMatchCount, messageMatchCount } = await selectExpandCandidates({
    engine,
    retrieval,
    conversationScope,
    query,
    summaryIds: explicitSummaryIds,
    candidateLimit,
  });
  if (selectedCandidates.length === 0) {
    return formatNoCandidates({
      title: "## LCM Expand",
      query,
      conversationScope,
      summaryMatchCount,
      messageMatchCount,
    });
  }
  return renderExpandedEvidence({
    retrieval,
    timezone,
    title: "## LCM Expand",
    query,
    explicitSummaryIds,
    conversationScope,
    selectedCandidates,
    summaryMatchCount,
    messageMatchCount,
    maxDepth,
    tokenCap,
    includeMessages,
    recallContract:
      "Use this source evidence to answer the delegated expansion prompt. Return compact JSON to the main agent with cited summary IDs.",
  });
}

function formatDelegatedExpandQueryResult({
  prompt,
  query,
  explicitSummaryIds,
  conversationScope,
  selectedCandidates,
  summaryMatchCount,
  messageMatchCount,
  maxDepth,
  tokenCap,
  includeMessages,
  maxTokens,
  delegated,
}) {
  const lines = [
    "## LCM Expand Query",
    `**Prompt:** ${prompt}`,
    query ? `**Query:** \`${query}\`` : null,
    explicitSummaryIds.length > 0 ? `**Explicit summaries:** ${explicitSummaryIds.join(", ")}` : null,
    `**Max depth:** ${maxDepth} | **Source token cap:** ${tokenCap} | **Answer token cap:** ${maxTokens}`,
    formatConversationScope(conversationScope),
    `**Candidates:** ${selectedCandidates.length} selected (${summaryMatchCount} summary matches, ${messageMatchCount} message matches)`,
    delegated.delegatedRuntimeSessionId ? `**Delegated session:** ${delegated.delegatedRuntimeSessionId}` : null,
    "",
    "## Answer",
    delegated.answer,
  ].filter((line) => line !== null);
  if (delegated.notes) {
    lines.push("", "## Notes", delegated.notes);
  }
  lines.push(
    "",
    "## Citations",
    delegated.citedIds?.length ? delegated.citedIds.map((id) => `- ${id}`).join("\n") : "- none returned",
  );
  return textResult(lines.join("\n"), {
    delegated: true,
    delegatedRuntimeSessionId: delegated.delegatedRuntimeSessionId || null,
    grantId: delegated.grantId || null,
    candidateCount: selectedCandidates.length,
    summaryMatchCount,
    messageMatchCount,
    expandedSummaryCount: delegated.expandedSummaryCount,
    citedIds: delegated.citedIds || [],
    sourceConversationIds: delegated.sourceConversationIds || [],
    totalSourceTokens: delegated.totalSourceTokens,
    truncated: Boolean(delegated.truncated),
    maxDepth,
    tokenCap,
    includeMessages,
    maxTokens,
    durationMs: delegated.durationMs ?? null,
  });
}

async function executeLcmExpandQuery({ engine, sessionId, sessionKey, params, delegateExpandQuery }) {
  const retrieval = engine.getRetrieval();
  const explicitSummaryIds = readStringArray(params, "summaryIds", MAX_EXPAND_QUERY_CANDIDATE_LIMIT);
  const query = readString(params, "query");
  const prompt = readString(params, "prompt");
  if (!prompt) {
    throw new Error("lcm_expand_query requires a non-empty prompt.");
  }
  if (explicitSummaryIds.length === 0 && !query) {
    throw new Error("lcm_expand_query requires summaryIds or query.");
  }
  if (query) {
    const fullTextPatternError = validateFullTextPattern(query);
    if (fullTextPatternError) return jsonTextResult({ error: fullTextPatternError });
  }

  const guardKey = sessionKey || sessionId || "unknown";
  if (activeExpandQueries.has(guardKey)) {
    return jsonTextResult({
      errorCode: "LCM_EXPAND_QUERY_ALREADY_RUNNING",
      error: "Another lcm_expand_query call is already running for this session.",
      recovery: "Wait for the current recall expansion to finish, then retry with a narrower query or explicit summaryIds.",
    });
  }

  activeExpandQueries.add(guardKey);
  try {
    const conversationScope = await resolveConversationScope({ engine, sessionId, sessionKey, params });
    if (!conversationScope.allConversations && conversationScope.conversationId == null) {
      return jsonTextResult({
        error: "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
      });
    }

    const candidateLimit = readPositiveInteger(params, "candidateLimit", DEFAULT_EXPAND_QUERY_CANDIDATE_LIMIT, {
      min: 1,
      max: MAX_EXPAND_QUERY_CANDIDATE_LIMIT,
    });
    const maxDepth = readPositiveInteger(params, "maxDepth", DEFAULT_EXPAND_QUERY_DEPTH, {
      min: 1,
      max: MAX_EXPAND_QUERY_DEPTH,
    });
    const tokenCap = readPositiveInteger(params, "tokenCap", DEFAULT_EXPAND_QUERY_TOKEN_CAP, {
      min: 1,
      max: MAX_EXPAND_QUERY_TOKEN_CAP,
    });
    const includeMessages = readBoolean(params, "includeMessages", true);
    const maxTokens = readPositiveInteger(params, "maxTokens", DEFAULT_EXPAND_QUERY_MAX_ANSWER_TOKENS, {
      min: 1,
      max: MAX_EXPAND_QUERY_MAX_ANSWER_TOKENS,
    });
    const timeoutMs = readPositiveInteger(params, "timeoutMs", 120_000, {
      min: 1_000,
      max: 300_000,
    });
    const { selectedCandidates, summaryMatchCount, messageMatchCount } = await selectExpandCandidates({
      engine,
      retrieval,
      conversationScope,
      query,
      summaryIds: explicitSummaryIds,
      candidateLimit,
    });

    if (selectedCandidates.length === 0) {
      return formatNoCandidates({
        title: "## LCM Expand Query",
        prompt,
        query,
        conversationScope,
        summaryMatchCount,
        messageMatchCount,
      });
    }

    if (typeof delegateExpandQuery !== "function") {
      return jsonTextResult({
        errorCode: "LCM_DELEGATED_EXPANSION_UNAVAILABLE",
        error: "lcm_expand_query requires the runtime delegated Pi expansion executor.",
        recovery: "Call through the managed Beep runtime LCM tool route so a scoped expansion session can be created.",
        candidateSummaryIds: selectedCandidates.map((candidate) => candidate.summaryId),
      });
    }

    let delegated;
    try {
      delegated = await delegateExpandQuery({
        prompt,
        query,
        selectedCandidates,
        conversationScope,
        maxDepth,
        tokenCap,
        includeMessages,
        maxTokens,
        timeoutMs,
      });
    } catch (error) {
      return jsonTextResult({
        errorCode: "LCM_DELEGATED_EXPANSION_FAILED",
        error: error instanceof Error ? error.message : String(error),
        candidateSummaryIds: selectedCandidates.map((candidate) => candidate.summaryId),
        recovery: "Retry with narrower summaryIds or a smaller tokenCap, or inspect candidates with lcm_describe.",
      });
    }

    return formatDelegatedExpandQueryResult({
      prompt,
      query,
      explicitSummaryIds,
      conversationScope,
      selectedCandidates,
      summaryMatchCount,
      messageMatchCount,
      maxDepth,
      tokenCap,
      includeMessages,
      maxTokens,
      delegated,
    });
  } finally {
    activeExpandQueries.delete(guardKey);
  }
}

async function executeLcmGrep({ engine, sessionId, sessionKey, params }) {
  const retrieval = engine.getRetrieval();
  const timezone = engine.timezone || "UTC";
  const pattern = readString(params, "pattern");
  if (!pattern) {
    throw new Error("lcm_grep requires a non-empty pattern.");
  }

  const mode = readString(params, "mode", "regex");
  if (!["regex", "full_text"].includes(mode)) {
    throw new Error('lcm_grep mode must be "regex" or "full_text".');
  }
  const scope = readString(params, "scope", "both");
  if (!["messages", "summaries", "both"].includes(scope)) {
    throw new Error('lcm_grep scope must be "messages", "summaries", or "both".');
  }
  const requestedSort = readString(params, "sort", "recency");
  if (!["recency", "relevance", "hybrid"].includes(requestedSort)) {
    throw new Error('lcm_grep sort must be "recency", "relevance", or "hybrid".');
  }
  const effectiveSort = mode === "full_text" ? requestedSort : "recency";
  if (mode === "full_text") {
    const fullTextPatternError = validateFullTextPattern(pattern);
    if (fullTextPatternError) return jsonTextResult({ error: fullTextPatternError });
  }

  let since;
  let before;
  try {
    since = parseIsoTimestampParam(params, "since");
    before = parseIsoTimestampParam(params, "before");
  } catch (error) {
    return jsonTextResult({
      error: error instanceof Error ? error.message : "Invalid timestamp filter.",
    });
  }
  if (since && before && since.getTime() >= before.getTime()) {
    return jsonTextResult({ error: "`since` must be earlier than `before`." });
  }

  const conversationScope = await resolveConversationScope({ engine, sessionId, sessionKey, params });
  if (!conversationScope.allConversations && conversationScope.conversationId == null) {
    return jsonTextResult({
      error: "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
    });
  }

  const limit = readPositiveInteger(params, "limit", DEFAULT_GREP_LIMIT, {
    min: 1,
    max: MAX_GREP_LIMIT,
  });
  const result = await retrieval.grep({
    query: pattern,
    mode,
    scope,
    conversationId: conversationScope.conversationId,
    conversationIds: conversationScope.conversationIds,
    limit,
    since,
    before,
    sort: effectiveSort,
  });

  const lines = [
    "## LCM Grep Results",
    `**Pattern:** \`${pattern}\``,
    `**Mode:** ${mode} | **Scope:** ${scope} | **Sort:** ${effectiveSort}`,
    formatConversationScope(conversationScope),
  ];
  if (since || before) {
    lines.push(
      `**Time filter:** ${since ? `since ${formatDisplayTime(since, timezone)}` : "since -infinity"} | ${
        before ? `before ${formatDisplayTime(before, timezone)}` : "before +infinity"
      }`,
    );
  }
  lines.push(`**Total matches:** ${result.totalMatches}`, "");

  let currentChars = lines.join("\n").length;
  if (result.messages.length > 0) {
    lines.push("### Messages", "");
    for (const message of result.messages) {
      const line = `- [msg#${message.messageId}] (${message.role}, ${formatDisplayTime(
        message.createdAt,
        timezone,
      )}): ${truncateSnippet(message.snippet)}`;
      if (currentChars + line.length > MAX_RESULT_CHARS) {
        lines.push("*(truncated - more results available)*");
        break;
      }
      lines.push(line);
      currentChars += line.length;
    }
    lines.push("");
  }

  if (result.summaries.length > 0) {
    lines.push("### Summaries", "");
    for (const summary of result.summaries) {
      const line = `- [${summary.summaryId}] (${summary.kind}, ${formatDisplayTime(
        summary.createdAt,
        timezone,
      )}): ${truncateSnippet(summary.snippet)}`;
      if (currentChars + line.length > MAX_RESULT_CHARS) {
        lines.push("*(truncated - more results available)*");
        break;
      }
      lines.push(line);
      currentChars += line.length;
    }
    lines.push("");
  }

  if (result.totalMatches === 0) lines.push("No matches found.");

  return textResult(lines.join("\n"), {
    messageCount: result.messages.length,
    summaryCount: result.summaries.length,
    totalMatches: result.totalMatches,
  });
}

function compactDescribeDetails(result) {
  if (!result) return result;
  if (result.type === "summary" && result.summary) {
    const { content: _content, subtree: _subtree, ...summary } = result.summary;
    return {
      id: result.id,
      type: result.type,
      summary,
    };
  }
  if (result.type === "file" && result.file) {
    const { explorationSummary: _explorationSummary, content: _content, ...file } = result.file;
    return {
      id: result.id,
      type: result.type,
      file: {
        ...file,
        hasExplorationSummary: Boolean(result.file.explorationSummary),
        contentTruncated: Boolean(result.file.contentTruncated),
      },
    };
  }
  return { id: result.id, type: result.type };
}

async function executeLcmDescribe({ engine, sessionId, sessionKey, params }) {
  const retrieval = engine.getRetrieval();
  const timezone = engine.timezone || "UTC";
  const id = readString(params, "id");
  if (!id) {
    throw new Error("lcm_describe requires a non-empty id.");
  }

  const conversationScope = await resolveConversationScope({ engine, sessionId, sessionKey, params });
  if (!conversationScope.allConversations && conversationScope.conversationId == null) {
    return jsonTextResult({
      error: "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
    });
  }

  const expandFile = readBoolean(params, "expandFile", false);
  const expandFileMaxBytes = readPositiveInteger(params, "expandFileMaxBytes", DEFAULT_EXPAND_FILE_BYTES, {
    min: 1_024,
    max: MAX_EXPAND_FILE_BYTES,
  });
  const result = await retrieval.describe(id, {
    expandFile,
    expandFileMaxBytes,
    largeFilesDir: engine.configView?.largeFilesDir,
  });

  if (!result) {
    return jsonTextResult({
      error: `Not found: ${id}`,
      hint: "Check the ID format (sum_xxx for summaries, file_xxx for files).",
    });
  }

  if (conversationScope.conversationId != null) {
    const itemConversationId =
      result.type === "summary" ? result.summary?.conversationId : result.file?.conversationId;
    const allowedConversationIds = new Set(conversationScope.conversationIds ?? [conversationScope.conversationId]);
    if (itemConversationId != null && !allowedConversationIds.has(itemConversationId)) {
      return jsonTextResult({
        error: `Not found in this session scope: ${id}`,
        hint: "Use allConversations=true for cross-conversation lookup.",
      });
    }
  }

  if (result.type === "summary" && result.summary) {
    const summary = result.summary;
    const tokenCap = readPositiveInteger(params, "tokenCap", 0);
    const summaryMeta = [
      `meta conv=${summary.conversationId}`,
      `kind=${summary.kind}`,
      `depth=${summary.depth}`,
      `tok=${summary.tokenCount}`,
      `descTok=${summary.descendantTokenCount}`,
      `srcTok=${summary.sourceMessageTokenCount}`,
      `desc=${summary.descendantCount}`,
      `range=${formatDisplayTime(summary.earliestAt, timezone)}..${formatDisplayTime(summary.latestAt, timezone)}`,
      tokenCap > 0 ? `budgetCap=${tokenCap}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const lines = [
      `LCM_SUMMARY ${id}`,
      summaryMeta,
    ];

    if (Array.isArray(summary.parentIds) && summary.parentIds.length > 0) {
      lines.push(`parents ${summary.parentIds.join(" ")}`);
    }
    if (Array.isArray(summary.childIds) && summary.childIds.length > 0) {
      lines.push(`children ${summary.childIds.join(" ")}`);
    }
    if (Array.isArray(summary.subtree) && summary.subtree.length > 0) {
      lines.push("manifest");
      for (const node of summary.subtree) {
        const summariesOnlyCost = Math.max(0, node.tokenCount + node.descendantTokenCount);
        const withMessagesCost = Math.max(0, summariesOnlyCost + node.sourceMessageTokenCount);
        lines.push([
          `d${node.depthFromRoot}`,
          node.summaryId,
          `k=${node.kind}`,
          `tok=${node.tokenCount}`,
          `descTok=${node.descendantTokenCount}`,
          `srcTok=${node.sourceMessageTokenCount}`,
          `desc=${node.descendantCount}`,
          `child=${node.childCount}`,
          `range=${formatDisplayTime(node.earliestAt, timezone)}..${formatDisplayTime(node.latestAt, timezone)}`,
          `cost[s=${summariesOnlyCost},m=${withMessagesCost}]`,
        ].join(" "));
      }
    }
    lines.push("content", summary.content);

    return textResult(lines.join("\n"), compactDescribeDetails(result));
  }

  if (result.type === "file" && result.file) {
    const file = result.file;
    const lines = [
      `## LCM File: ${id}`,
      "",
      `**Conversation:** ${file.conversationId}`,
      `**Name:** ${file.fileName ?? "(no name)"}`,
      `**Type:** ${file.mimeType ?? "unknown"}`,
      file.byteSize != null ? `**Size:** ${file.byteSize.toLocaleString()} bytes` : undefined,
      `**Created:** ${formatDisplayTime(file.createdAt, timezone)}`,
    ].filter(Boolean);

    if (file.explorationSummary) {
      lines.push("", "## Exploration Summary", "", file.explorationSummary);
    } else {
      lines.push("", "*No exploration summary available.*");
    }
    if (typeof file.content === "string") {
      lines.push("", "## Content", "", "```", file.content, "```");
      if (file.contentTruncated) {
        lines.push(
          "",
          `*Output truncated to ${file.content.length.toLocaleString()} of ${file.byteSize?.toLocaleString() ?? "?"} bytes.*`,
        );
      }
    } else if (expandFile) {
      lines.push("", "*Content unavailable: file missing on disk or path failed validation.*");
    }

    return textResult(lines.join("\n"), compactDescribeDetails(result));
  }

  return jsonTextResult(result);
}

export async function executeLcmRecallTool({
  engine,
  sessionId,
  sessionKey,
  toolName,
  params,
  expansionGrant,
  delegateExpandQuery,
}) {
  const normalizedToolName = String(toolName || "").trim();
  if (!LCM_RECALL_TOOL_NAMES.has(normalizedToolName)) {
    throw new Error(`Unknown LCM recall tool: ${normalizedToolName || "(missing)"}.`);
  }

  const normalizedParams = toRecord(params);
  if (normalizedToolName === "lcm_grep") {
    return executeLcmGrep({ engine, sessionId, sessionKey, params: normalizedParams });
  }
  if (normalizedToolName === "lcm_expand") {
    return executeLcmExpand({ engine, sessionId, sessionKey, params: normalizedParams, expansionGrant });
  }
  if (normalizedToolName === "lcm_expand_query") {
    return executeLcmExpandQuery({
      engine,
      sessionId,
      sessionKey,
      params: normalizedParams,
      delegateExpandQuery,
    });
  }
  return executeLcmDescribe({ engine, sessionId, sessionKey, params: normalizedParams });
}
