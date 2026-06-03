import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_SKEW_SECONDS = 300;

function readAuth(authPath) {
  if (!existsSync(authPath)) {
    const error = new Error(`Codex auth.json not found at ${authPath}.`);
    error.status = 503;
    throw error;
  }
  return JSON.parse(readFileSync(authPath, "utf8"));
}

function writeAuth(authPath, auth) {
  const tmpPath = `${authPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, authPath);
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function expiresAtIso(accessToken) {
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp !== "number") return null;
  return new Date(exp * 1000).toISOString();
}

function tokenExpiresSoon(accessToken, { nowMs = Date.now(), skewSeconds = REFRESH_SKEW_SECONDS } = {}) {
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (typeof exp !== "number") return false;
  return exp <= Math.floor(nowMs / 1000) + skewSeconds;
}

async function refreshCodexAuth(authPath, auth, { fetchImpl = fetch } = {}) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    const error = new Error(`Codex auth.json at ${authPath} does not contain tokens.refresh_token.`);
    error.status = 503;
    throw error;
  }

  const response = await fetchImpl(TOKEN_URL, {
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
    const error = new Error(`Codex token refresh failed (${response.status}): ${text || response.statusText}`);
    error.status = 503;
    throw error;
  }

  const json = await response.json();
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    const error = new Error("Codex token refresh response did not include access_token.");
    error.status = 503;
    throw error;
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

export async function resolveCodexCredentialFromAuthPath(
  authPath,
  { fetchImpl = fetch, nowMs = Date.now(), skewSeconds = REFRESH_SKEW_SECONDS } = {},
) {
  let auth = readAuth(authPath);
  let accessToken = auth?.tokens?.access_token;

  if (typeof accessToken === "string" && accessToken.length > 0) {
    if (tokenExpiresSoon(accessToken, { nowMs, skewSeconds })) {
      auth = await refreshCodexAuth(authPath, auth, { fetchImpl });
      accessToken = auth?.tokens?.access_token;
    }

    if (typeof accessToken !== "string" || accessToken.length === 0) {
      const error = new Error(`Codex auth.json at ${authPath} does not contain a usable access token after refresh.`);
      error.status = 503;
      throw error;
    }

    return {
      apiKey: accessToken,
      source: "control-plane-codex-auth",
      expiresAt: expiresAtIso(accessToken),
    };
  }

  const apiKey = auth?.OPENAI_API_KEY || auth?.apiKey;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return {
      apiKey,
      source: "control-plane-api-key",
      expiresAt: null,
    };
  }

  const error = new Error(`${authPath} does not contain tokens.access_token or OPENAI_API_KEY.`);
  error.status = 503;
  throw error;
}
