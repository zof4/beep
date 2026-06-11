const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const PACKAGE_VERSION = /^[A-Za-z0-9_.-]{1,64}$/u;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;
const DEFAULT_TIMEOUT_MS = 15000;
const SANDBOX_TOOL_SCOPE = "sandbox.tool.execute";

const RESERVED_NAMESPACES = new Set([
  "api_tool",
  "browser",
  "computer",
  "container",
  "file_search",
  "functions",
  "image_gen",
  "mcp",
  "multi_tool_use",
  "python",
  "python_user_visible",
  "submodel_delegator",
  "terminal",
  "tool_search",
  "web",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} must match ${IDENTIFIER}`);
  }
}

function assertPackageVersion(value) {
  if (typeof value !== "string" || !PACKAGE_VERSION.test(value)) {
    throw new Error(`manifest.version must match ${PACKAGE_VERSION}`);
  }
}

function assertInputSchema(inputSchema) {
  assertObject(inputSchema, "tool.inputSchema");
  if (inputSchema.type !== "object") {
    throw new Error("tool.inputSchema.type must be object");
  }
  if (!isObject(inputSchema.properties)) {
    throw new Error("tool.inputSchema.properties must be an object");
  }
}

function normalizeCommand(command, packageId) {
  assertObject(command, "tool.command");
  if (!Array.isArray(command.argv) || command.argv.length < 2) {
    throw new Error("tool.command.argv must contain an executable and a package script path");
  }

  for (const entry of command.argv) {
    if (typeof entry !== "string" || entry.trim() === "" || CONTROL_CHARS.test(entry)) {
      throw new Error("tool.command.argv entries must be non-empty strings without control characters");
    }
  }

  const scriptPath = command.argv[1];
  const requiredPrefix = `.beep/tools/${packageId}/`;
  if (scriptPath.startsWith("/") || scriptPath.includes("..") || !scriptPath.startsWith(requiredPrefix)) {
    throw new Error("tool.command argv path must stay under .beep/tools/<packageId>/");
  }

  return {
    argv: [...command.argv],
    input: "json-stdin",
    timeoutMs: Number.isInteger(command.timeoutMs) && command.timeoutMs > 0 ? command.timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function normalizeScopes(scopes) {
  if (scopes === undefined || !Array.isArray(scopes) || scopes.length === 0) {
    return [SANDBOX_TOOL_SCOPE];
  }
  if (!scopes.every((scope) => scope === SANDBOX_TOOL_SCOPE)) {
    throw new Error("generated sandbox tools may only request sandbox.tool.execute");
  }
  return [SANDBOX_TOOL_SCOPE];
}

function normalizeTool(tool, packageId) {
  assertObject(tool, "tool");
  assertIdentifier(tool.name, "tool.name");
  assertIdentifier(tool.namespace, "tool.namespace");

  if (RESERVED_NAMESPACES.has(tool.namespace) || tool.namespace.startsWith("mcp__")) {
    throw new Error(`reserved namespace: ${tool.namespace}`);
  }

  if (typeof tool.action !== "string" || !tool.action.startsWith(`beep.tools.${packageId}.`)) {
    throw new Error(`tool.action must start with beep.tools.${packageId}.`);
  }

  if (typeof tool.description !== "string" || tool.description.trim().length < 12) {
    throw new Error("tool.description must be a trimmed string at least 12 characters");
  }

  assertInputSchema(tool.inputSchema);

  if (tool.target !== "sandbox") {
    throw new Error("generated tool target must be sandbox");
  }

  const command = normalizeCommand(tool.command, packageId);
  const scopes = normalizeScopes(tool.scopes);
  const defaultDecision = tool.defaultDecision === "allow" ? "allow" : "review";

  return {
    ...tool,
    description: tool.description.trim(),
    inputSchema: tool.inputSchema,
    target: "sandbox",
    command,
    scopes,
    defaultDecision,
    deferLoading: Boolean(tool.deferLoading),
    modelName: `${tool.namespace}.${tool.name}`,
  };
}

export function validateToolPackageManifest(input) {
  assertObject(input, "manifest");

  if (input.schemaVersion !== 1) {
    throw new Error("manifest.schemaVersion must be 1");
  }
  assertIdentifier(input.packageId, "manifest.packageId");
  assertPackageVersion(input.version);
  if (typeof input.packageHash !== "string" || !input.packageHash.startsWith("sha256:")) {
    throw new Error("manifest.packageHash must start with sha256:");
  }
  if (input.source !== "sandbox") {
    throw new Error("manifest.source must be sandbox");
  }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    throw new Error("manifest.tools must be a non-empty array");
  }

  const modelNames = new Set();
  const tools = input.tools.map((tool) => {
    const normalized = normalizeTool(tool, input.packageId);
    if (modelNames.has(normalized.modelName)) {
      throw new Error(`duplicate tool model name: ${normalized.modelName}`);
    }
    modelNames.add(normalized.modelName);
    return normalized;
  });

  return {
    schemaVersion: 1,
    packageId: input.packageId,
    version: input.version,
    packageHash: input.packageHash,
    source: "sandbox",
    tools,
  };
}
