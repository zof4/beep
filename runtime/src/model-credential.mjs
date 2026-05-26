import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_HOME,
  MODEL_GATEWAY_CAPABILITY_TOKEN,
  MODEL_GATEWAY_CREDENTIAL_URL,
  RUNTIME_CODEX_AUTH_COMPAT_ENABLED,
} from "./runtime-common.mjs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function resolveFromModelGateway({ provider, model, thinking, runtimeSessionId }) {
  if (!MODEL_GATEWAY_CREDENTIAL_URL) return null;

  const headers = { "content-type": "application/json" };
  if (MODEL_GATEWAY_CAPABILITY_TOKEN) {
    headers.authorization = `Bearer ${MODEL_GATEWAY_CAPABILITY_TOKEN}`;
  }

  const response = await fetch(MODEL_GATEWAY_CREDENTIAL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      provider,
      model,
      thinking,
      runtimeSessionId,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Model gateway credential request failed (${response.status}): ${payload?.error || response.statusText}`,
    );
  }

  const apiKey = payload.apiKey || payload.accessToken || payload.token;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("Model gateway credential response did not include apiKey/accessToken/token.");
  }

  return {
    apiKey,
    source: "model-gateway",
    expiresAt: payload.expiresAt || null,
  };
}

function resolveFromDevCodexAuth(codexHome = CODEX_HOME) {
  if (!RUNTIME_CODEX_AUTH_COMPAT_ENABLED) return null;

  const authPath = join(codexHome, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(`Runtime Codex auth compatibility is enabled, but ${authPath} does not exist.`);
  }

  const auth = readJson(authPath);
  const apiKey = auth?.tokens?.access_token;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error(`Runtime Codex auth compatibility is enabled, but ${authPath} has no tokens.access_token.`);
  }

  return {
    apiKey,
    source: "runtime-codex-auth-compat",
    expiresAt: null,
  };
}

export async function resolveModelCredential({ provider = "openai-codex", model, thinking, runtimeSessionId } = {}) {
  const gatewayCredential = await resolveFromModelGateway({ provider, model, thinking, runtimeSessionId });
  if (gatewayCredential) return gatewayCredential;

  const devCredential = resolveFromDevCodexAuth();
  if (devCredential) return devCredential;

  throw new Error(
    [
      "No model credential source is configured.",
      "Set BEEP_MODEL_GATEWAY_CREDENTIAL_URL for the control-plane/model-gateway path.",
      "For local dev only, set BEEP_ALLOW_RUNTIME_CODEX_AUTH=1 to read an existing CODEX_HOME/auth.json access token without refreshing it.",
    ].join(" "),
  );
}

async function main() {
  try {
    const provider = process.argv[2] || "openai-codex";
    const model = process.argv[3] || process.env.BEEP_PI_CODEX_MODEL || "gpt-5.5";
    const thinking = process.argv[4] || process.env.BEEP_PI_THINKING || "low";
    const credential = await resolveModelCredential({ provider, model, thinking, runtimeSessionId: "cli" });
    process.stdout.write(credential.apiKey);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
