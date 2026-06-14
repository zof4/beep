import {
  PREVIEW_CONTAINER_PORT_MAX,
  PREVIEW_CONTAINER_PORT_MIN,
} from "./config.mjs";

export const DEFAULT_ALLOWED_SCOPES = [
  "runtime.status.read",
  "runtime.agent.submit",
  "runtime.agent.read",
  "preview.port.expose",
  "web.search",
  "sandbox.tool.execute",
];

export const BUILTIN_TOOL_MANIFEST = [
  {
    name: "web_run",
    action: "web.run",
    namespace: "web",
    label: "Web Search",
    target: "control-plane",
    description: "Search or inspect current web content through the control-plane OpenAI web search provider.",
    promptSnippet: "Use web_run when current public web information is required.",
    defaultDecision: "allow",
    scopes: ["web.search"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        search_query: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["q"],
            properties: {
              q: {
                type: "string",
                description: "Search query.",
              },
              recency: {
                type: "integer",
                minimum: 0,
                description: "Optional recency window in days.",
              },
              domains: {
                type: "array",
                items: {
                  type: "string",
                },
                description: "Optional allowed domains.",
              },
            },
          },
        },
        open: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref_id"],
            properties: {
              ref_id: {
                type: "string",
                description: "URL or result reference to inspect.",
              },
            },
          },
        },
        find: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref_id", "pattern"],
            properties: {
              ref_id: {
                type: "string",
                description: "URL or result reference.",
              },
              pattern: {
                type: "string",
                description: "Text pattern to find.",
              },
            },
          },
        },
        response_length: {
          type: "string",
          enum: ["short", "medium", "long"],
          description: "Desired response length.",
        },
      },
    },
  },
  {
    name: "preview_port_expose",
    action: "preview.port.expose",
    label: "Expose Preview Port",
    description:
      "Expose an HTTP dev server already running inside the runtime container to the local browser through the control plane.",
    defaultDecision: "allow",
    scopes: ["preview.port.expose"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["port"],
      properties: {
        port: {
          type: "integer",
          minimum: PREVIEW_CONTAINER_PORT_MIN,
          maximum: PREVIEW_CONTAINER_PORT_MAX,
          description: "Container port where the dev server is listening.",
        },
        path: {
          type: "string",
          description: "Optional initial path to open.",
        },
        label: {
          type: "string",
          description: "Optional short human label for the exposure.",
        },
      },
    },
  },
  {
    name: "preview_container_create_static_site",
    action: "preview.container.createStaticSite",
    label: "Create Static Preview Container",
    description:
      "Request a managed static-site container for files already created inside the runtime workspace.",
    defaultDecision: "review",
    scopes: ["preview.container.createStaticSite"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["siteName", "sourcePath"],
      properties: {
        siteName: {
          type: "string",
          description: "Short site name used for labels and display.",
        },
        sourcePath: {
          type: "string",
          description: "Absolute runtime workspace path to a directory containing static files.",
        },
      },
    },
  },
  {
    name: "preview_container_update_static_site",
    action: "preview.container.updateStaticSite",
    label: "Update Static Preview Container",
    description:
      "Update an existing managed static-site preview from files already changed inside the runtime workspace while preserving the /sites/<siteId>/ URL.",
    defaultDecision: "review",
    scopes: ["preview.container.updateStaticSite"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["siteId", "sourcePath"],
      properties: {
        siteId: {
          type: "string",
          description: "Existing managed static preview site id returned by preview_container_create_static_site.",
        },
        sourcePath: {
          type: "string",
          description: "Absolute runtime workspace path to the updated static site directory.",
        },
      },
    },
  },
];

export const TOOL_MANIFEST = BUILTIN_TOOL_MANIFEST;

export function legacyWebRunToolEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED || "0").toLowerCase(),
  );
}

export function publicManifestTool(tool, env = process.env) {
  if (tool?.action === "web.run") return legacyWebRunToolEnabled(env);
  return true;
}
