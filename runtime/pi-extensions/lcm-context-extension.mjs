function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBeepExtensionConfig() {
  const registry = globalThis.__BEEP_PI_EXTENSION_CONFIGS__;
  const configId = process.env.BEEP_PI_EXTENSION_CONFIG_ID;
  if (!(registry instanceof Map) || !configId) return {};
  return registry.get(configId) || {};
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "toolCall") return `[tool:${part.name || "unknown"}] ${JSON.stringify(part.arguments ?? {})}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function latestUserPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return textFromContent(message.content).slice(0, 4_000);
    }
  }
  return "Assemble Beep's next-turn LCM context projection.";
}

async function postJson(url, body, { token, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

export default function beepLcmContextExtension(pi) {
  const config = readBeepExtensionConfig().lcmContext || {};

  pi.on("context", async (event) => {
    if (!config.enabled) return undefined;

    const url = config.url;
    const token = config.token;
    const runtimeSessionId = config.runtimeSessionId;
    if (!url || !token || !runtimeSessionId) return undefined;

    const messages = Array.isArray(event.messages) ? event.messages : [];
    const { response, payload } = await postJson(
      url,
      {
        runtimeSessionId,
        messages,
        prompt: latestUserPrompt(messages),
        tokenBudget: positiveInteger(config.tokenBudget, 128_000),
      },
      {
        token,
        timeoutMs: positiveInteger(config.timeoutMs, 15_000),
      },
    );

    if (!response.ok || !payload?.ok || !Array.isArray(payload.messages)) {
      return undefined;
    }

    return { messages: payload.messages };
  });
}
