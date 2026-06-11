import { Type } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readControlPlaneConfig() {
  const config = {
    enabled: boolEnv("BEEP_CONTROL_PLANE_TOOLS_ENABLED", false),
    controlPlaneUrl: process.env.BEEP_CONTROL_PLANE_URL,
    token: process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN,
    runtimeId: process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || "local",
    timeoutMs: positiveIntegerEnv("BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS", 15_000),
  };

  delete process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN;
  delete process.env.BEEP_CONTROL_PLANE_OPERATOR_TOKEN;
  delete process.env.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN;
  delete process.env.BEEP_MODEL_GATEWAY_CREDENTIAL_URL;

  return config;
}

async function postJson(url, body, { token, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

async function callControlPlaneTool(config, action, args, toolCallId) {
  const { controlPlaneUrl, token, runtimeId, timeoutMs } = config;
  if (!controlPlaneUrl || !token) {
    return {
      response: null,
      payload: {
        ok: false,
        status: "not_configured",
        error: "Control-plane tool capability is not configured in this runtime.",
      },
    };
  }

  try {
    const { response, payload } = await postJson(
      `${controlPlaneUrl.replace(/\/+$/u, "")}/internal/tools/call`,
      {
        runtimeId,
        action,
        args,
        toolCallId,
      },
      {
        token,
        timeoutMs,
      },
    );
    return { response, payload };
  } catch (error) {
    return {
      response: null,
      payload: {
        ok: false,
        status: "request_failed",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function fetchToolManifest(config) {
  const { controlPlaneUrl, token, timeoutMs } = config;
  const failedManifest = { ok: false, revision: null, tools: [] };
  if (!controlPlaneUrl || !token) return failedManifest;

  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          let input = "";
          process.stdin.setEncoding("utf8");
          for await (const chunk of process.stdin) input += chunk;
          const { url, token, timeoutMs } = JSON.parse(input);
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(url, {
              method: "GET",
              headers: { authorization: \`Bearer \${token}\` },
              signal: controller.signal,
            });
            const payload = await response.json().catch(() => ({}));
            process.stdout.write(JSON.stringify({ ok: response.ok, payload }));
          } catch (error) {
            process.stdout.write(JSON.stringify({ ok: false, payload: {} }));
          } finally {
            clearTimeout(timeout);
          }
        `,
      ],
      {
        input: JSON.stringify({
          url: `${controlPlaneUrl.replace(/\/+$/u, "")}/api/tools`,
          token,
          timeoutMs,
        }),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "ignore"],
        timeout: timeoutMs + 1000,
      },
    );
    const { ok, payload } = JSON.parse(output || "{}");
    if (!ok || payload?.ok === false || !Array.isArray(payload?.tools)) return failedManifest;
    return {
      ok: true,
      revision: typeof payload.revision === "string" ? payload.revision : null,
      tools: payload.tools.filter((tool) => tool && typeof tool === "object"),
    };
  } catch {
    return failedManifest;
  }
}

function schemaOptions(schema) {
  if (!schema || typeof schema !== "object") return {};
  const options = {};
  for (const key of [
    "description",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "enum",
    "default",
  ]) {
    if (schema[key] !== undefined) options[key] = schema[key];
  }
  return options;
}

function typeArray(Type, itemSchema, options) {
  if (typeof Type.Array === "function") return Type.Array(itemSchema, options);
  return Type.Object({});
}

function typeBoolean(Type, options) {
  if (typeof Type.Boolean === "function") return Type.Boolean(options);
  return Type.String(options);
}

function typeNumber(Type, options) {
  if (typeof Type.Number === "function") return Type.Number(options);
  return Type.Integer(options);
}

function typeOptional(Type, schema) {
  if (typeof Type.Optional === "function") return Type.Optional(schema);
  return schema;
}

function schemaToType(Type, schema) {
  if (!schema || typeof schema !== "object") return Type.Object({});

  const options = schemaOptions(schema);
  switch (schema.type) {
    case "object": {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
      const converted = {};
      for (const [name, propertySchema] of Object.entries(properties)) {
        const propertyType = schemaToType(Type, propertySchema);
        converted[name] = required.has(name) ? propertyType : typeOptional(Type, propertyType);
      }
      return Type.Object(converted, options);
    }
    case "string":
      return Type.String(options);
    case "integer":
      return Type.Integer(options);
    case "number":
      return typeNumber(Type, options);
    case "boolean":
      return typeBoolean(Type, options);
    case "array":
      return typeArray(Type, schemaToType(Type, schema.items || {}), options);
    default:
      return Type.Object({});
  }
}

function genericSuccessText(payload) {
  if (typeof payload?.result?.text === "string") return payload.result.text;
  const value = payload?.result !== undefined ? payload.result : payload;
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

function resultFromToolPayload(toolName, response, payload, successText) {
  if (payload?.status === "needs_review") {
    return textResult(
      [
        `${toolName} is waiting for user/operator approval.`,
        `approvalId: ${payload.approvalId}`,
        payload.approval?.prompt || payload.error || "",
      ]
        .filter(Boolean)
        .join("\n"),
      payload,
    );
  }
  if (!response?.ok || !payload?.ok) {
    return textResult(`${toolName} failed: ${payload?.error || response?.statusText || "not configured"}`, {
      ...payload,
      ok: false,
    });
  }
  return textResult(successText(payload), payload);
}

function validToolDefinition(definition) {
  return (
    definition &&
    typeof definition === "object" &&
    typeof definition.name === "string" &&
    definition.name.length > 0 &&
    typeof definition.action === "string" &&
    definition.action.length > 0
  );
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

function toolFingerprint(definition) {
  return stableJson(definition);
}

function makePiTool(config, definition) {
  return {
    name: definition.name,
    label: definition.label || definition.name,
    description: definition.description || definition.label || definition.name,
    promptSnippet: definition.promptSnippet || definition.description || definition.label || definition.name,
    parameters: schemaToType(Type, definition.inputSchema),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool(config, definition.action, params, toolCallId);
      return resultFromToolPayload(definition.name, response, payload, genericSuccessText);
    },
  };
}

export default function beepControlPlaneToolsExtension(pi) {
  const config = readControlPlaneConfig();
  if (!config.enabled) return;

  const state = {
    revision: null,
    fingerprints: new Map(),
    beepToolNames: new Set(),
  };

  function applyManifest(manifest) {
    if (!manifest?.ok) return false;
    if (manifest.revision && manifest.revision === state.revision) return false;

    const nextFingerprints = new Map();
    const nextToolNames = new Set();
    for (const definition of manifest.tools) {
      if (!validToolDefinition(definition)) continue;

      nextToolNames.add(definition.name);
      const fingerprint = toolFingerprint(definition);
      nextFingerprints.set(definition.name, fingerprint);
      if (state.fingerprints.get(definition.name) === fingerprint) continue;

      pi.registerTool(makePiTool(config, definition));
    }

    state.revision = manifest.revision;
    state.fingerprints = nextFingerprints;
    state.beepToolNames = nextToolNames;
    return true;
  }

  applyManifest(fetchToolManifest(config));

  if (typeof pi.on === "function") {
    pi.on("before_agent_start", () => {
      applyManifest(fetchToolManifest(config));
    });
  }
}
