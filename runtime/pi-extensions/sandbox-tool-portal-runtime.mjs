function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DETAIL_STRING_CAP_BYTES = 128 * 1024;
const DETAIL_JSON_CAP_BYTES = 256 * 1024;
const CONTENT_TEXT_CAP_BYTES = 128 * 1024;
const MIN_PORTAL_TIMEOUT_CUSHION_MS = 1000;
const MAX_PORTAL_TIMEOUT_CUSHION_MS = 5000;

function truncateText(text, capBytes = DETAIL_STRING_CAP_BYTES) {
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  if (buffer.length <= capBytes) return { text: String(text ?? ""), truncated: false };
  return {
    text: `${buffer.subarray(0, capBytes).toString("utf8")}\n[output truncated at ${capBytes} bytes]`,
    truncated: true,
  };
}

function sanitizeDetailValue(value) {
  if (typeof value === "string") return truncateText(value).text;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeDetailValue(entry));

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, entry]) => [key, sanitizeDetailValue(entry)]),
  );
}

function sanitizeDetails(details = {}) {
  const sanitized = sanitizeDetailValue(details && typeof details === "object" ? details : {});
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized || "", "utf8") <= DETAIL_JSON_CAP_BYTES) return sanitized;
  const summary = truncateText(serialized, DETAIL_JSON_CAP_BYTES);
  return {
    ok: false,
    detailsTruncated: true,
    summary: summary.text,
  };
}

function sanitizeContent(content, fallbackText) {
  const fallback = [{ type: "text", text: fallbackText }];
  const parts = Array.isArray(content) ? content : fallback;
  const sanitized = [];
  let remainingTextBytes = CONTENT_TEXT_CAP_BYTES;

  for (const part of parts) {
    if (sanitized.length >= 100 || remainingTextBytes <= 0) {
      sanitized.push({ type: "text", text: `[content truncated at ${CONTENT_TEXT_CAP_BYTES} bytes]` });
      break;
    }

    if (!part || typeof part !== "object") continue;
    if (part.type !== "text") {
      const partType = typeof part.type === "string" && part.type ? part.type : "unknown";
      const placeholder = `[non-text content omitted: ${partType}]`;
      const output = truncateText(placeholder, remainingTextBytes);
      sanitized.push({ type: "text", text: output.text });
      remainingTextBytes -= Math.min(Buffer.byteLength(placeholder, "utf8"), remainingTextBytes);
      continue;
    }

    const rawText = String(part.text ?? "");
    const output = truncateText(rawText, remainingTextBytes);
    sanitized.push({ type: "text", text: output.text });
    remainingTextBytes -= Math.min(Buffer.byteLength(rawText, "utf8"), remainingTextBytes);
    if (output.truncated) break;
  }

  return sanitized.length ? sanitized : fallback;
}

function maybeOptional(Type, schema) {
  return Type.Optional(schema);
}

export function readSandboxPortalConfig() {
  const config = {
    enabled: boolEnv("BEEP_SANDBOX_TOOL_PORTAL_ENABLED", false),
    url: process.env.BEEP_SANDBOX_TOOL_PORTAL_URL || "http://127.0.0.1:8787/internal/sandbox/tools/call",
    token: process.env.BEEP_SANDBOX_TOOL_PORTAL_TOKEN || process.env.BEEP_RUNTIME_API_TOKEN || "",
    timeoutMs: positiveIntegerEnv("BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS", 60_000),
  };

  delete process.env.BEEP_SANDBOX_TOOL_PORTAL_TOKEN;
  delete process.env.BEEP_RUNTIME_API_TOKEN;
  delete process.env.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN;
  delete process.env.BEEP_MODEL_GATEWAY_CREDENTIAL_URL;

  return config;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function timeoutMsForCall(config, toolName, args = {}) {
  if (toolName !== "bash") return config.timeoutMs;
  const seconds = Number(args.timeout);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : config.timeoutMs;
}

function requestTimeoutMsForCall(timeoutMs) {
  const cushion = Math.min(
    MAX_PORTAL_TIMEOUT_CUSHION_MS,
    Math.max(MIN_PORTAL_TIMEOUT_CUSHION_MS, Math.ceil(timeoutMs * 0.1)),
  );
  return timeoutMs + cushion;
}

async function callPortal(config, toolName, toolCallId, args) {
  if (!config.url || !config.token) {
    return {
      content: [{ type: "text", text: "Sandbox tool portal is not configured." }],
      details: { ok: false, status: "not_configured" },
      isError: true,
    };
  }

  const timeoutMs = timeoutMsForCall(config, toolName, args);
  const requestTimeoutMs = requestTimeoutMsForCall(timeoutMs);
  try {
    const { response, payload } = await fetchJson(
      config.url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ toolCallId, toolName, args, timeoutMs }),
      },
      requestTimeoutMs,
    );

    if (!response.ok || payload?.ok === false) {
      const fallbackText = payload?.error || response.statusText || `${toolName} failed`;
      return {
        content: sanitizeContent(payload?.content, fallbackText),
        details: { ...sanitizeDetails(payload?.details), ok: false },
        isError: true,
      };
    }

    return {
      content: sanitizeContent(payload?.content, `${toolName} succeeded.`),
      details: sanitizeDetails(payload?.details),
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      details: { ok: false, status: "request_failed" },
      isError: true,
    };
  }
}

function prepareEditArguments(args) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
  let edits = input.edits;
  if (typeof edits === "string") {
    try {
      const parsed = JSON.parse(edits);
      if (Array.isArray(parsed)) edits = parsed;
    } catch {
      edits = [];
    }
  }
  if (!Array.isArray(edits)) edits = [];
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    edits = [...edits, { oldText: input.oldText, newText: input.newText }];
  }
  const { oldText: _oldText, newText: _newText, ...rest } = input;
  return { ...rest, edits };
}

function toolTextResult(result) {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "image") return `[image:${part.mimeType || "unknown"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderText(Text, context, text) {
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(text);
  return component;
}

function compactArgs(args = {}) {
  const pairs = Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
  return pairs.join(" ");
}

function withPortalRenderers(Text, tool) {
  return {
    ...tool,
    renderShell: "default",
    renderCall(args, _theme, context) {
      return renderText(Text, context, `${tool.name} ${compactArgs(args)}`.trim());
    },
    renderResult(result, _options, _theme, context) {
      return renderText(Text, context, toolTextResult(result));
    },
  };
}

export function buildSandboxPortalTools(Type, Text, config) {
  const numberType = Type.Number ? Type.Number.bind(Type) : Type.Integer.bind(Type);
  const replaceEditSchema = Type.Object(
    {
      oldText: Type.String({
        description: "Exact text to replace. It must uniquely match the original file.",
      }),
      newText: Type.String({ description: "Replacement text." }),
    },
    { additionalProperties: false },
  );

  return [
    withPortalRenderers(Text, {
      name: "bash",
      label: "bash",
      description: "Run a bash command in the Docker sandbox workspace.",
      promptSnippet: "Run shell commands inside the Docker sandbox workspace",
      parameters: Type.Object({
        command: Type.String({ description: "Bash command to execute." }),
        timeout: maybeOptional(Type, numberType({ description: "Timeout in seconds." })),
      }),
      execute: (toolCallId, params) => callPortal(config, "bash", toolCallId, params),
    }),
    withPortalRenderers(Text, {
      name: "read",
      label: "read",
      description: "Read a file from the Docker sandbox workspace.",
      promptSnippet: "Read files from the Docker sandbox workspace",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative or sandbox-absolute file path to read." }),
        offset: maybeOptional(Type, numberType({ description: "One-based starting line." })),
        limit: maybeOptional(Type, numberType({ description: "Maximum number of lines to return." })),
      }),
      execute: (toolCallId, params) => callPortal(config, "read", toolCallId, params),
    }),
    withPortalRenderers(Text, {
      name: "write",
      label: "write",
      description: "Write a file in the Docker sandbox workspace.",
      promptSnippet: "Write files in the Docker sandbox workspace",
      parameters: Type.Object({
        path: Type.String({ description: "Workspace-relative or sandbox-absolute file path to write." }),
        content: Type.String({ description: "File content." }),
      }),
      execute: (toolCallId, params) => callPortal(config, "write", toolCallId, params),
    }),
    withPortalRenderers(Text, {
      name: "edit",
      label: "edit",
      description:
        "Edit a single file in the Docker sandbox workspace using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
      promptSnippet: "Make precise file edits inside the Docker sandbox workspace",
      promptGuidelines: [
        "Use edit for precise changes in sandbox files.",
        "Each edits[].oldText must match exactly and uniquely in the original file.",
        "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[].",
      ],
      parameters: Type.Object(
        {
          path: Type.String({ description: "Workspace-relative or sandbox-absolute file path to edit." }),
          edits: Type.Array(replaceEditSchema, {
            description: "One or more exact replacements matched against the original file.",
          }),
        },
        { additionalProperties: false },
      ),
      prepareArguments: prepareEditArguments,
      execute: (toolCallId, params) => callPortal(config, "edit", toolCallId, params),
    }),
    withPortalRenderers(Text, {
      name: "ls",
      label: "ls",
      description: "List a directory in the Docker sandbox workspace.",
      promptSnippet: "List directories in the Docker sandbox workspace",
      parameters: Type.Object({
        path: maybeOptional(Type, Type.String({ description: "Directory to list." })),
        limit: maybeOptional(Type, numberType({ description: "Maximum entries to return." })),
      }),
      execute: (toolCallId, params) => callPortal(config, "ls", toolCallId, params),
    }),
    withPortalRenderers(Text, {
      name: "grep",
      label: "grep",
      description: "Search file contents in the Docker sandbox workspace.",
      promptSnippet: "Search file contents in the Docker sandbox workspace",
      parameters: Type.Object({
        pattern: Type.String({ description: "Pattern to search for." }),
        path: maybeOptional(Type, Type.String({ description: "File or directory to search." })),
        glob: maybeOptional(Type, Type.String({ description: "Optional glob." })),
        ignoreCase: maybeOptional(Type, Type.Boolean({ description: "Ignore case." })),
        literal: maybeOptional(Type, Type.Boolean({ description: "Treat pattern literally." })),
        context: maybeOptional(Type, numberType({ description: "Context lines." })),
        limit: maybeOptional(Type, numberType({ description: "Maximum matches." })),
      }),
      execute: (toolCallId, params) => callPortal(config, "grep", toolCallId, params),
    }),
    withPortalRenderers(Text, {
      name: "find",
      label: "find",
      description: "Find files in the Docker sandbox workspace.",
      promptSnippet: "Find files in the Docker sandbox workspace",
      parameters: Type.Object({
        pattern: Type.String({ description: "Filename pattern to find." }),
        path: maybeOptional(Type, Type.String({ description: "Directory to search." })),
        limit: maybeOptional(Type, numberType({ description: "Maximum results." })),
      }),
      execute: (toolCallId, params) => callPortal(config, "find", toolCallId, params),
    }),
  ];
}

export function registerSandboxPortalTools(pi, { Type, Text, config }) {
  if (!config.enabled) return;
  for (const tool of buildSandboxPortalTools(Type, Text, config)) {
    pi.registerTool(tool);
  }
}
