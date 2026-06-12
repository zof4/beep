import { createHash } from "node:crypto";
import { RUNTIME_ID } from "./config.mjs";
import { BUILTIN_TOOL_MANIFEST, DEFAULT_ALLOWED_SCOPES, publicManifestTool } from "./tool-manifest.mjs";

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
  return JSON.stringify(value);
}

function manifestRevision(manifestWithoutRevision) {
  return `sha256:${createHash("sha256").update(stableJson(manifestWithoutRevision)).digest("hex")}`;
}

function publicToolDefinition(tool) {
  return {
    name: tool.name,
    action: tool.action,
    namespace: tool.namespace || null,
    label: tool.label || tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet || tool.description,
    inputSchema: tool.inputSchema,
    defaultDecision: tool.defaultDecision || "review",
    scopes: tool.scopes || [],
    target: tool.target || "control-plane",
    deferLoading: Boolean(tool.deferLoading),
    packageId: tool.packageId ?? null,
    version: tool.version ?? null,
    packageVersionId: tool.packageVersionId ?? null,
  };
}

export class ToolRegistry {
  constructor({ store }) {
    this.store = store;
  }

  builtins() {
    return BUILTIN_TOOL_MANIFEST;
  }

  enabledGeneratedTools() {
    return this.store.listEnabledToolDefinitions();
  }

  tools() {
    return [...this.builtins(), ...this.enabledGeneratedTools()];
  }

  get(action) {
    return this.tools().find((tool) => tool.action === action) || null;
  }

  manifest() {
    const manifest = {
      schemaVersion: 2,
      runtimeId: RUNTIME_ID,
      defaultAllowedScopes: DEFAULT_ALLOWED_SCOPES,
      tools: this.tools().filter((tool) => publicManifestTool(tool)).map((tool) => publicToolDefinition(tool)),
    };
    return {
      ...manifest,
      revision: manifestRevision(manifest),
    };
  }
}
