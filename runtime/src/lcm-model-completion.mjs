import { randomUUID } from "node:crypto";
import { resolveModelCredential } from "./model-credential.mjs";
import { DEFAULT_MODEL, DEFAULT_THINKING } from "./runtime-common.mjs";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_COMPLETION_TIMEOUT_MS = 120_000;

function extractAccountId(token) {
  try {
    const [, payload] = String(token).split(".");
    if (!payload) throw new Error("missing JWT payload");
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new Error("missing account id");
    }
    return accountId;
  } catch (error) {
    throw new Error(`Failed to resolve Codex account id from model credential: ${error.message}`);
  }
}

function resolveCodexUrl(baseUrl = DEFAULT_CODEX_BASE_URL) {
  const normalized = String(baseUrl || DEFAULT_CODEX_BASE_URL).replace(/\/+$/u, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function createHeaders({ apiKey, accountId, requestId }) {
  return {
    accept: "text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "chatgpt-account-id": accountId,
    "content-type": "application/json",
    "openai-beta": "responses=experimental",
    originator: "beep-runtime",
    session_id: requestId,
    "user-agent": `beep-runtime-lcm (${process.platform} ${process.arch})`,
    "x-client-request-id": requestId,
  };
}

function normalizeMessage(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const text =
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((part) => {
              if (typeof part === "string") return part;
              if (part && typeof part === "object" && typeof part.text === "string") return part.text;
              return "";
            })
            .filter(Boolean)
            .join("\n")
        : "";
  if (role === "assistant") {
    return {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
      status: "completed",
      id: `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    };
  }
  return {
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function parseSseChunk(chunk) {
  return chunk
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function extractTextFromResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("");
}

function extractUsage(response) {
  const usage = response?.usage && typeof response.usage === "object" ? response.usage : {};
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? null,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
    totalTokens: usage.total_tokens ?? usage.totalTokens ?? null,
  };
}

async function readCodexSse(response) {
  if (!response.body) throw new Error("Codex response did not include a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let completedResponse = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const data of parseSseChunk(chunk)) {
          if (data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (event.type === "error") {
            throw new Error(event.message || event.code || "Codex response stream returned an error.");
          }
          if (event.type === "response.failed") {
            const error = event.response?.error;
            throw new Error(error?.message || error?.code || "Codex response failed.");
          }
          if (
            event.type === "response.output_text.delta" ||
            event.type === "response.refusal.delta" ||
            event.type === "response.reasoning_summary_text.delta"
          ) {
            if (typeof event.delta === "string") text += event.delta;
          }
          if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
            completedResponse = event.response || null;
            const responseText = extractTextFromResponse(completedResponse);
            if (responseText) text = responseText;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: text.trim(),
    response: completedResponse,
  };
}

export function resolveLcmModel(modelRef = "", providerHint = "") {
  const rawRef = String(modelRef || "").trim();
  const rawProviderHint = String(providerHint || "").trim();
  if (rawRef.includes("/")) {
    const [provider, ...rest] = rawRef.split("/");
    const model = rest.join("/").trim();
    if (provider.trim() && model) return { provider: provider.trim(), model };
  }
  return {
    provider: rawProviderHint || "openai-codex",
    model: rawRef || process.env.BEEP_PI_CODEX_MODEL || DEFAULT_MODEL,
  };
}

export async function completeLcmModelRequest(params = {}) {
  const resolved = resolveLcmModel(params.model, params.provider);
  if (resolved.provider !== "openai-codex") {
    throw new Error(`Unsupported LCM summary provider for Beep runtime: ${resolved.provider}`);
  }

  const credential = await resolveModelCredential({
    provider: resolved.provider,
    model: resolved.model,
    thinking: process.env.BEEP_PI_THINKING || DEFAULT_THINKING,
    runtimeSessionId: `lcm-summary-${randomUUID().slice(0, 8)}`,
  });
  const accountId = extractAccountId(credential.apiKey);
  const requestId = `lcm_summary_${randomUUID()}`;
  const controller = new AbortController();
  const timeoutMs = Number.parseInt(String(process.env.BEEP_LCM_MODEL_TIMEOUT_MS || DEFAULT_COMPLETION_TIMEOUT_MS), 10);
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_COMPLETION_TIMEOUT_MS);

  const body = {
    model: resolved.model,
    store: false,
    stream: true,
    instructions: params.system || "You are a concise summarizer.",
    input: Array.isArray(params.messages) ? params.messages.map(normalizeMessage) : [],
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    reasoning: params.reasoning || params.reasoningIfSupported ? { effort: params.reasoning || params.reasoningIfSupported } : undefined,
  };

  try {
    const response = await fetch(resolveCodexUrl(process.env.BEEP_CODEX_BASE_URL), {
      method: "POST",
      headers: createHeaders({ apiKey: credential.apiKey, accountId, requestId }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Codex summary request failed (${response.status}): ${errorText || response.statusText}`);
    }
    const result = await readCodexSse(response);
    if (!result.text) {
      throw new Error("Codex summary request returned no text.");
    }
    return {
      content: [{ type: "text", text: result.text }],
      usage: extractUsage(result.response),
      provider: resolved.provider,
      model: resolved.model,
    };
  } finally {
    clearTimeout(timeout);
  }
}

