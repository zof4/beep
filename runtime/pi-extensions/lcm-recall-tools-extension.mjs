import { StringEnum, Type } from "@earendil-works/pi-ai";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requestedTimeoutMs(params, fallback) {
  const parsed = Number.parseInt(String(params?.timeoutMs ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1_000, Math.min(180_000, parsed));
}

async function postJson(url, body, { token, timeoutMs, signal }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function configuredToolCall(toolName, params, toolCallId, signal) {
  const url = process.env.BEEP_LCM_RECALL_TOOL_URL;
  const token = process.env.BEEP_LCM_RECALL_TOOL_TOKEN;
  const runtimeSessionId = process.env.BEEP_LCM_RUNTIME_SESSION_ID;
  if (!url || !token || !runtimeSessionId) {
    throw new Error("LCM recall tools are not configured in this runtime.");
  }

  return postJson(
    url,
    {
      runtimeSessionId,
      delegatedRuntimeSessionId: process.env.BEEP_LCM_DELEGATED_RUNTIME_SESSION_ID || undefined,
      expansionGrantId: process.env.BEEP_LCM_EXPANSION_GRANT_ID || undefined,
      toolName,
      toolCallId,
      params,
    },
    {
      token,
      timeoutMs: requestedTimeoutMs(params, positiveIntegerEnv("BEEP_LCM_RECALL_TOOL_TIMEOUT_MS", 30_000)),
      signal,
    },
  );
}

async function executeRecallTool(toolName, params, toolCallId, signal) {
  const { response, payload } = await configuredToolCall(toolName, params, toolCallId, signal);
  if (!response.ok || !payload?.ok || !payload?.result) {
    throw new Error(payload?.error || response.statusText || `${toolName} failed.`);
  }
  return payload.result;
}

const LCM_RECALL_POLICY_MARKER = "## Beep Lossless Recall Policy";

const LCM_RECALL_POLICY_PROMPT = [
  LCM_RECALL_POLICY_MARKER,
  "",
  "Beep's LCM recall surface is active.",
  "",
  "Use LCM recall tools when answering questions about prior conversation content, previous decisions, exact commands, paths, timestamps, tool outputs, or details that may have been compacted out of active context.",
  "",
  "If newer evidence conflicts with older recalled content or summaries, prefer the newer evidence. Do not trust an old summary over fresher contradictory context.",
  "",
  "If facts seem contradictory or uncertain, verify with LCM recall tools before answering instead of guessing from compacted context.",
  "",
  "Recall flow:",
  "1. Use `lcm_grep` to search messages and compacted summaries.",
  "2. Use `lcm_describe` when `lcm_grep` returns a summary id or file id that needs more detail.",
  "3. Use `lcm_expand_query` for broad or source-sensitive historical questions where one grep result is not enough.",
  "4. Answer from retrieved evidence. Keep raw summary ids out of user-facing prose unless the user asks for sources or ids.",
  "",
  "`lcm_grep` guidance:",
  '- Prefer `mode: "full_text"` for keyword or topical recall.',
  '- Use `mode: "regex"` for real regular expressions, anchors, alternation, character classes, or wildcard syntax.',
  "- Keep full-text queries short: use 1-3 distinctive terms or one quoted phrase.",
  '- Keep the default `sort: "recency"` for "what just happened?" lookups.',
  '- Use `sort: "relevance"` or `sort: "hybrid"` when searching older topical history.',
  "",
  "`lcm_expand_query` guidance:",
  "- Always provide `prompt`; put the actual question to answer in prompt.",
  "- Use `query` for a short FTS-style candidate search, or pass `summaryIds` from lcm_grep/lcm_describe.",
  "- Keep `query` short: 1-3 distinctive terms or one quoted phrase.",
  "- `lcm_expand_query` creates a bounded delegated Pi expansion session and returns a compact answer with cited LCM summary IDs.",
  "- Set `includeMessages: true` when the answer depends on exact commands, paths, timestamps, user wording, or tool output.",
  "",
  "Compacted summaries are recall cues, not proof of exact wording or exact values. For exact commands, SHAs, paths, timestamps, config values, or causal chains, inspect source-backed results before making the claim.",
].join("\n");

const LCM_DELEGATED_EXPANSION_POLICY_MARKER = "## Beep Delegated LCM Expansion Policy";

const LCM_DELEGATED_EXPANSION_POLICY_PROMPT = [
  LCM_DELEGATED_EXPANSION_POLICY_MARKER,
  "",
  "You are a delegated LCM expansion worker for Beep's main agent.",
  "",
  "Your job is narrow: recover source-backed evidence from LCM and return a compact JSON answer to the main agent. Use only the LCM tools available in this session.",
  "",
  "Tool rules:",
  "1. Start with `lcm_expand` using the summary IDs and budgets from the task.",
  "2. Use `lcm_describe` only for a specific summary or file ID that needs inspection.",
  "3. Use `lcm_grep` only if the initial expansion is insufficient.",
  "4. Never call `lcm_expand_query` from this delegated session.",
  "5. Do not use shell, file-editing, web, preview, or control-plane tools.",
  "",
  "Return exactly one JSON object and no markdown. Required fields: `answer`, `citedIds`, `sourceConversationIds`, `expandedSummaryCount`, `totalSourceTokens`, and `truncated`. Add `notes` only if evidence is missing or uncertain.",
].join("\n");

function addLcmRecallPolicy(systemPrompt) {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(LCM_RECALL_POLICY_MARKER)) return base;
  return `${base.trimEnd()}\n\n${LCM_RECALL_POLICY_PROMPT}`.trim();
}

function addLcmDelegatedExpansionPolicy(systemPrompt) {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(LCM_DELEGATED_EXPANSION_POLICY_MARKER)) return base;
  return `${base.trimEnd()}\n\n${LCM_DELEGATED_EXPANSION_POLICY_PROMPT}`.trim();
}

export default function beepLcmRecallToolsExtension(pi) {
  if (!boolEnv("BEEP_LCM_RECALL_TOOLS_ENABLED", true)) return;
  const delegatedExpansionMode = process.env.BEEP_LCM_RECALL_TOOL_MODE === "delegated_expansion";

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: delegatedExpansionMode
      ? addLcmDelegatedExpansionPolicy(event.systemPrompt)
      : addLcmRecallPolicy(event.systemPrompt),
  }));

  pi.registerTool({
    name: "lcm_grep",
    label: "LCM Grep",
    description:
      "Search Beep's stored conversation memory using regex or full-text search across messages and compacted summaries.",
    promptSnippet: "Search prior conversation memory by regex or full-text query.",
    promptGuidelines: [
      [
        "Use lcm_grep when the user asks about prior conversation details,",
        "previous decisions, or information that may have fallen out of active context.",
      ].join(" "),
      "Use lcm_grep with mode full_text for short literal topic searches, and mode regex only for real regular expressions.",
      "Keep lcm_grep full_text queries short: use 1-3 distinctive terms or one quoted phrase.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description:
          [
            'Search pattern. In mode "regex", this is a regular expression.',
            'In mode "full_text", this is an FTS-style literal query;',
            "prefer 1-3 distinctive terms or one quoted phrase.",
          ].join(" "),
      }),
      mode: Type.Optional(
        StringEnum(["regex", "full_text"], {
          description: 'Search mode. Default: "regex".',
          default: "regex",
        }),
      ),
      scope: Type.Optional(
        StringEnum(["messages", "summaries", "both"], {
          description: 'What to search. Default: "both".',
          default: "both",
        }),
      ),
      conversationId: Type.Optional(
        Type.Number({
          description:
            "Physical LCM conversation id to search. If omitted, the tool searches the current session family.",
        }),
      ),
      allConversations: Type.Optional(
        Type.Boolean({
          description:
            "Set true to intentionally search all LCM conversations instead of only the current session family.",
        }),
      ),
      since: Type.Optional(Type.String({ description: "Only return matches at or after this ISO timestamp." })),
      before: Type.Optional(Type.String({ description: "Only return matches before this ISO timestamp." })),
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of results to return. Default: 50.",
        }),
      ),
      sort: Type.Optional(
        StringEnum(["recency", "relevance", "hybrid"], {
          description:
            'Sort order. "relevance" and "hybrid" only affect full_text mode. Default: "recency".',
          default: "recency",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      return executeRecallTool("lcm_grep", params, toolCallId, signal);
    },
  });

  pi.registerTool({
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Look up an LCM memory item by id, including compacted summary content or stored tool-output file metadata.",
    promptSnippet: "Inspect a specific LCM summary or stored file by id.",
    promptGuidelines: [
      "Use lcm_describe after lcm_grep returns a summary id or file id that needs more detail.",
      "Use lcm_describe with expandFile true when a prior result references an LCM file id and the answer depends on its exact content.",
    ],
    parameters: Type.Object({
      id: Type.String({
        description: "The LCM id to inspect. Summary ids start with sum_; stored file ids start with file_.",
      }),
      conversationId: Type.Optional(
        Type.Number({
          description:
            "Physical LCM conversation id to scope the lookup. If omitted, uses the current session family.",
        }),
      ),
      allConversations: Type.Optional(
        Type.Boolean({
          description:
            "Set true to intentionally allow lookup across all LCM conversations instead of only the current session family.",
        }),
      ),
      tokenCap: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Optional token budget used for summary manifest budget annotations.",
        }),
      ),
      expandFile: Type.Optional(
        Type.Boolean({
          description:
            "When true and id is a file id, inline file content up to expandFileMaxBytes.",
        }),
      ),
      expandFileMaxBytes: Type.Optional(
        Type.Number({
          minimum: 1024,
          maximum: 512000,
          description: "Maximum bytes of inlined file content when expandFile is true. Default: 32768.",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      return executeRecallTool("lcm_describe", params, toolCallId, signal);
    },
  });

  if (delegatedExpansionMode) {
    pi.registerTool({
      name: "lcm_expand",
      label: "LCM Expand",
      description:
        "Delegated-only LCM source expansion. Traverses selected summary DAG nodes and returns children/source messages under the scoped expansion grant.",
      promptSnippet: "Expand delegated LCM summary IDs into source evidence.",
      promptGuidelines: [
        "Use lcm_expand as the first tool call in delegated LCM expansion tasks.",
        "Pass the summaryIds, maxDepth, tokenCap, and includeMessages values from the task.",
        "Use only the returned source evidence when producing the final JSON answer.",
      ],
      parameters: Type.Object({
        summaryIds: Type.Optional(
          Type.Array(Type.String(), {
            description: "Summary IDs to expand directly. Required when query is omitted.",
          }),
        ),
        query: Type.Optional(
          Type.String({
            description:
              "Optional full-text candidate search inside the delegated grant scope. Use only if summaryIds are not enough.",
          }),
        ),
        conversationId: Type.Optional(
          Type.Number({
            description: "Optional physical LCM conversation id. Must be inside the delegated grant scope.",
          }),
        ),
        allConversations: Type.Optional(
          Type.Boolean({
            description: "Search all conversations allowed by the delegated grant scope.",
          }),
        ),
        candidateLimit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 50,
            description: "Maximum candidate summaries to expand. Default: 8.",
          }),
        ),
        maxDepth: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 8,
            description: "Maximum summary DAG expansion depth. Default: 3.",
          }),
        ),
        tokenCap: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: 64000,
            description: "Expansion source token cap. Clamped by the delegated grant.",
          }),
        ),
        includeMessages: Type.Optional(
          Type.Boolean({
            description: "Include raw source messages at leaf summaries. Default: true.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            minimum: 1000,
            maximum: 180000,
            description: "Optional HTTP timeout for this expansion call. Default comes from runtime config.",
          }),
        ),
      }),
      async execute(toolCallId, params, signal) {
        return executeRecallTool("lcm_expand", params, toolCallId, signal);
      },
    });
    return;
  }

  pi.registerTool({
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Search Beep's LCM summary DAG for a focused historical question, spawn a bounded delegated Pi expansion session, and return a compact cited answer.",
    promptSnippet: "Delegate focused prior-memory expansion and return a cited answer.",
    promptGuidelines: [
      "Use lcm_expand_query for broad prior-history questions where lcm_grep alone would return too little context.",
      "Always put the user-facing question or task in prompt.",
      "Use query for 1-3 distinctive terms or one quoted phrase, or pass summaryIds found by lcm_grep.",
      "Set includeMessages true for exact commands, paths, timestamps, config values, or user wording.",
      "Use allConversations true only when the user explicitly wants cross-conversation recall.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "Focused question or task to answer using expanded LCM evidence.",
      }),
      query: Type.Optional(
        Type.String({
          description:
            'Optional full-text candidate search. Use 1-3 distinctive terms or one quoted phrase. Required when summaryIds is omitted.',
        }),
      ),
      summaryIds: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional summary IDs to expand directly. Required when query is omitted.",
        }),
      ),
      conversationId: Type.Optional(
        Type.Number({
          description:
            "Physical LCM conversation id to scope expansion. If omitted, searches the current session family.",
        }),
      ),
      allConversations: Type.Optional(
        Type.Boolean({
          description:
            "Set true to intentionally allow cross-conversation expansion instead of only the current session family.",
        }),
      ),
      candidateLimit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 50,
          description: "Maximum candidate summaries to expand. Default: 8.",
        }),
      ),
      maxDepth: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 8,
          description: "Maximum summary DAG expansion depth. Default: 3.",
        }),
      ),
      tokenCap: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 64000,
          description: "Expansion source token cap. Default: 12000.",
        }),
      ),
      maxTokens: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 16000,
          description: "Maximum delegated answer token budget. Default: 2000.",
        }),
      ),
      includeMessages: Type.Optional(
        Type.Boolean({
          description:
            "Include raw source messages at leaf summaries. Default: true for source-backed recall.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: 180000,
          description: "Optional HTTP timeout for this expansion call. Default comes from runtime config.",
        }),
      ),
    }),
    async execute(toolCallId, params, signal) {
      return executeRecallTool("lcm_expand_query", params, toolCallId, signal);
    },
  });
}
