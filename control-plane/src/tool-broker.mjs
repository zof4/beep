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

function normalizePreviewUrlPath(path = "/") {
  if (typeof path !== "string" || /[\u0000-\u001F\u007F\\]/u.test(path)) {
    return "";
  }
  const trimmedPath = path.trim();
  if (path !== trimmedPath) {
    return "";
  }
  if (trimmedPath === "" || trimmedPath.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(trimmedPath)) {
    return "";
  }
  const relativePath = trimmedPath.startsWith("/") ? trimmedPath.slice(1) : trimmedPath;
  if (relativePath.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relativePath)) {
    return "";
  }
  const pathOnly = relativePath.split(/[?#]/u, 1)[0];
  for (const component of pathOnly.split("/")) {
    let decodedComponent;
    try {
      decodedComponent = decodeURIComponent(component);
    } catch {
      return "";
    }
    if (decodedComponent === "." || decodedComponent === ".." || /[\/\\]/u.test(decodedComponent)) {
      return "";
    }
  }
  return relativePath;
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
  constructor({ store, gatekeeper = null }) {
    this.store = store;
    this.gatekeeper = gatekeeper;
    this.toolsByAction = new Map(TOOL_MANIFEST.map((tool) => [tool.action, tool]));
  }

  manifest() {
    return {
      schemaVersion: 1,
      runtimeId: RUNTIME_ID,
      defaultAllowedScopes: DEFAULT_ALLOWED_SCOPES,
      tools: TOOL_MANIFEST,
    };
  }

  async call({ runtimeId = RUNTIME_ID, action, tool, args = {}, toolCallId = null }) {
    const requestedAction = action || tool;
    if (runtimeId !== RUNTIME_ID) {
      return {
        ok: false,
        status: "denied",
        decision: "deny",
        error: `Unknown runtimeId: ${runtimeId}`,
      };
    }

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
      return this.reviewRestrictedCall({
        runtimeId,
        toolCallId,
        requestedAction,
        args,
        definition,
        risk: "high",
        prompt: `Approve ${definition.label}?`,
        reason: `Tool requires scope ${missingScope}.`,
      });
    }

    if (definition.defaultDecision !== "allow") {
      return this.reviewRestrictedCall({
        runtimeId,
        toolCallId,
        requestedAction,
        args,
        definition,
        risk: "high",
        prompt: `Approve ${definition.label}?`,
        reason: "Tool is configured for review.",
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

    return this.finish({
      runtimeId,
      toolCallId,
      action: requestedAction,
      decision: "deny",
      status: "denied",
      error: `No broker implementation for ${requestedAction}.`,
    });
  }

  createApproval({ runtimeId, toolCallId, action, args, risk, prompt, reason, ...extra }) {
    return this.store.createApproval({
      runtimeId,
      toolCallId,
      action,
      args,
      risk,
      prompt,
      reason,
      ...extra,
    });
  }

  async reviewRestrictedCall({ runtimeId, toolCallId, requestedAction, args, definition, risk, prompt, reason }) {
    const classification = { risk, prompt, reason };
    const review = await this.gatekeeper?.review({
      runtimeId,
      toolCallId,
      action: requestedAction,
      args,
      definition,
      classification,
    });

    if (review?.decision?.outcome === "allow") {
      const approval = this.createApproval({
        runtimeId,
        toolCallId,
        action: requestedAction,
        args,
        risk: review.decision.riskLevel || risk,
        prompt,
        reason: review.decision.agentMessage || reason,
        decision: "auto_approve",
        decidedBy: "gatekeeper",
        gatekeeperReviewId: review.reviewId,
        decidedAt: new Date().toISOString(),
      });
      const executing = this.store.updateApproval(approval.approvalId, {
        status: "executing",
      });
      if (!executing) {
        throw new ToolBrokerError("Auto-approved broker approval could not transition to executing.", 409);
      }
      try {
        const result = await this.executeApprovedApproval(executing);
        const approved = this.store.updateApproval(executing.approvalId, {
          status: "approved",
          result,
          executedAt: new Date().toISOString(),
        });
        return this.finish({
          runtimeId,
          toolCallId,
          action: requestedAction,
          decision: "allow",
          status: "ok",
          gatekeeper: publicGatekeeperReview(review),
          result: {
            ...result,
            gatekeeper: { ...publicGatekeeperReview(review), approvalId: approved?.approvalId || executing.approvalId },
          },
        });
      } catch (error) {
        const failed = this.store.updateApproval(executing.approvalId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        });
        return this.finish({
          runtimeId,
          toolCallId,
          action: requestedAction,
          decision: "deny",
          status: "denied",
          gatekeeper: publicGatekeeperReview(review),
          error: failed?.error || "Approved broker execution failed.",
        });
      }
    }

    if (review?.decision?.outcome === "deny") {
      return this.finish({
        runtimeId,
        toolCallId,
        action: requestedAction,
        decision: "deny",
        status: "denied",
        error: review.decision.agentMessage || "Denied by control-plane gatekeeper.",
        gatekeeper: publicGatekeeperReview(review),
      });
    }

    const approval = this.createApproval({
      runtimeId,
      toolCallId,
      action: requestedAction,
      args,
      risk: review?.decision?.riskLevel || risk,
      prompt: review?.decision?.userPrompt || prompt,
      reason: review?.decision?.agentMessage || reason,
      gatekeeperReviewId: review?.reviewId || null,
    });
    return this.finish({
      runtimeId,
      toolCallId,
      action: requestedAction,
      decision: "review",
      status: "needs_review",
      error: review?.decision?.agentMessage || "Waiting for user/operator approval.",
      approval,
      gatekeeper: publicGatekeeperReview(review),
    });
  }

  exposePreviewPort(runtimeId, args) {
    if (runtimeId !== RUNTIME_ID) {
      throw new ToolBrokerError(`Unknown runtimeId: ${runtimeId}`, 404);
    }
    const port = Number(args.port);
    validatePreviewPort(port);
    const path = normalizePreviewUrlPath(args.path);
    const hostPort = hostPortForContainerPort(port);
    const baseUrl = `${PUBLIC_BASE_URL}/preview/${runtimeId}/${port}/`;
    const directUrl = `http://127.0.0.1:${hostPort}/`;
    const exposure = {
      runtimeId,
      containerPort: port,
      hostPort,
      label: typeof args.label === "string" ? args.label.slice(0, 80) : null,
      baseUrl,
      url: new URL(path ? `./${path}` : "", baseUrl).toString(),
      directUrl: new URL(path ? `./${path}` : "", directUrl).toString(),
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
      gatekeeperReviewId: event.gatekeeper?.reviewId || null,
    });
    if (event.status === "ok") {
      return { ok: true, status: "ok", decision: event.decision, result: event.result };
    }
    return {
      ok: false,
      status: event.status,
      decision: event.decision,
      error: event.error,
      ...(event.gatekeeper ? { gatekeeper: event.gatekeeper } : {}),
      ...(event.approval
        ? {
            approvalId: event.approval.approvalId,
            approval: publicApproval(event.approval),
          }
        : {}),
    };
  }
}

function publicGatekeeperReview(review) {
  if (!review?.decision) return null;
  return {
    reviewId: review.reviewId,
    decision: {
      outcome: review.decision.outcome,
      scope: review.decision.scope || "once",
      riskLevel: review.decision.riskLevel || "high",
      userAuthorization: review.decision.userAuthorization || "unknown",
      agentMessage: review.decision.agentMessage || "Gatekeeper review completed.",
      userPrompt: review.decision.userPrompt || null,
    },
  };
}

function publicApproval(approval) {
  return {
    approvalId: approval.approvalId,
    status: approval.status,
    action: approval.action,
    prompt: approval.prompt,
    risk: approval.risk,
    gatekeeperReviewId: approval.gatekeeperReviewId || null,
  };
}
