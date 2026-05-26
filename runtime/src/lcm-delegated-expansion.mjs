import { randomUUID } from "node:crypto";
import { PiRpcSession } from "./pi-rpc-session.mjs";
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  newSessionId,
  nowIso,
  safeNumber,
} from "./runtime-common.mjs";

const DEFAULT_DELEGATED_TIMEOUT_MS = 120_000;
const GRANT_TTL_SKEW_MS = 30_000;
const expansionGrants = new Map();

function normalizeConversationIds(ids) {
  const normalized = [];
  const seen = new Set();
  for (const id of ids || []) {
    const value = Number(id);
    if (!Number.isInteger(value) || value <= 0 || seen.has(value)) continue;
    normalized.push(value);
    seen.add(value);
  }
  return normalized;
}

function pruneExpiredExpansionGrants(nowMs = Date.now()) {
  for (const [grantId, grant] of expansionGrants.entries()) {
    if (grant.expiresAtMs <= nowMs) expansionGrants.delete(grantId);
  }
}

export function createExpansionGrant({
  parentRuntimeSessionId,
  delegatedRuntimeSessionId,
  conversationIds,
  tokenCap,
  ttlMs,
}) {
  pruneExpiredExpansionGrants();
  const grantId = `lcm_exp_${randomUUID()}`;
  const normalizedConversationIds = normalizeConversationIds(conversationIds);
  if (!parentRuntimeSessionId || !delegatedRuntimeSessionId) {
    throw new Error("LCM delegated expansion grants require parent and delegated runtime session ids.");
  }
  if (normalizedConversationIds.length === 0) {
    throw new Error("LCM delegated expansion grants require at least one conversation id.");
  }
  const now = Date.now();
  const grant = {
    grantId,
    parentRuntimeSessionId,
    delegatedRuntimeSessionId,
    allowedConversationIds: normalizedConversationIds,
    tokenCap: Math.max(1, Math.trunc(Number(tokenCap || 1))),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(1_000, Number(ttlMs || DEFAULT_DELEGATED_TIMEOUT_MS))).toISOString(),
    expiresAtMs: now + Math.max(1_000, Number(ttlMs || DEFAULT_DELEGATED_TIMEOUT_MS)),
  };
  expansionGrants.set(grantId, grant);
  return grant;
}

export function revokeExpansionGrant(grantId) {
  if (!grantId) return false;
  return expansionGrants.delete(grantId);
}

export function resolveExpansionGrant({ grantId, delegatedRuntimeSessionId, parentRuntimeSessionId }) {
  pruneExpiredExpansionGrants();
  const grant = expansionGrants.get(String(grantId || ""));
  if (!grant) return null;
  if (delegatedRuntimeSessionId && grant.delegatedRuntimeSessionId !== delegatedRuntimeSessionId) return null;
  if (parentRuntimeSessionId && grant.parentRuntimeSessionId !== parentRuntimeSessionId) return null;
  return {
    grantId: grant.grantId,
    delegatedRuntimeSessionId: grant.delegatedRuntimeSessionId,
    parentRuntimeSessionId: grant.parentRuntimeSessionId,
    allowedConversationIds: [...grant.allowedConversationIds],
    tokenCap: grant.tokenCap,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
  };
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Delegated expansion returned an empty response.");
  try {
    return JSON.parse(raw);
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first === -1 || last <= first) {
      throw new Error("Delegated expansion did not return a JSON object.");
    }
    return JSON.parse(raw.slice(first, last + 1));
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function parseDelegatedExpansionReply(text) {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Delegated expansion response must be a JSON object.");
  }
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  if (!answer) {
    throw new Error("Delegated expansion response is missing a non-empty answer field.");
  }
  return {
    answer,
    citedIds: normalizeStringArray(parsed.citedIds),
    sourceConversationIds: Array.isArray(parsed.sourceConversationIds)
      ? parsed.sourceConversationIds
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0)
      : [],
    expandedSummaryCount: Number.isFinite(Number(parsed.expandedSummaryCount))
      ? Math.max(0, Math.trunc(Number(parsed.expandedSummaryCount)))
      : 0,
    totalSourceTokens: Number.isFinite(Number(parsed.totalSourceTokens))
      ? Math.max(0, Math.trunc(Number(parsed.totalSourceTokens)))
      : 0,
    truncated: Boolean(parsed.truncated),
    notes: typeof parsed.notes === "string" ? parsed.notes.trim() : "",
  };
}

function buildDelegatedExpansionTask({
  prompt,
  query,
  selectedCandidates,
  maxDepth,
  tokenCap,
  includeMessages,
  maxTokens,
}) {
  const summaryIds = selectedCandidates.map((candidate) => candidate.summaryId);
  const candidateLines = selectedCandidates.map((candidate) =>
    `- ${candidate.summaryId}: conversation=${candidate.conversationId}, kind=${candidate.kind}, source=${candidate.source}, tokens=${candidate.tokenCount}`,
  );
  return [
    "Run delegated LCM expansion for the main Beep agent.",
    "",
    "Use the LCM tools available in this session. Start by calling `lcm_expand` with the provided `summaryIds`, `maxDepth`, `tokenCap`, and `includeMessages` values. You may use `lcm_describe` or `lcm_grep` only if the first expansion is insufficient. Do not call `lcm_expand_query`.",
    "",
    "Focused prompt:",
    prompt,
    "",
    query ? `Candidate query: ${query}` : "Candidate query: none; explicit summary ids were provided.",
    "",
    "Candidate summaries:",
    ...candidateLines,
    "",
    "Required first tool call arguments:",
    JSON.stringify(
      {
        summaryIds,
        maxDepth,
        tokenCap,
        includeMessages,
      },
      null,
      2,
    ),
    "",
    `Keep the final answer under ${maxTokens} tokens if possible.`,
    "",
    "Return exactly one JSON object and no markdown:",
    JSON.stringify(
      {
        answer: "Focused answer based only on expanded LCM evidence.",
        citedIds: ["sum_example"],
        sourceConversationIds: selectedCandidates.map((candidate) => candidate.conversationId),
        expandedSummaryCount: 1,
        totalSourceTokens: 1,
        truncated: false,
        notes: "Optional missing-evidence note.",
      },
      null,
      2,
    ),
  ].join("\n");
}

export async function runPiDelegatedExpandQuery({
  sessions,
  lcmController,
  parentRuntimeSessionId,
  parentSession,
  prompt,
  query,
  selectedCandidates,
  maxDepth,
  tokenCap,
  includeMessages,
  maxTokens,
  timeoutMs,
}) {
  if (!sessions) throw new Error("LCM delegated expansion requires the runtime session registry.");
  if (!lcmController) throw new Error("LCM delegated expansion requires the LCM controller.");
  const conversationIds = normalizeConversationIds(selectedCandidates.map((candidate) => candidate.conversationId));
  const delegatedRuntimeSessionId = newSessionId("lcm_expansion");
  const effectiveTimeoutMs = safeNumber(timeoutMs, DEFAULT_DELEGATED_TIMEOUT_MS);
  const grant = createExpansionGrant({
    parentRuntimeSessionId,
    delegatedRuntimeSessionId,
    conversationIds,
    tokenCap,
    ttlMs: effectiveTimeoutMs + GRANT_TTL_SKEW_MS,
  });
  let delegatedSession = null;
  const startedAt = Date.now();
  try {
    delegatedSession = await PiRpcSession.start({
      id: delegatedRuntimeSessionId,
      model: parentSession?.model,
      thinking: parentSession?.thinking,
      sessions,
      lcmController,
      noSession: true,
      noBuiltinTools: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      toolAllowlist: ["lcm_grep", "lcm_describe", "lcm_expand"],
      loadLcmContextExtension: false,
      loadControlPlaneToolsExtension: false,
      lcmRuntimeSessionId: parentRuntimeSessionId,
      envOverrides: {
        BEEP_LCM_RECALL_TOOL_MODE: "delegated_expansion",
        BEEP_LCM_EXPANSION_GRANT_ID: grant.grantId,
        BEEP_LCM_DELEGATED_RUNTIME_SESSION_ID: delegatedRuntimeSessionId,
        BEEP_LCM_EXPANSION_PARENT_RUNTIME_SESSION_ID: parentRuntimeSessionId,
        BEEP_LCM_EXPANSION_ALLOWED_CONVERSATION_IDS: conversationIds.join(","),
        BEEP_LCM_EXPANSION_TOKEN_CAP: String(grant.tokenCap),
      },
    });
    const task = buildDelegatedExpansionTask({
      prompt,
      query,
      selectedCandidates,
      maxDepth,
      tokenCap: grant.tokenCap,
      includeMessages,
      maxTokens,
    });
    const promptResult = await delegatedSession.prompt(task, {
      waitForCompletion: true,
      timeoutMs: Math.min(effectiveTimeoutMs, DEFAULT_PROMPT_TIMEOUT_MS),
    });
    const finalText = promptResult.finalText || delegatedSession.lastAssistantText || "";
    const reply = parseDelegatedExpansionReply(finalText);
    return {
      ...reply,
      delegatedRuntimeSessionId,
      grantId: grant.grantId,
      durationMs: Date.now() - startedAt,
      candidateSummaryIds: selectedCandidates.map((candidate) => candidate.summaryId),
      completedAt: nowIso(),
    };
  } finally {
    revokeExpansionGrant(grant.grantId);
    if (delegatedSession) {
      await delegatedSession.stop().catch(() => null);
      sessions.delete(delegatedRuntimeSessionId);
    }
  }
}
