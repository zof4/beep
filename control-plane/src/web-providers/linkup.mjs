import {
  asStringArray,
  fetchJson,
  firstEnv,
  normalizedFetchResponse,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function linkupDepth(depth) {
  if (["fast", "standard", "deep"].includes(depth)) return depth;
  if (depth === "advanced") return "standard";
  return "standard";
}

export function createLinkupProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_LINKUP_API_KEY", "LINKUP_API_KEY"]);
  const baseUrl = firstEnv(env, ["BEEP_LINKUP_API_URL"]) || "https://api.linkup.so/v1";
  return {
    name: "linkup",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: true,
      rankedResults: true,
      extractedContent: true,
      sourcedAnswer: true,
      structuredOutput: true,
    },
    requiredEnv: ["BEEP_LINKUP_API_KEY", "LINKUP_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson(`${baseUrl.replace(/\/+$/u, "")}/search`, {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          q: request.query,
          depth: linkupDepth(request.depth),
          outputType: request.includeAnswer ? "sourcedAnswer" : "searchResults",
          maxResults: request.maxResults,
          includeDomains: asStringArray(request.includeDomains, 100),
          excludeDomains: asStringArray(request.excludeDomains, 100),
          fromDate: request.startDate || undefined,
          toDate: request.endDate || undefined,
          includeImages: false,
        },
      });

      const sources = Array.isArray(payload.sources)
        ? payload.sources
        : Array.isArray(payload.results)
          ? payload.results
          : [];
      return normalizedSearchResponse({
        provider: "linkup",
        query: request.query,
        answer: payload.answer || null,
        requestId: payload.id || payload.requestId || null,
        usage: payload.usage || null,
        results: sources.map((result) =>
          normalizedSearchResult({
            title: result.name || result.title,
            url: result.url,
            snippet: result.snippet || result.content,
            content: request.includeContent ? result.content || result.snippet || "" : "",
            publishedAt: result.date || result.publishedAt,
            score: result.score,
          }),
        ),
      });
    },

    async fetch(request, context) {
      const payload = await fetchJson(`${baseUrl.replace(/\/+$/u, "")}/fetch`, {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          url: request.url,
          renderJs: request.depth === "deep" || request.depth === "advanced",
          includeRawHtml: request.contentFormat === "html",
        },
      });
      return normalizedFetchResponse({
        provider: "linkup",
        url: request.url,
        title: payload.name || payload.title || "",
        content: payload.markdown || payload.content || payload.text || payload.rawHtml || "",
        publishedAt: payload.date || payload.publishedAt || null,
        requestId: payload.id || payload.requestId || null,
        usage: payload.usage || null,
      });
    },
  };
}
