import {
  PREVIEW_CONTAINER_PORT_MAX,
  PREVIEW_CONTAINER_PORT_MIN,
} from "./config.mjs";

export const DEFAULT_ALLOWED_SCOPES = [
  "runtime.status.read",
  "runtime.agent.submit",
  "runtime.agent.read",
  "preview.port.expose",
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
];
