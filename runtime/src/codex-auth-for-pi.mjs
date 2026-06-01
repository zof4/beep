import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_SKEW_SECONDS = 300;
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function readAuth(authPath) {
  if (!existsSync(authPath)) {
    throw new Error(`Codex auth.json not found at ${authPath}. Run beep-codex-login first.`);
  }
  return JSON.parse(readFileSync(authPath, "utf8"));
}

function writeAuth(authPath, auth) {
  const tmpPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, authPath);
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function tokenExpiresSoon(accessToken, skewSeconds = REFRESH_SKEW_SECONDS) {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(Date.now() / 1000) + skewSeconds;
}

async function refreshCodexAuth(authPath, auth) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error(`Codex auth.json at ${authPath} does not contain tokens.refresh_token.`);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${response.status}): ${text || response.statusText}`);
  }

  const json = await response.json();
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("Codex token refresh response did not include access_token.");
  }

  const nextAuth = {
    ...auth,
    auth_mode: auth.auth_mode || "chatgpt",
    last_refresh: new Date().toISOString(),
    tokens: {
      ...(auth.tokens || {}),
      access_token: json.access_token,
      refresh_token:
        typeof json.refresh_token === "string" && json.refresh_token.length > 0
          ? json.refresh_token
          : auth.tokens?.refresh_token,
      id_token:
        typeof json.id_token === "string" && json.id_token.length > 0 ? json.id_token : auth.tokens?.id_token,
    },
  };

  writeAuth(authPath, nextAuth);
  return nextAuth;
}

function runtimeCodexAuthAllowed(env = process.env) {
  return !FALSE_VALUES.has(String(env.BEEP_ALLOW_RUNTIME_CODEX_AUTH || "").toLowerCase());
}

async function resolveGatewayAccessToken({
  credentialUrl,
  capabilityToken,
  provider = "openai-codex",
  model = "gpt-5.5",
  runtimeSessionId = null,
  fetchImpl = fetch,
}) {
  if (typeof capabilityToken !== "string" || capabilityToken.length === 0) {
    throw new Error("Model credential gateway is configured but BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN is missing.");
  }

  const response = await fetchImpl(credentialUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${capabilityToken}`,
    },
    body: JSON.stringify({
      provider,
      model,
      runtimeSessionId,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Model credential gateway request failed (${response.status}): ${text || response.statusText}`);
  }

  const json = await response.json();
  if (json?.ok === false) {
    throw new Error(`Model credential gateway denied credential request: ${json.error || "unknown error"}`);
  }

  const accessToken =
    typeof json?.apiKey === "string" && json.apiKey.length > 0
      ? json.apiKey
      : typeof json?.accessToken === "string" && json.accessToken.length > 0
        ? json.accessToken
        : typeof json?.access_token === "string" && json.access_token.length > 0
          ? json.access_token
          : "";
  if (!accessToken) {
    throw new Error("Model credential gateway response did not include apiKey.");
  }
  return accessToken;
}

export async function resolveCodexAccessToken(codexHome = process.env.CODEX_HOME || "/state/codex", options = {}) {
  const env = options.env || process.env;
  const credentialUrl = env.BEEP_MODEL_GATEWAY_CREDENTIAL_URL || "";
  if (credentialUrl) {
    return resolveGatewayAccessToken({
      credentialUrl,
      capabilityToken: env.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN || "",
      provider: options.provider || "openai-codex",
      model: options.model || env.BEEP_PI_CODEX_MODEL || "gpt-5.5",
      runtimeSessionId: options.runtimeSessionId || null,
      fetchImpl: options.fetchImpl || fetch,
    });
  }

  if (!runtimeCodexAuthAllowed(env)) {
    throw new Error(
      "Runtime Codex auth is disabled and no model credential gateway is configured; refusing to read CODEX_HOME auth.",
    );
  }

  const authPath = join(codexHome, "auth.json");
  let auth = readAuth(authPath);
  let accessToken = auth?.tokens?.access_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(`Codex auth.json at ${authPath} does not contain tokens.access_token.`);
  }

  if (tokenExpiresSoon(accessToken)) {
    auth = await refreshCodexAuth(authPath, auth);
    accessToken = auth?.tokens?.access_token;
  }

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(`Codex auth.json at ${authPath} does not contain a usable access token after refresh.`);
  }

  return accessToken;
}

async function main() {
  try {
    const codexHome = process.argv[2] || process.env.CODEX_HOME || "/state/codex";
    process.stdout.write(await resolveCodexAccessToken(codexHome));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
