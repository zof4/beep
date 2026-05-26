function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function lcmLifecycleConfig() {
  const url = process.env.BEEP_LCM_LIFECYCLE_URL;
  const token = process.env.BEEP_LCM_CONTEXT_TOKEN;
  const runtimeSessionId = process.env.BEEP_LCM_RUNTIME_SESSION_ID;
  if (!url || !token || !runtimeSessionId) return null;
  return {
    url,
    token,
    runtimeSessionId,
    timeoutMs: positiveIntegerEnv("BEEP_LCM_CONTEXT_TIMEOUT_MS", 15_000),
  };
}

async function postLifecycle(action, body = {}) {
  if (!boolEnv("BEEP_LCM_CONTEXT_ENABLED", true)) return;
  const config = lcmLifecycleConfig();
  if (!config) return;
  await postJson(
    config.url,
    {
      runtimeSessionId: config.runtimeSessionId,
      action,
      ...body,
    },
    {
      token: config.token,
      timeoutMs: config.timeoutMs,
    },
  );
}

function sessionEndReasonForPiShutdown(reason) {
  if (reason === "quit") return "shutdown";
  if (reason === "reload") return "restart";
  return reason || "unknown";
}

export default function beepLcmContextExtension(pi) {
  pi.on("session_before_switch", async (event) => {
    if (event.reason === "new") {
      await postLifecycle("before_reset", { reason: "new" });
    }
  });

  pi.on("session_shutdown", async (event) => {
    await postLifecycle("session_end", {
      reason: sessionEndReasonForPiShutdown(event.reason),
    });
  });

  pi.on("context", async (event) => {
    if (!boolEnv("BEEP_LCM_CONTEXT_ENABLED", true)) return undefined;

    const url = process.env.BEEP_LCM_CONTEXT_URL;
    const token = process.env.BEEP_LCM_CONTEXT_TOKEN;
    const runtimeSessionId = process.env.BEEP_LCM_RUNTIME_SESSION_ID;
    if (!url || !token || !runtimeSessionId) return undefined;

    const messages = Array.isArray(event.messages) ? event.messages : [];
    const { response, payload } = await postJson(
      url,
      {
        runtimeSessionId,
        messages,
        prompt: latestUserPrompt(messages),
        tokenBudget: positiveIntegerEnv("BEEP_LCM_CONTEXT_TOKEN_BUDGET", 128_000),
      },
      {
        token,
        timeoutMs: positiveIntegerEnv("BEEP_LCM_CONTEXT_TIMEOUT_MS", 15_000),
      },
    );

    if (!response.ok || !payload?.ok || !Array.isArray(payload.messages)) {
      return undefined;
    }

    return { messages: payload.messages };
  });
}
