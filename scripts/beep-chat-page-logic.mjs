const BUSY_PHASES = new Set([
  "agent_running",
  "running",
  "starting",
  "thinking",
  "tool_running",
  "turn_running",
  "streaming",
]);

export function agentStatusFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.agent && typeof payload.agent === "object") return payload.agent;
  return payload;
}

export function agentSessionPhase(agent) {
  return String(agent?.session?.phase || agent?.sessionPhase || "").toLowerCase();
}

export function isAgentBusy(agent) {
  if (!agent || typeof agent !== "object") return false;
  const queueDepth = Number(agent.queueDepth || 0);
  return Boolean(agent.activeRequestId) || queueDepth > 0 || BUSY_PHASES.has(agentSessionPhase(agent));
}

export function shouldPromoteAgentSubmit(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ok === false) return false;
  const agent = agentStatusFromPayload(payload);
  if (!agent || typeof agent !== "object") return false;
  if (agent.paused) return false;
  return !isAgentBusy(agent);
}
