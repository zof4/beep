import { createHmac, timingSafeEqual } from "node:crypto";

const PROTECTED_RUNTIME_API_ROOTS = new Set(["agent", "sessions"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function runtimeApiAuthRequired(pathname) {
  const parts = String(pathname || "/")
    .split("/")
    .filter(Boolean);
  const root = parts[0] || "";
  if (root === "internal") {
    return parts.length === 4 && parts[1] === "sandbox" && parts[2] === "tools" && parts[3] === "call";
  }
  return PROTECTED_RUNTIME_API_ROOTS.has(root) || root === "runs";
}

export function authorizeRuntimeApiRequest({ pathname, authorization, runtimeApiToken }) {
  if (!runtimeApiAuthRequired(pathname)) {
    return { ok: true, required: false };
  }
  if (!nonEmptyString(runtimeApiToken)) {
    return {
      ok: false,
      required: true,
      status: 503,
      error: "Runtime API bearer token is not configured.",
    };
  }
  if (String(authorization || "") === `Bearer ${runtimeApiToken}`) {
    return { ok: true, required: true };
  }
  return {
    ok: false,
    required: true,
    status: 401,
    error: "Runtime API route requires bearer authorization.",
  };
}

export function createRuntimeHealthProof({ challenge, runtimeApiToken }) {
  if (!nonEmptyString(challenge)) {
    throw new Error("Runtime health proof requires a non-empty challenge.");
  }
  if (!nonEmptyString(runtimeApiToken)) {
    throw new Error("Runtime health proof requires a configured runtime API token.");
  }
  return createHmac("sha256", runtimeApiToken).update(challenge).digest("hex");
}

export function verifyRuntimeHealthProof({ challenge, runtimeApiToken, proof }) {
  if (!nonEmptyString(challenge) || !nonEmptyString(runtimeApiToken) || !nonEmptyString(proof)) return false;
  const expected = createRuntimeHealthProof({ challenge, runtimeApiToken });
  const expectedBuffer = Buffer.from(expected, "hex");
  const proofBuffer = Buffer.from(proof, "hex");
  return expectedBuffer.length === proofBuffer.length && timingSafeEqual(expectedBuffer, proofBuffer);
}
