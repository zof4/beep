const OUTCOMES = new Set(["allow", "allow_for_session", "deny", "timeout", "circuit_breaker", "escalate_to_user"]);
const RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);
const AUTH_LEVELS = new Set(["unknown", "low", "medium", "high"]);

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function normalizeGatekeeperDecision(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gatekeeper decision must be a JSON object.");
  }
  const outcome = value.outcome;
  if (!OUTCOMES.has(outcome)) {
    throw new Error(`Invalid gatekeeper outcome: ${String(outcome)}`);
  }
  const riskLevel = RISK_LEVELS.has(value.riskLevel) ? value.riskLevel : "high";
  const userAuthorization = AUTH_LEVELS.has(value.userAuthorization) ? value.userAuthorization : "unknown";
  const auditRationale = cleanString(value.auditRationale, "Gatekeeper did not provide an audit rationale.");
  const agentMessage = cleanString(
    value.agentMessage,
    outcome === "allow" || outcome === "allow_for_session"
      ? "The action was approved by the control-plane gatekeeper."
      : "The action was not approved by the control-plane gatekeeper.",
  );
  const userPrompt = outcome === "escalate_to_user" ? cleanString(value.userPrompt, agentMessage) : null;
  return {
    outcome,
    scope: "once",
    riskLevel,
    userAuthorization,
    auditRationale,
    agentMessage,
    userPrompt,
  };
}
