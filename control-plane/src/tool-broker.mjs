import {
  PREVIEW_CONTAINER_PORT_MAX,
  PREVIEW_CONTAINER_PORT_MIN,
  PREVIEW_HOST_PORT_BASE,
  PUBLIC_BASE_URL,
  RUNTIME_ID,
} from "./config.mjs";
import { createStaticSitePreview } from "./static-site-preview.mjs";
import { DEFAULT_ALLOWED_SCOPES, TOOL_MANIFEST } from "./tool-manifest.mjs";
import { ToolBrokerError } from "./tool-broker-error.mjs";
import { WebToolService } from "./web-tool-service.mjs";

function normalizePath(path = "/") {
  if (typeof path !== "string" || path.trim() === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

export function hostPortForContainerPort(port) {
  return PREVIEW_HOST_PORT_BASE + (port - PREVIEW_CONTAINER_PORT_MIN);
}

export function validatePreviewPort(port) {
  if (!Number.isInteger(port) || port < PREVIEW_CONTAINER_PORT_MIN || port > PREVIEW_CONTAINER_PORT_MAX) {
    throw new ToolBrokerError(
      `Preview port must be an integer from ${PREVIEW_CONTAINER_PORT_MIN} through ${PREVIEW_CONTAINER_PORT_MAX}.`,
      400,
    );
  }
}

export class ToolBroker {
  constructor({ store }) {
    this.store = store;
    this.toolsByAction = new Map(TOOL_MANIFEST.map((tool) => [tool.action, tool]));
    this.webTools = new WebToolService();
  }

  manifest() {
    return {
      schemaVersion: 1,
      runtimeId: RUNTIME_ID,
      defaultAllowedScopes: DEFAULT_ALLOWED_SCOPES,
      tools: TOOL_MANIFEST,
      webTools: this.webTools.manifest(),
    };
  }

  async call({ runtimeId = RUNTIME_ID, action, tool, args = {}, toolCallId = null }) {
    const requestedAction = action || tool;
    const definition = this.toolsByAction.get(requestedAction);
    if (!definition) {
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "deny",
        status: "denied",
        error: `Unknown tool action: ${requestedAction}`,
      });
    }

    const missingScope = definition.scopes.find((scope) => !DEFAULT_ALLOWED_SCOPES.includes(scope));
    if (missingScope) {
      const approval = this.createApproval({
        runtimeId,
        toolCallId,
        action: requestedAction,
        args,
        risk: "high",
        prompt: `Approve ${definition.label}?`,
        reason: `Tool requires scope ${missingScope}.`,
      });
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "review",
        status: "needs_review",
        error: "Waiting for user/operator approval.",
        approval,
      });
    }

    if (definition.defaultDecision !== "allow") {
      const approval = this.createApproval({
        runtimeId,
        toolCallId,
        action: requestedAction,
        args,
        risk: "high",
        prompt: `Approve ${definition.label}?`,
        reason: "Tool is configured for review.",
      });
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "review",
        status: "needs_review",
        error: "Waiting for user/operator approval.",
        approval,
      });
    }

    if (requestedAction === "preview.port.expose") {
      const result = this.exposePreviewPort(runtimeId, args);
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "allow",
        status: "ok",
        result,
      });
    }

    if (requestedAction === "web.search") {
      const result = await this.webTools.search(args);
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "allow",
        status: "ok",
        result,
      });
    }

    if (requestedAction === "web.fetch") {
      const result = await this.webTools.fetch(args);
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "allow",
        status: "ok",
        result,
      });
    }

    return this.finish({
      runtimeId,
      toolCallId,
      action: requestedAction,
      decision: "deny",
      status: "denied",
      error: `No broker implementation for ${requestedAction}.`,
    });
  }

  createApproval({ runtimeId, toolCallId, action, args, risk, prompt, reason }) {
    return this.store.createApproval({
      runtimeId,
      toolCallId,
      action,
      args,
      risk,
      prompt,
      reason,
    });
  }

  exposePreviewPort(runtimeId, args) {
    if (runtimeId !== RUNTIME_ID) {
      throw new ToolBrokerError(`Unknown runtimeId: ${runtimeId}`, 404);
    }
    const port = Number(args.port);
    validatePreviewPort(port);
    const path = normalizePath(args.path);
    const hostPort = hostPortForContainerPort(port);
    const baseUrl = `${PUBLIC_BASE_URL}/preview/${runtimeId}/${port}/`;
    const directUrl = `http://127.0.0.1:${hostPort}/`;
    const exposure = {
      runtimeId,
      containerPort: port,
      hostPort,
      label: typeof args.label === "string" ? args.label.slice(0, 80) : null,
      baseUrl,
      url: new URL(path.slice(1), baseUrl).toString(),
      directUrl: new URL(path.slice(1), directUrl).toString(),
      note: "The dev server inside the runtime must bind 0.0.0.0.",
    };
    this.store.upsertExposure(exposure);
    return exposure;
  }

  async executeApprovedApproval(approval) {
    if (!approval || approval.status !== "executing") {
      throw new ToolBrokerError("Approval must be in executing state before broker execution.", 409);
    }
    if (approval.action === "preview.container.createStaticSite") {
      return createStaticSitePreview({
        runtimeId: approval.runtimeId,
        args: approval.args || {},
        approvalId: approval.approvalId,
        store: this.store,
      });
    }
    throw new ToolBrokerError(`No approved broker implementation for ${approval.action}.`, 400);
  }

  finish(event) {
    this.store.appendAudit({
      kind: "tool_call",
      runtimeId: event.runtimeId,
      toolCallId: event.toolCallId,
      action: event.action,
      decision: event.decision,
      status: event.status,
      error: event.error || null,
    });
    if (event.status === "ok") {
      return { ok: true, status: "ok", decision: event.decision, result: event.result };
    }
    return {
      ok: false,
      status: event.status,
      decision: event.decision,
      error: event.error,
      ...(event.approval
        ? {
            approvalId: event.approval.approvalId,
            approval: event.approval,
          }
        : {}),
    };
  }
}
