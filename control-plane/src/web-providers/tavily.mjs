import {
  asStringArray,
  fetchJson,
  firstEnv,
  normalizedFetchResponse,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function freshnessToTimeRange(freshness) {
  if (freshness === "day") return "day";
  if (freshness === "week") return "week";
  if (freshness === "month") return "month";
  if (freshness === "year") return "year";
  return undefined;
}

function searchDepth(depth) {
  if (["ultra-fast", "fast", "basic", "advanced"].includes(depth)) return depth;
  if (depth === "deep" || depth === "standard") return "advanced";
  return "basic";
}

export function createTavilyProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_TAVILY_API_KEY", "TAVILY_API_KEY"]);
  return {
    name: "tavily",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: true,
      rankedResults: true,
      extractedContent: true,
      sourcedAnswer: true,
    },
    requiredEnv: ["BEEP_TAVILY_API_KEY", "TAVILY_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson("https://api.tavily.com/search", {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          query: request.query,
          search_depth: searchDepth(request.depth),
          max_results: request.maxResults,
          include_answer: request.includeAnswer ? "basic" : false,
          include_raw_content: request.includeContent ? "markdown" : false,
          include_domains: asStringArray(request.includeDomains, 300),
          exclude_domains: asStringArray(request.excludeDomains, 150),
          topic: request.topic || "general",
          time_range: freshnessToTimeRange(request.freshness),
          country: request.country || undefined,
        },
      });

      return normalizedSearchResponse({
        provider: "tavily",
        query: payload.query || request.query,
        answer: payload.answer || null,
        requestId: payload.request_id || null,
        usage: payload.usage || null,
        results: (payload.results || []).map((result) =>
          normalizedSearchResult({
            title: result.title,
            url: result.url,
            snippet: result.content,
            content: result.raw_content || "",
            score: result.score,
            publishedAt: result.published_date,
            metadata: {
              favicon: result.favicon || null,
            },
          }),
        ),
      });
    },

    async fetch(request, context) {
      const payload = await fetchJson("https://api.tavily.com/extract", {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          urls: [request.url],
          query: request.query || undefined,
          extract_depth: request.depth === "advanced" || request.depth === "deep" ? "advanced" : "basic",
          format: request.contentFormat === "text" ? "text" : "markdown",
          include_favicon: true,
        },
      });
      const result = Array.isArray(payload.results) ? payload.results[0] : null;
      return normalizedFetchResponse({
        provider: "tavily",
        url: request.url,
        title: result?.title || "",
        content: result?.raw_content || "",
        usage: payload.usage || null,
        requestId: payload.request_id || null,
        metadata: {
          failedResults: payload.failed_results || [],
          favicon: result?.favicon || null,
        },
      });
    },
  };
}
