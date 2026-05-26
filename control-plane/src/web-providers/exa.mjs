import {
  asStringArray,
  fetchJson,
  firstEnv,
  normalizedFetchResponse,
  normalizedSearchResponse,
  normalizedSearchResult,
} from "./common.mjs";

function exaSearchType(depth) {
  if (["auto", "neural", "keyword", "fast", "deep"].includes(depth)) return depth;
  if (depth === "advanced" || depth === "standard") return "auto";
  return "auto";
}

function contentOptions(request) {
  if (!request.includeContent) return undefined;
  return {
    text: {
      maxCharacters: Number.isInteger(request.contentMaxCharacters)
        ? request.contentMaxCharacters
        : 12_000,
    },
    highlights: true,
  };
}

export function createExaProvider({ env = process.env } = {}) {
  const apiKey = firstEnv(env, ["BEEP_EXA_API_KEY", "EXA_API_KEY"]);
  return {
    name: "exa",
    configured: Boolean(apiKey),
    capabilities: {
      search: true,
      fetch: true,
      rankedResults: true,
      extractedContent: true,
      neuralSearch: true,
    },
    requiredEnv: ["BEEP_EXA_API_KEY", "EXA_API_KEY"],

    async search(request, context) {
      const payload = await fetchJson("https://api.exa.ai/search", {
        timeoutMs: context.timeoutMs,
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: {
          query: request.query,
          type: exaSearchType(request.depth),
          numResults: request.maxResults,
          includeDomains: asStringArray(request.includeDomains),
          excludeDomains: asStringArray(request.excludeDomains),
          startPublishedDate: request.startDate || undefined,
          endPublishedDate: request.endDate || undefined,
          contents: contentOptions(request),
        },
      });

      return normalizedSearchResponse({
        provider: "exa",
        query: request.query,
        requestId: payload.requestId || null,
        usage: payload.costDollars || null,
        results: (payload.results || []).map((result) =>
          normalizedSearchResult({
            title: result.title,
            url: result.url,
            snippet: result.summary || (Array.isArray(result.highlights) ? result.highlights.join("\n") : ""),
            content: result.text || "",
            score: result.score,
            publishedAt: result.publishedDate,
            providerResultId: result.id,
            metadata: {
              author: result.author || null,
              image: result.image || null,
              favicon: result.favicon || null,
            },
          }),
        ),
      });
    },

    async fetch(request, context) {
      const payload = await fetchJson("https://api.exa.ai/contents", {
        timeoutMs: context.timeoutMs,
        headers: {
          "x-api-key": apiKey,
          "content-type": "application/json",
        },
        body: {
          urls: [request.url],
          text: {
            maxCharacters: Number.isInteger(request.contentMaxCharacters)
              ? request.contentMaxCharacters
              : 40_000,
          },
          summary: request.query ? { query: request.query } : undefined,
        },
      });
      const result = Array.isArray(payload.results) ? payload.results[0] : null;
      return normalizedFetchResponse({
        provider: "exa",
        url: request.url,
        title: result?.title || "",
        content: result?.text || result?.summary || "",
        publishedAt: result?.publishedDate || null,
        requestId: payload.requestId || null,
        usage: payload.costDollars || null,
        metadata: {
          providerResultId: result?.id || null,
          author: result?.author || null,
        },
      });
    },
  };
}
