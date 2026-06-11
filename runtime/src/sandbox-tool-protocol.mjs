const SUPPORTED_TOOLS = new Set(["bash", "read", "write", "edit", "ls", "grep", "find", "dynamic_cli"]);
const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find"]);
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;

function nonEmptyString(value, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertNoControlCharacters(value, label) {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw Object.assign(new Error(`${label} must not contain control characters.`), { status: 400 });
  }
}

function normalizeDynamicTool(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const command = input.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw Object.assign(new Error("dynamicTool.command is required."), { status: 400 });
  }
  if (!Array.isArray(command.argv) || command.argv.length < 2) {
    throw Object.assign(new Error("dynamicTool.command.argv must include an executable and script path."), {
      status: 400,
    });
  }

  const argv = command.argv.map((entry, index) => {
    const value = nonEmptyString(entry);
    if (!value) {
      throw Object.assign(new Error(`dynamicTool.command.argv[${index}] must be a non-empty string.`), {
        status: 400,
      });
    }
    assertNoControlCharacters(value, `dynamicTool.command.argv[${index}]`);
    return value;
  });
  const scriptPath = argv[1];
  if (scriptPath.startsWith("/") || scriptPath.includes("..") || !scriptPath.startsWith(".beep/tools/")) {
    throw Object.assign(new Error("dynamic tool command path must stay under .beep/tools/."), { status: 400 });
  }

  const action = nonEmptyString(input.action);
  if (action) assertNoControlCharacters(action, "dynamicTool.action");

  return {
    action,
    command: {
      argv,
      input: "json-stdin",
      timeoutMs: positiveInteger(command.timeoutMs, 15_000),
    },
  };
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
    dynamicTool: toolName === "dynamic_cli" ? normalizeDynamicTool(input.dynamicTool) : null,
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
