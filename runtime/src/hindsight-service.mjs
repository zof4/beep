function boolEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function positiveIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(String(value === undefined || value === null ? "" : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanSegment(value, fallback) {
  const raw = String(value || fallback || "default").trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || String(fallback || "default");
}

export function loadHindsightConfig(env = process.env) {
  return {
    enabled: boolEnv(env.BEEP_HINDSIGHT_ENABLED, false),
    apiUrl: String(env.BEEP_HINDSIGHT_API_URL || "http://127.0.0.1:8888").replace(/\/+$/u, ""),
    apiToken: env.BEEP_HINDSIGHT_API_TOKEN || "",
    bankIdPrefix: cleanSegment(env.BEEP_HINDSIGHT_BANK_ID_PREFIX, "beep"),
    deploymentId: cleanSegment(env.BEEP_HINDSIGHT_DEPLOYMENT_ID, "local"),
    userId: cleanSegment(env.BEEP_HINDSIGHT_USER_ID, "default-user"),
    projectId: cleanSegment(env.BEEP_HINDSIGHT_PROJECT_ID, "beep2"),
    recallBudget: String(env.BEEP_HINDSIGHT_RECALL_BUDGET || "high"),
    recallMaxTokens: positiveIntegerEnv(env.BEEP_HINDSIGHT_RECALL_MAX_TOKENS, 4096),
    timeoutMs: positiveIntegerEnv(env.BEEP_HINDSIGHT_TIMEOUT_MS, 5000),
    retainAsync: boolEnv(env.BEEP_HINDSIGHT_RETAIN_ASYNC, true),
  };
}

export function deriveHindsightBankId(config, _scope = {}) {
  return [
    cleanSegment(config.bankIdPrefix, "beep"),
    cleanSegment(config.deploymentId, "local"),
    cleanSegment(config.userId, "default-user"),
    cleanSegment(config.projectId, "beep2"),
  ].join(":");
}

function encodePath(value) {
  return encodeURIComponent(String(value));
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function formatErrorDetail(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((entry) => {
        if (!entry || typeof entry !== "object") return String(entry);
        const loc = Array.isArray(entry.loc) ? entry.loc.join(".") : "";
        const msg = typeof entry.msg === "string" ? entry.msg : JSON.stringify(entry);
        return loc ? `${loc}: ${msg}` : msg;
      })
      .join("; ");
  }
  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }
  return "";
}

function errorMessageFromPayload(payload, fallback) {
  if (payload?.detail !== undefined) {
    const message = formatErrorDetail(payload.detail);
    if (message) return message;
  }
  if (payload?.error !== undefined) {
    const message = formatErrorDetail(payload.error);
    if (message) return message;
  }
  return fallback;
}

export class HindsightService {
  constructor(config = loadHindsightConfig(), { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get enabled() {
    return Boolean(this.config.enabled);
  }

  headers() {
    return {
      accept: "application/json",
      "content-type": "application/json",
      ...(this.config.apiToken ? { authorization: `Bearer ${this.config.apiToken}` } : {}),
    };
  }

  async request(path, { method = "GET", body = undefined, timeoutMs = this.config.timeoutMs } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const payload = await responseJson(response);
      if (!response.ok) {
        const message = errorMessageFromPayload(payload, `Hindsight ${method} ${path} failed with ${response.status}`);
        throw Object.assign(new Error(String(message)), { status: response.status, payload });
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health() {
    try {
      return { ok: true, endpoint: "/health", payload: await this.request("/health") };
    } catch (firstError) {
      try {
        return { ok: true, endpoint: "/v1/default/banks", payload: await this.request("/v1/default/banks") };
      } catch (secondError) {
        return {
          ok: false,
          error: secondError instanceof Error ? secondError.message : String(secondError),
          firstError: firstError instanceof Error ? firstError.message : String(firstError),
        };
      }
    }
  }

  async recall({ bankId, query, tags = [], budget = this.config.recallBudget, maxTokens = this.config.recallMaxTokens }) {
    return this.request(`/v1/default/banks/${encodePath(bankId)}/memories/recall`, {
      method: "POST",
      body: {
        query,
        budget,
        max_tokens: maxTokens,
        trace: false,
        types: ["world", "experience", "observation"],
        ...(tags.length ? { tags, tags_match: "all_strict" } : {}),
      },
    });
  }

  async retain({ bankId, items, async = this.config.retainAsync }) {
    return this.request(`/v1/default/banks/${encodePath(bankId)}/memories`, {
      method: "POST",
      body: { items, async },
      timeoutMs: Math.max(this.config.timeoutMs, 15_000),
    });
  }

  async getDocument({ bankId, documentId }) {
    return this.request(`/v1/default/banks/${encodePath(bankId)}/documents/${encodePath(documentId)}`);
  }
}

export const defaultHindsightService = new HindsightService();
