import { RUNTIME_ID } from "./config.mjs";
import { BUILTIN_TOOL_MANIFEST, DEFAULT_ALLOWED_SCOPES } from "./tool-manifest.mjs";

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
    return {
      schemaVersion: 2,
      runtimeId: RUNTIME_ID,
      defaultAllowedScopes: DEFAULT_ALLOWED_SCOPES,
      tools: this.tools().map((tool) => publicToolDefinition(tool)),
    };
  }
}
