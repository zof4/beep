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
    if (approval.status !== "pending") {
      sendJson(response, 409, { ok: false, error: `Approval is ${approval.status}, not pending.` });
      return;
    }
    const body = await readJsonBody(request);
    const updated = store.updateApproval(approvalId, {
      status: "denied",
      decision: "deny",
      decidedAt: new Date().toISOString(),
      reason: body.reason || approval.reason || null,
    });
    sendJson(response, 200, { ok: true, approval: updated });
    return;
  }

  if (request.method === "POST" && action === "cancel") {
    if (approval.status !== "pending") {
      sendJson(response, 409, { ok: false, error: `Approval is ${approval.status}, not pending.` });
      return;
    }
    const updated = store.updateApproval(approvalId, {
      status: "canceled",
      decision: "cancel",
      decidedAt: new Date().toISOString(),
    });
    sendJson(response, 200, { ok: true, approval: updated });
    return;
  }

  if (request.method === "POST" && action === "approve") {
    if (approval.status !== "pending") {
      sendJson(response, 409, { ok: false, error: `Approval is ${approval.status}, not pending.` });
      return;
    }
    const executing = store.updateApproval(approvalId, {
      status: "executing",
      decision: "approve",
      decidedAt: new Date().toISOString(),
    });
    try {
      const result = await toolBroker.executeApprovedApproval(executing);
      const updated = store.updateApproval(approvalId, {
        status: "approved",
        result,
        executedAt: new Date().toISOString(),
      });
      sendJson(response, 200, { ok: true, approval: updated, result });
    } catch (error) {
      const updated = store.updateApproval(approvalId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        failedAt: new Date().toISOString(),
      });
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
