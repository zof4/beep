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
  "web.fetch",
];

export const TOOL_MANIFEST = [
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
    name: "web_search",
    action: "web.search",
    label: "Web Search",
    description:
      "Search the public web through the control-plane web tool service using the configured provider adapter.",
    defaultDecision: "allow",
    scopes: ["web.search"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query.",
        },
        provider: {
          type: "string",
          description: "Optional provider override for evaluation. Omit for the configured search provider.",
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum ranked results to return.",
        },
        freshness: {
          type: "string",
          enum: ["day", "week", "month", "year"],
          description: "Optional freshness filter.",
        },
        includeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domain allowlist.",
        },
        excludeDomains: {
          type: "array",
          items: { type: "string" },
          description: "Optional domain denylist.",
        },
        country: {
          type: "string",
          description: "Optional country or region hint.",
        },
        language: {
          type: "string",
          description: "Optional language hint.",
        },
        includeContent: {
          type: "boolean",
          description: "When supported, return extracted page text or markdown with each result.",
        },
        includeAnswer: {
          type: "boolean",
          description: "When supported, also return a provider-generated sourced answer.",
        },
      },
    },
  },
  {
    name: "web_fetch",
    action: "web.fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract a specific public URL through the control-plane web tool service using the configured provider adapter.",
    defaultDecision: "allow",
    scopes: ["web.fetch"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Public http(s) URL to fetch.",
        },
        provider: {
          type: "string",
          description: "Optional provider override for evaluation. Omit for the configured fetch provider.",
        },
        query: {
          type: "string",
          description: "Optional intent used by providers that can rerank or summarize extracted content.",
        },
        contentFormat: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Preferred extracted content format.",
        },
      },
    },
  },
];
