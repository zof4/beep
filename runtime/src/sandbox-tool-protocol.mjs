const SUPPORTED_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "grep", "find"]);
const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find"]);

function nonEmptyString(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function isReadOnlySandboxTool(toolName) {
  return READ_ONLY_TOOLS.has(String(toolName || ""));
}

export function normalizeSandboxToolRequest(input = {}) {
  const toolName = nonEmptyString(input.toolName);
  if (!SUPPORTED_TOOLS.has(toolName)) {
    throw Object.assign(new Error(`Unsupported sandbox tool: ${toolName || "<missing>"}`), { status: 400 });
  }

  const toolCallId = nonEmptyString(input.toolCallId);
  if (!toolCallId) {
    throw Object.assign(new Error("toolCallId is required."), { status: 400 });
  }

  return {
    schemaVersion: 1,
    requestId: nonEmptyString(input.requestId, null),
    turnId: nonEmptyString(input.turnId, null),
    toolCallId,
    toolName,
    args: input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args : {},
    cwd: nonEmptyString(input.cwd, "/workspace"),
    timeoutMs: positiveInteger(input.timeoutMs, 60_000),
    sandboxGeneration: positiveInteger(input.sandboxGeneration, 1),
  };
}

export function sandboxToolOkResult({ toolCallId, content, details = {}, diagnostics = {} }) {
  return {
    ok: true,
    toolCallId,
    content: Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }],
    details,
    diagnostics,
    isError: false,
  };
}

export function sandboxToolErrorResult({ toolCallId, error, details = {}, diagnostics = {} }) {
  return {
    ok: false,
    toolCallId,
    content: [{ type: "text", text: String(error || "Sandbox tool failed.") }],
    details,
    diagnostics,
    isError: true,
  };
}
