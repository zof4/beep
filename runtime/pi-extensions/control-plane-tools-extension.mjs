import { Type } from "@earendil-works/pi-ai";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

async function callControlPlaneTool(action, args, toolCallId) {
  const controlPlaneUrl = process.env.BEEP_CONTROL_PLANE_URL;
  const token = process.env.BEEP_CONTROL_PLANE_RUNTIME_TOKEN;
  const runtimeId = process.env.BEEP_CONTROL_PLANE_RUNTIME_ID || "local";
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
        timeoutMs: positiveIntegerEnv("BEEP_CONTROL_PLANE_TOOL_TIMEOUT_MS", 15_000),
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
  return textResult(successText(payload.result), payload);
}

export default function beepControlPlaneToolsExtension(pi) {
  if (!boolEnv("BEEP_CONTROL_PLANE_TOOLS_ENABLED", true)) return;

  pi.registerTool({
    name: "preview_port_expose",
    label: "Expose Preview Port",
    description:
      "Expose an HTTP dev server running inside the runtime container so it can be tested from the local browser.",
    promptSnippet:
      "Use preview_port_expose after starting a local web server inside the runtime container on a 3000-3099 port.",
    promptGuidelines: [
      "Start browser-testable dev servers on 0.0.0.0, not localhost, before exposing the port.",
      "Only use preview_port_expose for HTTP preview servers that should be visible to the local control surface.",
    ],
    parameters: Type.Object({
      port: Type.Integer({
        minimum: 3000,
        maximum: 3099,
        description: "Container port where the dev server is listening.",
      }),
      path: Type.Optional(Type.String({ description: "Optional initial path to open." })),
      label: Type.Optional(Type.String({ description: "Optional short label for the preview." })),
    }),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool("preview.port.expose", params, toolCallId);
      return resultFromToolPayload("preview_port_expose", response, payload, (result) =>
        [
          `Preview exposed: ${result.url}`,
          `Direct mapped URL: ${result.directUrl}`,
          result.note,
        ].join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "preview_container_create_static_site",
    label: "Create Static Preview Container",
    description:
      "Request a managed static-site preview container for a directory already created inside the runtime workspace.",
    promptSnippet:
      "Use preview_container_create_static_site when a static site directory is ready and should run in its own managed preview container.",
    promptGuidelines: [
      "Only request a static-site container for directories inside /workspace.",
      "Create an index.html in the source directory before requesting the preview container.",
      "This tool requires user/operator approval before the container is created.",
    ],
    parameters: Type.Object({
      siteName: Type.String({ description: "Short site name for labels and display." }),
      sourcePath: Type.String({
        description:
          "Absolute runtime path to the static site directory, for example /workspace/api-sessions/agent_beep/site.",
      }),
    }),
    async execute(toolCallId, params) {
      const { response, payload } = await callControlPlaneTool(
        "preview.container.createStaticSite",
        params,
        toolCallId,
      );
      return resultFromToolPayload("preview_container_create_static_site", response, payload, (result) =>
        [
          `Static preview container created: ${result.proxyUrl}`,
          `Direct mapped URL: ${result.directUrl}`,
          `siteId: ${result.siteId}`,
        ].join("\n"),
      );
    },
  });
}
