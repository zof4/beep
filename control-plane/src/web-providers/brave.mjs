import {
  buildUrl,
  fetchJson,
  firstEnv,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function braveFreshness(freshness) {
  if (freshness === "day") return "pd";
  if (freshness === "week") return "pw";
  if (freshness === "month") return "pm";
  if (freshness === "year") return "py";
  return undefined;
}

export function createBraveProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"]);
  return {
    name: "brave",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: false,
      rankedResults: true,
      independentIndex: true,
    },
    requiredEnv: ["BEEP_BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson(
        buildUrl("https://api.search.brave.com/res/v1/web/search", {
          q: request.query,
          count: request.maxResults,
          country: request.country || "US",
          search_lang: request.language || "en",
          freshness: braveFreshness(request.freshness),
          extra_snippets: request.includeContent ? "true" : undefined,
        }),
        {
          method: "GET",
          timeoutMs: context.timeoutMs,
          headers: {
            accept: "application/json",
            "accept-encoding": "gzip",
            "x-subscription-token": apiKey,
          },
        },
      );

      return normalizedSearchResponse({
        provider: "brave",
        query: request.query,
        requestId: payload.query?.original || null,
        usage: null,
        results: (payload.web?.results || []).map((result) =>
          normalizedSearchResult({
            title: result.title,
            url: result.url,
            snippet: result.description || result.extra_snippets?.join("\n") || "",
            content: Array.isArray(result.extra_snippets) ? result.extra_snippets.join("\n\n") : "",
            publishedAt: result.page_age || result.age,
            providerResultId: result.profile?.long_name || null,
            metadata: {
              familyFriendly: payload.query?.is_navigational ?? null,
              language: result.language || null,
              subtype: result.subtype || null,
            },
          }),
        ),
      });
    },
  };
}
