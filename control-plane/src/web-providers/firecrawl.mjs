import {
  asStringArray,
  fetchJson,
  firstEnv,
  normalizedFetchResponse,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function firecrawlTbs(freshness) {
  if (freshness === "day") return "qdr:d";
  if (freshness === "week") return "qdr:w";
  if (freshness === "month") return "qdr:m";
  if (freshness === "year") return "qdr:y";
  return undefined;
}

export function createFirecrawlProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_FIRECRAWL_API_KEY", "FIRECRAWL_API_KEY"]);
  return {
    name: "firecrawl",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: true,
      rankedResults: true,
      extractedContent: true,
      dynamicPages: true,
    },
    requiredEnv: ["BEEP_FIRECRAWL_API_KEY", "FIRECRAWL_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson("https://api.firecrawl.dev/v2/search", {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          query: request.query,
          limit: request.maxResults,
          sources: request.topic === "news" ? ["news"] : ["web"],
          includeDomains: asStringArray(request.includeDomains),
          excludeDomains: asStringArray(request.excludeDomains),
          country: request.country || "US",
          tbs: firecrawlTbs(request.freshness),
          scrapeOptions: request.includeContent
            ? {
                formats: ["markdown"],
                onlyMainContent: true,
              }
            : undefined,
        },
      });

      const webResults = payload.data?.web || [];
      const newsResults = payload.data?.news || [];
      const results = [...webResults, ...newsResults].slice(0, request.maxResults);
      return normalizedSearchResponse({
        provider: "firecrawl",
        query: request.query,
        requestId: payload.id || null,
        usage: payload.creditsUsed != null ? { credits: payload.creditsUsed } : null,
        results: results.map((result) =>
          normalizedSearchResult({
            title: result.title || result.metadata?.title,
            url: result.url || result.metadata?.url || result.metadata?.sourceURL,
            snippet: result.description || result.snippet || result.metadata?.description || "",
            content: result.markdown || "",
            publishedAt: result.date || result.metadata?.publishedTime,
            sourceType: result.snippet ? "news" : "web",
            metadata: {
              statusCode: result.metadata?.statusCode || null,
            },
          }),
        ),
      });
    },

    async fetch(request, context) {
      const payload = await fetchJson("https://api.firecrawl.dev/v2/scrape", {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          url: request.url,
          formats: [request.contentFormat === "html" ? "html" : "markdown"],
          onlyMainContent: true,
          timeout: Math.min(context.timeoutMs, 60_000),
        },
      });
      const data = payload.data || {};
      return normalizedFetchResponse({
        provider: "firecrawl",
        url: request.url,
        title: data.metadata?.title || "",
        content: data.markdown || data.html || "",
        publishedAt: data.metadata?.publishedTime || null,
        requestId: payload.id || null,
        usage: payload.creditsUsed != null ? { credits: payload.creditsUsed } : null,
        metadata: {
          statusCode: data.metadata?.statusCode || null,
          warning: payload.warning || null,
        },
      });
    },
  };
}
