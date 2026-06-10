import { readFileSync } from "node:fs";

export const CODEX_AUTH_LOGIN_HINT = "Run ./scripts/codex-runtime-login.sh, then rerun this command.";

export class CodexAuthFileError extends Error {
  constructor(code, detail, { cause } = {}) {
    super(`Codex auth preflight failed: ${detail}. ${CODEX_AUTH_LOGIN_HINT}`, { cause });
    this.name = "CodexAuthFileError";
    this.code = code;
    this.status = 503;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function preflightError(code, detail, options) {
  return new CodexAuthFileError(code, detail, options);
}

export function codexAuthCredentialPresence(auth) {
  return {
    tokensAccessToken: nonEmptyString(auth?.tokens?.access_token),
    tokensRefreshToken: nonEmptyString(auth?.tokens?.refresh_token),
    openaiApiKey: nonEmptyString(auth?.OPENAI_API_KEY),
    apiKey: nonEmptyString(auth?.apiKey),
  };
}

export function codexAuthHasCredential(presence) {
  return Boolean(
    presence?.tokensAccessToken || presence?.tokensRefreshToken || presence?.openaiApiKey || presence?.apiKey,
  );
}

export function readCodexAuthJsonFile(authPath) {
  let source;
  try {
    source = readFileSync(authPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw preflightError("CODEX_AUTH_MISSING", `auth file not found at ${authPath}`, { cause: error });
    }
    throw preflightError("CODEX_AUTH_READ_FAILED", `could not read auth file at ${authPath}`, { cause: error });
  }

  if (source.trim().length === 0) {
    throw preflightError("CODEX_AUTH_EMPTY", `auth file is empty at ${authPath}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw preflightError("CODEX_AUTH_INVALID_JSON", `auth file is not valid JSON at ${authPath}`, { cause: error });
  }
}

export function validateCodexAuth(
  auth,
  { authPath = "auth.json", requireTokensAccessToken = false, usage = "Codex auth" } = {},
) {
  const presence = codexAuthCredentialPresence(auth);
  if (!codexAuthHasCredential(presence)) {
    throw preflightError(
      "CODEX_AUTH_MISSING_CREDENTIAL",
      `${authPath} does not contain tokens.refresh_token, tokens.access_token, OPENAI_API_KEY, or apiKey`,
    );
  }
  if (requireTokensAccessToken && !presence.tokensAccessToken) {
    throw preflightError(
      "CODEX_AUTH_MISSING_ACCESS_TOKEN",
      `${usage} requires tokens.access_token in ${authPath}`,
    );
  }
  return { auth, authPath, presence };
}

export function validateCodexAuthFile(authPath, options = {}) {
  return validateCodexAuth(readCodexAuthJsonFile(authPath), { ...options, authPath });
}

export function formatCodexAuthValidationSuccess(result) {
  const presence = result?.presence || {};
  const state = (value) => (value ? "present" : "absent");
  return [
    "Codex auth preflight ok:",
    `tokens.access_token=${state(presence.tokensAccessToken)}`,
    `tokens.refresh_token=${state(presence.tokensRefreshToken)}`,
    `OPENAI_API_KEY=${state(presence.openaiApiKey)}`,
    `apiKey=${state(presence.apiKey)}`,
  ].join(" ");
}
