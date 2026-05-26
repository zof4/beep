import assert from "node:assert/strict";
import test from "node:test";
import {
  LCM_RECALL_TOOL_NAMES,
  executeLcmRecallTool,
} from "../src/lcm-recall-tools.mjs";

const NOW = new Date("2026-05-24T12:00:00.000Z");

function summaryRecord(overrides = {}) {
  return {
    conversationId: 7,
    kind: "condensed",
    content: "LCM expand query is available as a direct recall tool.",
    depth: 2,
    tokenCount: 18,
    descendantCount: 1,
    descendantTokenCount: 20,
    sourceMessageTokenCount: 20,
    fileIds: [],
    parentIds: [],
    childIds: ["sum_leaf"],
    messageIds: [],
    subtree: [],
    earliestAt: NOW,
    latestAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function textFromToolResult(result) {
  return result.content?.[0]?.text || "";
}

function createFakeEngine({
  summaryMatches = [{ summaryId: "sum_root", conversationId: 7, kind: "condensed", createdAt: NOW }],
  messageMatches = [],
  summaries = {
    sum_root: summaryRecord(),
    sum_leaf: summaryRecord({
      kind: "leaf",
      content: "Source detail: add secondary memory for search and recall beside the LCM continuity baseline.",
      depth: 0,
      tokenCount: 20,
      childIds: [],
      messageIds: [11],
    }),
  },
  expanded = {
    children: [
      {
        summaryId: "sum_leaf",
        kind: "leaf",
        content: "Source detail: add secondary memory for search and recall beside the LCM continuity baseline.",
        tokenCount: 20,
      },
    ],
    messages: [
      {
        messageId: 11,
        role: "user",
        content: "We should have our LCM system in place before adding secondary memory search and recall.",
        tokenCount: 14,
      },
    ],
    estimatedTokens: 34,
    truncated: false,
  },
  maxSummaryDepth = 2,
  leafLinks = [],
  conversationId = 7,
} = {}) {
  const grepCalls = [];
  const expandCalls = [];
  return {
    timezone: "UTC",
    grepCalls,
    expandCalls,
    getConversationStore() {
      return {
        async getConversationBySessionKey() {
          return conversationId == null ? null : { conversationId };
        },
        async getConversationBySessionId() {
          return conversationId == null ? null : { conversationId };
        },
        async getConversationFamilyIds() {
          return conversationId == null ? [] : [conversationId];
        },
      };
    },
    getSummaryStore() {
      return {
        async getConversationMaxSummaryDepth() {
          return maxSummaryDepth;
        },
        async getLeafSummaryLinksForMessageIds() {
          return leafLinks;
        },
      };
    },
    getRetrieval() {
      return {
        async grep(input) {
          grepCalls.push(input);
          if (input.scope === "summaries") {
            return { messages: [], summaries: summaryMatches, totalMatches: summaryMatches.length };
          }
          return { messages: messageMatches, summaries: [], totalMatches: messageMatches.length };
        },
        async describe(id) {
          const summary = summaries[id];
          if (!summary) return null;
          return { id, type: "summary", summary };
        },
        async expand(input) {
          expandCalls.push(input);
          return expanded;
        },
      };
    },
  };
}

test("LCM recall tool surface includes query expansion", () => {
  assert.equal(LCM_RECALL_TOOL_NAMES.has("lcm_grep"), true);
  assert.equal(LCM_RECALL_TOOL_NAMES.has("lcm_describe"), true);
  assert.equal(LCM_RECALL_TOOL_NAMES.has("lcm_expand"), true);
  assert.equal(LCM_RECALL_TOOL_NAMES.has("lcm_expand_query"), true);
});

test("lcm_expand_query delegates summary search results into a cited answer", async () => {
  const engine = createFakeEngine();
  let delegatedRequest;
  const result = await executeLcmRecallTool({
    engine,
    sessionId: "runtime-session",
    sessionKey: "beep:pi:runtime-session",
    toolName: "lcm_expand_query",
    params: {
      query: "memory recall",
      prompt: "What should be ready before secondary memory testing?",
      includeMessages: true,
      tokenCap: 4000,
    },
    async delegateExpandQuery(request) {
      delegatedRequest = request;
      return {
        answer: "LCM should be ready before adding secondary memory search and recall.",
        citedIds: ["sum_root", "sum_leaf"],
        sourceConversationIds: [7],
        expandedSummaryCount: 2,
        totalSourceTokens: 52,
        truncated: false,
        delegatedRuntimeSessionId: "lcm_expansion_test",
        grantId: "grant_test",
      };
    },
  });

  const text = textFromToolResult(result);
  assert.match(text, /## LCM Expand Query/u);
  assert.match(text, /LCM should be ready/u);
  assert.match(text, /lcm_expansion_test/u);
  assert.equal(result.details.candidateCount, 1);
  assert.equal(result.details.delegated, true);
  assert.equal(result.details.expandedSummaryCount, 2);
  assert.deepEqual(result.details.citedIds, ["sum_root", "sum_leaf"]);
  assert.deepEqual(result.details.sourceConversationIds, [7]);
  assert.equal(engine.expandCalls.length, 0);
  assert.equal(delegatedRequest.prompt, "What should be ready before secondary memory testing?");
  assert.deepEqual(
    delegatedRequest.selectedCandidates.map((candidate) => candidate.summaryId),
    ["sum_root"],
  );
  assert.equal(delegatedRequest.tokenCap, 4000);
});

test("lcm_expand_query delegates message hits resolved back to linked leaf summaries", async () => {
  const engine = createFakeEngine({
    summaryMatches: [],
    messageMatches: [
      {
        messageId: 22,
        conversationId: 7,
        role: "assistant",
        snippet: "secondary memory recall",
        createdAt: NOW,
      },
    ],
    summaries: {
      sum_leaf_from_message: summaryRecord({
        kind: "leaf",
        content: "A message-backed leaf summary for secondary memory recall testing.",
        depth: 0,
        tokenCount: 16,
        childIds: [],
        messageIds: [22],
      }),
    },
    leafLinks: [{ messageId: 22, summaryId: "sum_leaf_from_message" }],
    maxSummaryDepth: 1,
    expanded: {
      children: [],
      messages: [
        {
          messageId: 22,
          role: "assistant",
          content: "Secondary memory should be added beside LCM for search and recall.",
          tokenCount: 12,
        },
      ],
      estimatedTokens: 12,
      truncated: false,
    },
  });

  let delegatedRequest;
  const result = await executeLcmRecallTool({
    engine,
    sessionId: "runtime-session",
    sessionKey: "beep:pi:runtime-session",
    toolName: "lcm_expand_query",
    params: {
      query: "secondary memory",
      prompt: "What should secondary memory do?",
    },
    async delegateExpandQuery(request) {
      delegatedRequest = request;
      return {
        answer: "Secondary memory should be added beside LCM for search and recall.",
        citedIds: ["sum_leaf_from_message"],
        sourceConversationIds: [7],
        expandedSummaryCount: 1,
        totalSourceTokens: 28,
        truncated: false,
      };
    },
  });

  const text = textFromToolResult(result);
  assert.match(text, /sum_leaf_from_message/u);
  assert.match(text, /Secondary memory should be added beside LCM/u);
  assert.equal(result.details.summaryMatchCount, 0);
  assert.equal(result.details.messageMatchCount, 1);
  assert.equal(result.details.expandedSummaryCount, 1);
  assert.equal(delegatedRequest.selectedCandidates[0].source, "message_search");
  assert.deepEqual(delegatedRequest.selectedCandidates[0].summaryId, "sum_leaf_from_message");
});

test("lcm_expand_query rejects regex syntax in full-text candidate queries", async () => {
  const engine = createFakeEngine();
  const result = await executeLcmRecallTool({
    engine,
    sessionId: "runtime-session",
    sessionKey: "beep:pi:runtime-session",
    toolName: "lcm_expand_query",
    params: {
      query: "LCM|memory",
      prompt: "Find memory context.",
    },
  });

  assert.equal(result.details.error.includes("full_text mode does not support regex syntax"), true);
  assert.equal(engine.grepCalls.length, 0);
});

test("lcm_expand expands source evidence only with a delegated grant", async () => {
  const engine = createFakeEngine();
  const result = await executeLcmRecallTool({
    engine,
    sessionId: "runtime-session",
    sessionKey: "beep:pi:runtime-session",
    toolName: "lcm_expand",
    params: {
      summaryIds: ["sum_root"],
      includeMessages: true,
      tokenCap: 4000,
    },
    expansionGrant: {
      grantId: "grant_test",
      allowedConversationIds: [7],
      tokenCap: 4000,
    },
  });

  const text = textFromToolResult(result);
  assert.match(text, /## LCM Expand/u);
  assert.match(text, /sum_root/u);
  assert.match(text, /sum_leaf/u);
  assert.match(text, /msg#11/u);
  assert.deepEqual(result.details.citedIds, ["sum_root", "sum_leaf"]);
  assert.deepEqual(engine.expandCalls, [
    {
      summaryId: "sum_root",
      depth: 3,
      includeMessages: true,
      tokenCap: 3982,
    },
  ]);
});

test("lcm_expand defaults to delegated grant scope when worker has no conversation", async () => {
  const engine = createFakeEngine({ conversationId: null });
  const result = await executeLcmRecallTool({
    engine,
    sessionId: "delegated-runtime-session",
    sessionKey: "beep:pi:delegated-runtime-session",
    toolName: "lcm_expand",
    params: {
      summaryIds: ["sum_root"],
      includeMessages: true,
    },
    expansionGrant: {
      grantId: "grant_test",
      allowedConversationIds: [7],
      tokenCap: 4000,
    },
  });

  assert.match(textFromToolResult(result), /## LCM Expand/u);
  assert.deepEqual(result.details.sourceConversationIds, [7]);
});

test("lcm_expand rejects main-agent calls without a delegated grant", async () => {
  const result = await executeLcmRecallTool({
    engine: createFakeEngine(),
    sessionId: "runtime-session",
    sessionKey: "beep:pi:runtime-session",
    toolName: "lcm_expand",
    params: {
      summaryIds: ["sum_root"],
    },
  });

  assert.equal(result.details.errorCode, "LCM_EXPAND_REQUIRES_DELEGATED_GRANT");
});

test("lcm_expand enforces delegated grant conversation scope", async () => {
  await assert.rejects(
    executeLcmRecallTool({
      engine: createFakeEngine(),
      sessionId: "runtime-session",
      sessionKey: "beep:pi:runtime-session",
      toolName: "lcm_expand",
      params: {
        summaryIds: ["sum_root"],
      },
      expansionGrant: {
        grantId: "grant_test",
        allowedConversationIds: [99],
        tokenCap: 4000,
      },
    }),
    /outside the delegated expansion grant scope/u,
  );
});

test("lcm_expand_query enforces current-session scope for explicit summary IDs", async () => {
  await assert.rejects(
    executeLcmRecallTool({
      engine: createFakeEngine({
        summaries: {
          sum_other: summaryRecord({ conversationId: 99 }),
        },
      }),
      sessionId: "runtime-session",
      sessionKey: "beep:pi:runtime-session",
      toolName: "lcm_expand_query",
      params: {
        summaryIds: ["sum_other"],
        prompt: "Inspect the other summary.",
      },
    }),
    /outside the current conversation scope/u,
  );
});
