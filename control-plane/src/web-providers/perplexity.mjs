import {
  asStringArray,
  fetchJson,
  firstEnv,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function domainFilter(includeDomains, excludeDomains) {
  const includes = asStringArray(includeDomains, 20);
  const excludes = asStringArray(excludeDomains, 20);
  if (includes.length > 0) return includes;
  if (excludes.length > 0) return excludes.map((domain) => `-${domain}`);
  return undefined;
}

export function createPerplexityProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_PERPLEXITY_API_KEY", "PERPLEXITY_API_KEY"]);
  const baseUrl = firstEnv(env, ["BEEP_PERPLEXITY_SEARCH_API_URL"]) || "https://api.perplexity.ai/search";
  return {
    name: "perplexity",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: false,
      rankedResults: true,
      extractedContent: true,
      sourcedAnswer: false,
    },
    requiredEnv: ["BEEP_PERPLEXITY_API_KEY", "PERPLEXITY_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson(baseUrl, {
        timeoutMs: context.timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: {
          query: request.query,
          max_results: request.maxResults,
          max_tokens_per_page: request.includeContent ? request.contentTokensPerPage || 4096 : 512,
          max_tokens: request.includeContent ? request.maxTokens || 20_000 : 5_000,
          country: request.country || undefined,
          search_language_filter: request.language ? [request.language] : undefined,
          search_domain_filter: domainFilter(request.includeDomains, request.excludeDomains),
        },
      });

      return normalizedSearchResponse({
        provider: "perplexity",
        query: request.query,
        requestId: payload.id || null,
        usage: payload.usage || null,
        results: (payload.results || []).map((result) =>
          normalizedSearchResult({
            title: result.title,
            url: result.url,
            snippet: result.snippet,
            content: request.includeContent ? result.snippet || "" : "",
            publishedAt: result.date || result.last_updated,
            metadata: {
              lastUpdated: result.last_updated || null,
            },
          }),
        ),
      });
    },
  };
}
