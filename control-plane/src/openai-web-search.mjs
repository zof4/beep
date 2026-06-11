const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function compactArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function responseLengthInstruction(value) {
  if (value === "short") return "Respond concisely and include source URLs when useful.";
  if (value === "long") return "Respond with a detailed answer and include source URLs.";
  return "Respond with enough detail to be useful and include source URLs.";
}

function commandPrompt(args = {}) {
  const lines = ["Use web search to satisfy this request.", responseLengthInstruction(args.response_length)];

  for (const query of compactArray(args.search_query)) {
    if (typeof query?.q === "string" && query.q.trim()) {
      lines.push(`Search query: ${query.q.trim()}`);
      if (Number.isInteger(query.recency)) lines.push(`Prefer results from the last ${query.recency} days.`);
    }
  }

  for (const item of compactArray(args.open)) {
    if (typeof item?.ref_id === "string" && item.ref_id.trim()) {
      lines.push(`Open or inspect: ${item.ref_id.trim()}`);
    }
  }

  for (const item of compactArray(args.find)) {
    if (typeof item?.ref_id === "string" && item.ref_id.trim() && typeof item?.pattern === "string") {
      lines.push(`Find "${item.pattern}" in ${item.ref_id.trim()}.`);
    }
  }

  return lines.join("\n");
}

function normalizeAllowedDomain(value) {
  if (typeof value !== "string") return null;
  let domain = value.trim();
  if (!domain) return null;

  if (/^https?:\/\//iu.test(domain)) {
    try {
      domain = new URL(domain).hostname;
    } catch {
      domain = domain.replace(/^https?:\/\//iu, "");
    }
  }

  domain = domain.replace(/\/+$/u, "").trim().toLowerCase();
  return domain || null;
}

function allowedDomains(args = {}) {
  const domains = new Set();
  for (const query of compactArray(args.search_query)) {
    for (const domain of compactArray(query?.domains)) {
      const normalized = normalizeAllowedDomain(domain);
      if (normalized) domains.add(normalized);
    }
  }
  return [...domains];
}

function textFragment(value) {
  if (typeof value === "string") return value;
  if (typeof value?.text === "string") return value.text;
  return null;
}

function outputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text;

  const fragments = [];
  for (const item of compactArray(payload?.output)) {
    const directText = textFragment(item);
    if (directText) fragments.push(directText);
    for (const content of compactArray(item?.content)) {
      const contentText = textFragment(content);
      if (contentText) fragments.push(contentText);
    }
  }

  return fragments.join("\n").trim();
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function normalizeSource(value) {
  if (!value || typeof value !== "object") return null;
  const citation = value.url_citation && typeof value.url_citation === "object" ? value.url_citation : null;
  const url = firstString(value.url, value.uri, value.href, citation?.url);
  const title = firstString(value.title, value.name, citation?.title);
  const snippet = firstString(value.snippet, value.summary, value.text);
  if (!url && !title) return null;

  return {
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

function extractSources(payload) {
  const sources = [];
  const seen = new Set();

  function addSource(value) {
    const source = normalizeSource(value);
    if (!source) return;
    const key = source.url || source.title;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push(source);
  }

  for (const item of compactArray(payload?.output)) {
    for (const source of compactArray(item?.action?.sources)) addSource(source);
    for (const annotation of compactArray(item?.annotations)) addSource(annotation);
    for (const content of compactArray(item?.content)) {
      for (const annotation of compactArray(content?.annotations)) addSource(annotation);
    }
  }

  return sources;
}

async function readResponseJson(response) {
  if (typeof response?.json !== "function") return {};
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function createWebRunExecutor({
  credentialResolver,
  fetchImpl = globalThis.fetch,
  model = process.env.BEEP_WEB_SEARCH_MODEL || "gpt-5.5",
} = {}) {
  if (typeof credentialResolver !== "function") {
    throw new Error("credentialResolver is required");
  }

  return {
    async run(args = {}) {
      const credential = await credentialResolver();
      if (!credential?.apiKey) throw new Error("OpenAI web search credential is unavailable");

      const domains = allowedDomains(args);
      const tool = domains.length
        ? { type: "web_search", filters: { allowed_domains: domains } }
        : { type: "web_search" };

      const response = await fetchImpl(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: commandPrompt(args),
          tools: [tool],
          tool_choice: "required",
        }),
      });
      const payload = await readResponseJson(response);

      if (!response.ok) {
        const message = payload?.error?.message || payload?.message || response.statusText || "request failed";
        throw new Error(`OpenAI web search failed: ${response.status} ${message}`);
      }

      const sources = extractSources(payload);
      return {
        ok: true,
        result: {
          text: outputText(payload) || "(no web search output)",
          responseId: payload.id || null,
          source: credential.source || "openai",
          ...(sources.length ? { sources } : {}),
        },
      };
    },
  };
}
