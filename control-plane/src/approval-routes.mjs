import { readJsonBody, sendJson, sendNotFound, statusFromError } from "./http-utils.mjs";

export async function handleApprovalRoute({
  request,
  response,
  pathname,
  url,
  store,
  toolBroker,
  requireOperatorAuth,
}) {
  requireOperatorAuth(request);
  const parts = pathname.split("/").filter(Boolean);
  const approvalId = parts[2] || null;
  const action = parts[3] || null;

  if (request.method === "GET" && parts.length === 2) {
    const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1000);
    const status = url.searchParams.get("status") || null;
    sendJson(response, 200, { ok: true, approvals: store.listApprovals({ status, limit }) });
    return;
  }

  if (!approvalId) {
    sendNotFound(response);
    return;
  }

  const approval = store.getApproval(approvalId);
  if (!approval) {
    sendJson(response, 404, { ok: false, error: `Unknown approvalId: ${approvalId}` });
    return;
  }

  if (request.method === "GET" && parts.length === 3) {
    sendJson(response, 200, { ok: true, approval });
    return;
  }

  if (request.method === "POST" && action === "deny") {
    const body = await readJsonBody(request);
    const transition = store.transitionApproval(approvalId, "pending", {
      status: "denied",
      decision: "deny",
      decidedAt: new Date().toISOString(),
      reason: body.reason || approval.reason || null,
    });
    if (!transition.ok) {
      sendJson(response, transition.reason === "not_found" ? 404 : 409, {
        ok: false,
        error:
          transition.reason === "not_found"
            ? `Unknown approvalId: ${approvalId}`
            : `Approval is ${transition.approval.status}, not pending.`,
        approval: transition.approval,
      });
      return;
    }
    sendJson(response, 200, { ok: true, approval: transition.approval });
    return;
  }

  if (request.method === "POST" && action === "cancel") {
    const transition = store.transitionApproval(approvalId, "pending", {
      status: "canceled",
      decision: "cancel",
      decidedAt: new Date().toISOString(),
    });
    if (!transition.ok) {
      sendJson(response, transition.reason === "not_found" ? 404 : 409, {
        ok: false,
        error:
          transition.reason === "not_found"
            ? `Unknown approvalId: ${approvalId}`
            : `Approval is ${transition.approval.status}, not pending.`,
        approval: transition.approval,
      });
      return;
    }
    sendJson(response, 200, { ok: true, approval: transition.approval });
    return;
  }

  if (request.method === "POST" && action === "approve") {
    const transition = store.transitionApproval(approvalId, "pending", {
      status: "executing",
      decision: "approve",
      decidedAt: new Date().toISOString(),
    });
    if (!transition.ok) {
      sendJson(response, transition.reason === "not_found" ? 404 : 409, {
        ok: false,
        error:
          transition.reason === "not_found"
            ? `Unknown approvalId: ${approvalId}`
            : `Approval is ${transition.approval.status}, not pending.`,
        approval: transition.approval,
      });
      return;
    }
    const executing = transition.approval;
    try {
      const result = await toolBroker.executeApprovedApproval(executing);
      const updated = store.transitionApproval(approvalId, "executing", {
        status: "approved",
        result,
        executedAt: new Date().toISOString(),
      }).approval;
      sendJson(response, 200, { ok: true, approval: updated, result });
    } catch (error) {
      const updated = store.transitionApproval(approvalId, "executing", {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      }).approval;
      sendJson(response, statusFromError(error), {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        approval: updated,
      });
    }
    return;
  }

  sendNotFound(response);
}
