export const DEFAULT_WEB_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONTENT_CHARS = 12_000;

export function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function badUrlError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function asStringArray(value, max = 50) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

export function truncateText(value, maxChars = DEFAULT_MAX_CONTENT_CHARS) {
  if (value == null) return "";
  const text = String(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 18)).trimEnd()}\n\n[truncated]`;
}

export function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function normalizeScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export function ensureHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw badUrlError("URL must be a valid absolute http(s) URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw badUrlError("URL must use http or https.");
  }
  return parsed.toString();
}

export function buildUrl(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function fetchJson(url, { method = "POST", headers = {}, body = undefined, timeoutMs = DEFAULT_WEB_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { text };
      }
    }
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        response.statusText ||
        `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizedSearchResult({
  title,
  url,
  snippet,
  content,
  publishedAt = null,
  score = null,
  sourceType = "web",
  providerResultId = null,
  metadata = {},
}) {
  return {
    title: String(title || url || "").trim(),
    url: ensureHttpUrl(url),
    snippet: truncateText(snippet || content || "", 1_200),
    content: content ? truncateText(content) : "",
    publishedAt: normalizeDate(publishedAt),
    score: normalizeScore(score),
    sourceType,
    providerResultId,
    metadata,
  };
}

export function normalizedSearchResponse({
  provider,
  query,
  results,
  answer = null,
  usage = null,
  requestId = null,
  warnings = [],
}) {
  return {
    provider,
    query,
    answer,
    results,
    usage,
    requestId,
    warnings,
  };
}

export function normalizedFetchResponse({
  provider,
  url,
  title = "",
  content = "",
  publishedAt = null,
  usage = null,
  requestId = null,
  metadata = {},
}) {
  return {
    provider,
    url: ensureHttpUrl(url),
    title: String(title || "").trim(),
    content: truncateText(content, 40_000),
    publishedAt: normalizeDate(publishedAt),
    usage,
    requestId,
    metadata,
  };
}
