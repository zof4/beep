import {
  DEFAULT_WEB_TIMEOUT_MS,
  asStringArray,
  ensureHttpUrl,
} from "./web-providers/common.mjs";
import { createBraveProvider } from "./web-providers/brave.mjs";
import { createExaProvider } from "./web-providers/exa.mjs";
import { createFirecrawlProvider } from "./web-providers/firecrawl.mjs";
import { createLinkupProvider } from "./web-providers/linkup.mjs";
import { createPerplexityProvider } from "./web-providers/perplexity.mjs";
import { createSerpApiProvider } from "./web-providers/serpapi.mjs";
import { createTavilyProvider } from "./web-providers/tavily.mjs";
import { ToolBrokerError } from "./tool-broker-error.mjs";

const PROVIDER_FACTORIES = {
  brave: createBraveProvider,
  exa: createExaProvider,
  firecrawl: createFirecrawlProvider,
  linkup: createLinkupProvider,
  perplexity: createPerplexityProvider,
  serpapi: createSerpApiProvider,
  tavily: createTavilyProvider,
};

const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDER_FACTORIES).sort());

function intEnv(env, name, fallback) {
  const parsed = Number.parseInt(env[name] || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProviderName(provider, fallback) {
  const value = String(provider || fallback || "").trim().toLowerCase();
  return value || "";
}

function normalizePositiveInteger(value, fallback, { min = 1, max = 20 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const candidate = Number.isInteger(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, candidate));
}

function normalizeDepth(value) {
  const depth = String(value || "").trim();
  if (["ultra-fast", "fast", "basic", "standard", "advanced", "deep", "auto", "neural", "keyword"].includes(depth)) {
    return depth;
  }
  return "standard";
}

function normalizeFreshness(value) {
  const freshness = String(value || "").trim();
  if (["day", "week", "month", "year"].includes(freshness)) return freshness;
  return "";
}

function normalizeDateString(value, key) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") {
    throw new ToolBrokerError(`${key} must be an ISO date string.`, 400);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ToolBrokerError(`${key} must be a valid ISO date string.`, 400);
  }
  return value;
}

function normalizeSearchRequest(args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new ToolBrokerError("web_search requires a non-empty query.", 400);
  }
  return {
    query,
    provider: normalizeProviderName(args.provider),
    maxResults: normalizePositiveInteger(args.maxResults ?? args.limit, 5, { min: 1, max: 20 }),
    includeContent: args.includeContent === true,
    includeAnswer: args.includeAnswer === true,
    includeDomains: asStringArray(args.includeDomains, 300),
    excludeDomains: asStringArray(args.excludeDomains, 300),
    country: typeof args.country === "string" ? args.country.trim() : "",
    language: typeof args.language === "string" ? args.language.trim() : "",
    freshness: normalizeFreshness(args.freshness),
    depth: normalizeDepth(args.depth),
    topic: typeof args.topic === "string" ? args.topic.trim() : "",
    startDate: normalizeDateString(args.startDate, "startDate"),
    endDate: normalizeDateString(args.endDate, "endDate"),
  };
}

function normalizeFetchRequest(args = {}) {
  const url = ensureHttpUrl(args.url);
  return {
    url,
    provider: normalizeProviderName(args.provider),
    query: typeof args.query === "string" ? args.query.trim() : "",
    depth: normalizeDepth(args.depth),
    contentFormat: ["markdown", "text", "html"].includes(args.contentFormat) ? args.contentFormat : "markdown",
  };
}

export class WebToolService {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.defaultSearchProvider = normalizeProviderName(env.BEEP_WEB_SEARCH_PROVIDER || env.BEEP_WEB_TOOL_PROVIDER);
    this.defaultFetchProvider = normalizeProviderName(env.BEEP_WEB_FETCH_PROVIDER || env.BEEP_WEB_TOOL_PROVIDER);
    this.defaultProvider = this.defaultSearchProvider || null;
    this.timeoutMs = intEnv(env, "BEEP_WEB_TOOL_TIMEOUT_MS", DEFAULT_WEB_TIMEOUT_MS);
    this.providers = new Map(
      PROVIDER_NAMES.map((name) => [name, PROVIDER_FACTORIES[name]({ env })]),
    );
  }

  manifest() {
    return {
      schemaVersion: 1,
      defaultProvider: this.defaultProvider,
      defaultSearchProvider: this.defaultSearchProvider || null,
      defaultFetchProvider: this.defaultFetchProvider || null,
      providers: Array.from(this.providers.values()).map((provider) => ({
        name: provider.name,
        configured: Boolean(provider.configured),
        capabilities: provider.capabilities,
        requiredEnv: provider.requiredEnv,
      })),
    };
  }

  providerFor(requestedProvider, capability) {
    const defaultProvider = capability === "fetch" ? this.defaultFetchProvider : this.defaultSearchProvider;
    const providerName = normalizeProviderName(requestedProvider, defaultProvider);
    if (!providerName) {
      const envName = capability === "fetch" ? "BEEP_WEB_FETCH_PROVIDER" : "BEEP_WEB_SEARCH_PROVIDER";
      throw new ToolBrokerError(
        `No web ${capability} provider configured. Set ${envName} or BEEP_WEB_TOOL_PROVIDER to one of: ${PROVIDER_NAMES.join(", ")}.`,
        424,
      );
    }
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new ToolBrokerError(
        `Unknown web provider: ${providerName}. Available providers: ${PROVIDER_NAMES.join(", ")}.`,
        400,
      );
    }
    if (!provider.configured) {
      throw new ToolBrokerError(
        `${providerName} web provider is not configured. Set one of: ${provider.requiredEnv.join(", ")}.`,
        424,
      );
    }
    if (!provider.capabilities?.[capability] || typeof provider[capability] !== "function") {
      throw new ToolBrokerError(`${providerName} does not support web_${capability}.`, 400);
    }
    return provider;
  }

  async search(args = {}) {
    const request = normalizeSearchRequest(args);
    const provider = this.providerFor(request.provider, "search");
    const response = await provider.search(request, { timeoutMs: this.timeoutMs });
    return {
      ok: true,
      kind: "web_search",
      selectedProvider: provider.name,
      ...response,
    };
  }

  async fetch(args = {}) {
    const request = normalizeFetchRequest(args);
    const provider = this.providerFor(request.provider, "fetch");
    const response = await provider.fetch(request, { timeoutMs: this.timeoutMs });
    return {
      ok: true,
      kind: "web_fetch",
      selectedProvider: provider.name,
      ...response,
    };
  }
}
