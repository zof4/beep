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

async function postJson(url, body, { token, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
  }
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

async function callControlPlaneTool(action, args, toolCallId) {
  const controlPlaneUrl = process.env.BEEP_CONTROL_PLANE_URL;
  const token = process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN;
  const runtimeId = process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || "local";
  if (!controlPlaneUrl || !token) {
    return {
      configured: false,
      response: null,
      payload: {
        ok: false,
        status: "not_configured",
        error: "Control-plane tool capability is not configured in this runtime.",
      },
    };
  }

  const { response, payload } = await postJson(
    `${controlPlaneUrl.replace(/\/+$/u, "")}/internal/tools/call`,
    {
      runtimeId,
      action,
      args,
      toolCallId,
    },
    {
      token,
      timeoutMs: positiveIntegerEnv("BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS", 15_000),
    },
  );
  return { configured: true, response, payload };
}

function resultFromToolPayload(toolName, response, payload, successText) {
  if (payload?.status === "needs_review") {
    return textResult(
      [
        `${toolName} is waiting for user/operator approval.`,
        `approvalId: ${payload.approvalId}`,
        payload.approval?.prompt || payload.error || "",
      ]
        .filter(Boolean)
        .join("\n"),
      payload,
    );
  }
  if (!response?.ok || !payload?.ok) {
    return textResult(`${toolName} failed: ${payload?.error || response?.statusText || "not configured"}`, {
      ...payload,
      ok: false,
    });
  }
  return textResult(successText(payload.result), payload);
}

function formatWebSearchResult(result) {
  const lines = [
    `web_search provider: ${result.selectedProvider || result.provider}`,
    `query: ${result.query}`,
  ];
  if (result.answer) {
    lines.push("", "answer:", result.answer);
  }
  lines.push("", "results:");
  for (const [index, item] of (result.results || []).entries()) {
    lines.push(`${index + 1}. ${item.title || item.url}`);
    lines.push(`   url: ${item.url}`);
    if (item.publishedAt) lines.push(`   published: ${item.publishedAt}`);
    if (item.snippet) lines.push(`   snippet: ${item.snippet}`);
    if (item.content) lines.push(`   content: ${item.content}`);
  }
  if (!Array.isArray(result.results) || result.results.length === 0) {
    lines.push("No results.");
  }
  return lines.join("\n");
}

function formatWebFetchResult(result) {
  return [
    `web_fetch provider: ${result.selectedProvider || result.provider}`,
    result.title ? `title: ${result.title}` : null,
    `url: ${result.url}`,
    result.publishedAt ? `published: ${result.publishedAt}` : null,
    "",
    result.content || "No extracted content returned.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export default function beepControlPlaneToolsExtension(pi) {
  if (!boolEnv("BEEP_CONTROL_PLANE_TOOLS_ENABLED", true)) return;

  pi.registerTool({
    name: "preview_port_expose",
    label: "Expose Preview Port",
    description:
      "Expose an HTTP dev server running inside the runtime container so it can be tested from the local browser.",
    promptSnippet:
      "Use preview_port_expose after starting a local web server inside the runtime container on a 3000-3099 port.",
    promptGuidelines: [
      "Start browser-testable dev servers on 0.0.0.0, not localhost, before exposing the port.",
      "Only use preview_port_expose for HTTP preview servers that should be visible to the local control surface.",
    ],
    parameters: Type.Object({
      port: Type.Integer({
        minimum: 3000,
        maximum: 3099,
        description: "Container port where the dev server is listening.",
      }),
      path: Type.Optional(Type.String({ description: "Optional initial path to open." })),
      label: Type.Optional(Type.String({ description: "Optional short label for the preview." })),
    }),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool("preview.port.expose", params, toolCallId);
      return resultFromToolPayload("preview_port_expose", response, payload, (result) =>
        [
          `Preview exposed: ${result.url}`,
          `Direct mapped URL: ${result.directUrl}`,
          result.note,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "preview_container_create_static_site",
    label: "Create Static Preview Container",
    description:
      "Request a managed static-site preview container for a directory already created inside the runtime workspace.",
    promptSnippet:
      "Use preview_container_create_static_site when a static site directory is ready and should run in its own managed preview container.",
    promptGuidelines: [
      "Only request a static-site container for directories inside /workspace.",
      "Create an index.html in the source directory before requesting the preview container.",
      "This tool requires user/operator approval before the container is created.",
    ],
    parameters: Type.Object({
      siteName: Type.String({ description: "Short site name for labels and display." }),
      sourcePath: Type.String({
        description: "Absolute runtime path to the static site directory, for example /workspace/api-sessions/agent_beep/site.",
      }),
    }),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool(
        "preview.container.createStaticSite",
        params,
        toolCallId,
      );
      return resultFromToolPayload("preview_container_create_static_site", response, payload, (result) =>
        [
          `Static preview container created: ${result.proxyUrl}`,
          `Direct mapped URL: ${result.directUrl}`,
          `siteId: ${result.siteId}`,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web through Beep's control-plane web tool service. Results are returned with URLs, snippets, and optional extracted content.",
    promptSnippet:
      "Use web_search when the user asks for current, external, or source-backed information that is not already in the workspace or LCM.",
    promptGuidelines: [
      "Use web_search for current facts, external docs, news, pricing, API changes, laws, schedules, and other information likely to change.",
      "Prefer official or primary sources by using includeDomains when the user needs technical, legal, medical, financial, or product accuracy.",
      "Do not use provider unless the user asks to compare providers or evaluate search quality.",
      "Use web_fetch after web_search when the answer depends on exact page content beyond a snippet.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      provider: Type.Optional(
        StringEnum(["tavily", "exa", "brave", "firecrawl", "linkup", "perplexity", "serpapi"], {
          description: "Optional provider override for evaluation. Omit for the configured search provider.",
        }),
      ),
      maxResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: "Maximum ranked results to return. Default: 5.",
        }),
      ),
      freshness: Type.Optional(
        StringEnum(["day", "week", "month", "year"], {
          description: "Optional freshness filter.",
        }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional domain allowlist, for example [\"openai.com\"].",
        }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional domain denylist.",
        }),
      ),
      country: Type.Optional(Type.String({ description: "Optional country or region hint, for example US." })),
      language: Type.Optional(Type.String({ description: "Optional language hint, for example en." })),
      includeContent: Type.Optional(
        Type.Boolean({
          description: "When supported, include extracted page text or markdown with results.",
        }),
      ),
      includeAnswer: Type.Optional(
        Type.Boolean({
          description: "When supported, include a provider-generated sourced answer.",
        }),
      ),
    }),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool("web.search", params, toolCallId);
      return resultFromToolPayload("web_search", response, payload, formatWebSearchResult);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract a specific public URL through Beep's control-plane web tool service.",
    promptSnippet:
      "Use web_fetch when a search result or user-provided URL needs exact source text before answering.",
    promptGuidelines: [
      "Use web_fetch for exact quotes, API details, changelogs, docs, or claims where snippets are not enough.",
      "Do not fetch localhost, private network addresses, or workspace files.",
      "Do not use provider unless the user asks to compare providers or evaluate extraction quality.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Public http(s) URL to fetch." }),
      provider: Type.Optional(
        StringEnum(["tavily", "exa", "firecrawl", "linkup"], {
          description: "Optional provider override for evaluation. Omit for the configured fetch provider.",
        }),
      ),
      query: Type.Optional(
        Type.String({
          description: "Optional intent for providers that can rerank or summarize extracted content.",
        }),
      ),
      contentFormat: Type.Optional(
        StringEnum(["markdown", "text", "html"], {
          description: "Preferred extracted content format. Default: markdown.",
        }),
      ),
    }),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool("web.fetch", params, toolCallId);
      return resultFromToolPayload("web_fetch", response, payload, formatWebFetchResult);
    },
  });
}
