const PROTECTED_RUNTIME_API_ROOTS = new Set(["agent", "sessions"]);

export function runtimeApiAuthRequired(pathname) {
  const parts = String(pathname || "/")
    .split("/")
    .filter(Boolean);
  const root = parts[0] || "";
  return PROTECTED_RUNTIME_API_ROOTS.has(root) || root === "runs";
}

export function authorizeRuntimeApiRequest({ pathname, authorization, runtimeApiToken }) {
  if (typeof runtimeApiToken !== "string" || runtimeApiToken.length === 0) {
    return { ok: true, required: false };
  }
  if (!runtimeApiAuthRequired(pathname)) {
    return { ok: true, required: false };
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
