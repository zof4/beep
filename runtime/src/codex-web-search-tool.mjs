import { isDeepStrictEqual } from "node:util";

export const CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS = [
  "type",
  "external_web_access",
  "filters",
  "user_location",
  "search_context_size",
  "search_content_types",
];

export const CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS = ["allowed_domains"];

export const CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS = [
  "type",
  "country",
  "region",
  "city",
  "timezone",
];

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const MODES = new Set(["live", "cached", "disabled"]);
const CONTEXT_SIZES = new Set(["low", "medium", "high"]);
const CONTENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]*$/u;

function normalizeToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function dedupe(values) {
  return [...new Set(values)];
}

function parseEnabled(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return true;
  }

  return !FALSE_VALUES.has(normalizeToken(value));
}

function parseMode(value) {
  const mode = normalizeToken(value || "live");
  if (!MODES.has(mode)) {
    throw new Error("BEEP_CODEX_WEB_SEARCH_MODE must be one of live, cached, disabled");
  }

  return mode;
}

function parseAllowedDomain(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return trimmed
      .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "")
      .split("/")[0]
      .replace(/\/+$/u, "")
      .toLowerCase();
  }
}

function parseAllowedDomains(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return [];
  }

  return dedupe(
    String(value)
      .split(",")
      .map(parseAllowedDomain)
      .filter(Boolean),
  );
}

function parseContextSize(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }

  const contextSize = normalizeToken(value);
  if (!CONTEXT_SIZES.has(contextSize)) {
    throw new Error("BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE must be one of low, medium, high");
  }

  return contextSize;
}

function parseContentTypes(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return [];
  }

  const contentTypes = String(value)
    .split(",")
    .map(normalizeToken)
    .filter(Boolean);

  const invalid = contentTypes.find((contentType) => !CONTENT_TYPE_PATTERN.test(contentType));
  if (invalid) {
    throw new Error(`BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES contains invalid value: ${invalid}`);
  }

  return dedupe(contentTypes);
}

function parseUserLocation(env) {
  const location = {
    country: env.BEEP_CODEX_WEB_SEARCH_LOCATION_COUNTRY,
    region: env.BEEP_CODEX_WEB_SEARCH_LOCATION_REGION,
    city: env.BEEP_CODEX_WEB_SEARCH_LOCATION_CITY,
    timezone: env.BEEP_CODEX_WEB_SEARCH_LOCATION_TIMEZONE,
  };

  const entries = Object.entries(location)
    .map(([key, value]) => [key, String(value ?? "").trim()])
    .filter(([, value]) => value !== "");

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries([["type", "approximate"], ...entries]);
}

export function readCodexWebSearchConfig(env = process.env) {
  return {
    enabled: parseEnabled(env.BEEP_CODEX_WEB_SEARCH_ENABLED),
    mode: parseMode(env.BEEP_CODEX_WEB_SEARCH_MODE),
    allowedDomains: parseAllowedDomains(env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
    contextSize: parseContextSize(env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
    contentTypes: parseContentTypes(env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
    userLocation: parseUserLocation(env),
  };
}

export function buildCodexWebSearchTool(config) {
  if (!config?.enabled || config.mode === "disabled") {
    return null;
  }

  const tool = {
    type: "web_search",
    external_web_access: config.mode === "live",
  };

  if (config.allowedDomains?.length > 0) {
    tool.filters = { allowed_domains: [...config.allowedDomains] };
  }

  if (config.userLocation) {
    tool.user_location = { ...config.userLocation };
  }

  if (config.contextSize) {
    tool.search_context_size = config.contextSize;
  }

  if (config.contentTypes?.length > 0) {
    tool.search_content_types = [...config.contentTypes];
  }

  return tool;
}

export function isOpenAICodexResponsesPayload(payload) {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload.model === "string" &&
    payload.stream === true &&
    Array.isArray(payload.input) &&
    (payload.tool_choice === "auto" || payload.parallel_tool_calls === true || Array.isArray(payload.include))
  );
}

function normalizeWebSearchTool(tool) {
  if (!tool) {
    return null;
  }

  const normalized = {
    type: "web_search",
    external_web_access: tool.external_web_access === true,
  };

  if (tool.filters) {
    normalized.filters = {};
    for (const field of CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS) {
      if (field in tool.filters) {
        normalized.filters[field] = Array.isArray(tool.filters[field]) ? [...tool.filters[field]] : tool.filters[field];
      }
    }
    if (Object.keys(normalized.filters).length === 0) {
      delete normalized.filters;
    }
  }

  if (tool.user_location) {
    normalized.user_location = {};
    for (const field of CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS) {
      if (field in tool.user_location) {
        normalized.user_location[field] = tool.user_location[field];
      }
    }
    if (Object.keys(normalized.user_location).length === 0) {
      delete normalized.user_location;
    }
  }

  if ("search_context_size" in tool) {
    normalized.search_context_size = tool.search_context_size;
  }

  if ("search_content_types" in tool) {
    normalized.search_content_types = Array.isArray(tool.search_content_types)
      ? [...tool.search_content_types]
      : tool.search_content_types;
  }

  return normalized;
}

export function injectCodexWebSearchTool(payload, webSearchTool) {
  if (!isOpenAICodexResponsesPayload(payload)) {
    return {
      changed: false,
      injected: false,
      removed: 0,
      payload,
    };
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const existingWebSearchTools = existingTools.filter((tool) => tool?.type === "web_search");
  const retainedTools = existingTools.filter((tool) => tool?.type !== "web_search");
  const removed = existingWebSearchTools.length;
  const normalizedTool = normalizeWebSearchTool(webSearchTool);
  const nextTools = normalizedTool ? [...retainedTools, normalizedTool] : retainedTools;
  const unchanged =
    Array.isArray(payload.tools) &&
    (isDeepStrictEqual(existingTools, nextTools) ||
      (normalizedTool !== null &&
        existingWebSearchTools.length === 1 &&
        isDeepStrictEqual(existingWebSearchTools[0], normalizedTool)));

  if (unchanged) {
    return {
      changed: false,
      injected: normalizedTool !== null,
      removed: 0,
      payload,
    };
  }

  const changed = removed > 0 || normalizedTool !== null;

  if (!changed) {
    return {
      changed: false,
      injected: false,
      removed,
      payload,
    };
  }

  return {
    changed: true,
    injected: normalizedTool !== null,
    removed,
    payload: {
      ...payload,
      tools: nextTools,
    },
  };
}
