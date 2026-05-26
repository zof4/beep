import {
  buildUrl,
  fetchJson,
  firstEnv,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function timePeriod(freshness) {
  if (freshness === "day") return "d";
  if (freshness === "week") return "w";
  if (freshness === "month") return "m";
  if (freshness === "year") return "y";
  return undefined;
}

export function createSerpApiProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_SERPAPI_API_KEY", "SERPAPI_API_KEY"]);
  return {
    name: "serpapi",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: false,
      rankedResults: true,
      googleSerp: true,
    },
    requiredEnv: ["BEEP_SERPAPI_API_KEY", "SERPAPI_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson(
        buildUrl("https://serpapi.com/search.json", {
          engine: "google",
          q: request.query,
          api_key: apiKey,
          num: request.maxResults,
          gl: request.country ? request.country.toLowerCase() : "us",
          hl: request.language || "en",
          tbs: timePeriod(request.freshness) ? `qdr:${timePeriod(request.freshness)}` : undefined,
        }),
        {
          method: "GET",
          timeoutMs: context.timeoutMs,
          headers: {
            accept: "application/json",
          },
        },
      );

      return normalizedSearchResponse({
        provider: "serpapi",
        query: request.query,
        requestId: payload.search_metadata?.id || null,
        usage: null,
        results: (payload.organic_results || []).slice(0, request.maxResults).map((result) =>
          normalizedSearchResult({
            title: result.title,
            url: result.link,
            snippet: result.snippet || result.snippet_highlighted_words?.join(" ") || "",
            publishedAt: result.date,
            providerResultId: result.position != null ? String(result.position) : null,
            metadata: {
              displayedLink: result.displayed_link || null,
              source: result.source || null,
            },
          }),
        ),
      });
    },
  };
}
