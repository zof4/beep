import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { handleApprovalRoute } from "../src/approval-routes.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-approval-auth-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function requestWithAuth(method, authorization, body = null) {
  const request = new PassThrough();
  request.method = method;
  request.headers = authorization ? { authorization } : {};
  process.nextTick(() => {
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
  return request;
}

function captureResponse() {
  let statusCode = 0;
  let body = "";
  return {
    response: {
      writeHead(status) {
        statusCode = status;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    json() {
      return { statusCode, payload: body ? JSON.parse(body) : null };
    },
  };
}

test("runtime token cannot list operator approval records", async () => {
  const { store, cleanup } = tempStore();
  try {
    const runtimeToken = store.ensureRuntimeToken();
    const operatorToken = store.ensureOperatorToken();
    assert.notEqual(runtimeToken, operatorToken);

    const request = requestWithAuth("GET", `Bearer ${runtimeToken}`);
    const response = captureResponse();
    await assert.rejects(
      handleApprovalRoute({
        request,
        response: response.response,
        pathname: "/api/approvals",
        url: new URL("http://127.0.0.1/api/approvals"),
        store,
        toolBroker: {},
        requireOperatorAuth(req) {
          if (req.headers.authorization !== `Bearer ${operatorToken}`) {
            const error = new Error("operator token is invalid");
            error.status = 401;
            throw error;
          }
        },
      }),
      /operator token is invalid/u,
    );
  } finally {
    cleanup();
  }
});

test("operator token can list pending approval records", async () => {
  const { store, cleanup } = tempStore();
  try {
    const operatorToken = store.ensureOperatorToken();
    const approval = store.createApproval({
      runtimeId: "local",
      toolCallId: "call_auth",
      action: "preview.container.createStaticSite",
      args: { sourcePath: "/workspace/site" },
      risk: "high",
      prompt: "Approve preview?",
      reason: "test",
    });

    const request = requestWithAuth("GET", `Bearer ${operatorToken}`);
    const response = captureResponse();
    await handleApprovalRoute({
      request,
      response: response.response,
      pathname: "/api/approvals",
      url: new URL("http://127.0.0.1/api/approvals"),
      store,
      toolBroker: {},
      requireOperatorAuth(req) {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) {
          const error = new Error("operator token is invalid");
          error.status = 401;
          throw error;
        }
      },
    });

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.approvals[0].approvalId, approval.approvalId);
  } finally {
    cleanup();
  }
});

test("operator token can deny a pending approval record", async () => {
  const { store, cleanup } = tempStore();
  try {
    const operatorToken = store.ensureOperatorToken();
    const approval = store.createApproval({
      runtimeId: "local",
      toolCallId: "call_deny",
      action: "preview.container.createStaticSite",
      args: { sourcePath: "/workspace/site" },
      risk: "high",
      prompt: "Approve preview?",
      reason: "needs review",
    });

    const request = requestWithAuth("POST", `Bearer ${operatorToken}`, { reason: "operator denied" });
    const response = captureResponse();
    await handleApprovalRoute({
      request,
      response: response.response,
      pathname: `/api/approvals/${approval.approvalId}/deny`,
      url: new URL(`http://127.0.0.1/api/approvals/${approval.approvalId}/deny`),
      store,
      toolBroker: {},
      requireOperatorAuth(req) {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) throw new Error("operator token is invalid");
      },
    });

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.approval.status, "denied");
    assert.equal(payload.approval.decision, "deny");
    assert.equal(payload.approval.reason, "operator denied");
  } finally {
    cleanup();
  }
});

test("operator token can cancel a pending approval record", async () => {
  const { store, cleanup } = tempStore();
  try {
    const operatorToken = store.ensureOperatorToken();
    const approval = store.createApproval({
      runtimeId: "local",
      toolCallId: "call_cancel",
      action: "preview.container.createStaticSite",
      args: { sourcePath: "/workspace/site" },
      risk: "high",
      prompt: "Approve preview?",
      reason: "needs review",
    });

    const request = requestWithAuth("POST", `Bearer ${operatorToken}`);
    const response = captureResponse();
    await handleApprovalRoute({
      request,
      response: response.response,
      pathname: `/api/approvals/${approval.approvalId}/cancel`,
      url: new URL(`http://127.0.0.1/api/approvals/${approval.approvalId}/cancel`),
      store,
      toolBroker: {},
      requireOperatorAuth(req) {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) throw new Error("operator token is invalid");
      },
    });

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.approval.status, "canceled");
    assert.equal(payload.approval.decision, "cancel");
  } finally {
    cleanup();
  }
});

test("operator token approves a pending approval through broker execution", async () => {
  const { store, cleanup } = tempStore();
  try {
    const operatorToken = store.ensureOperatorToken();
    const approval = store.createApproval({
      runtimeId: "local",
      toolCallId: "call_approve",
      action: "preview.container.createStaticSite",
      args: { sourcePath: "/workspace/site" },
      risk: "high",
      prompt: "Approve preview?",
      reason: "needs review",
    });
    const executions = [];

    const request = requestWithAuth("POST", `Bearer ${operatorToken}`);
    const response = captureResponse();
    await handleApprovalRoute({
      request,
      response: response.response,
      pathname: `/api/approvals/${approval.approvalId}/approve`,
      url: new URL(`http://127.0.0.1/api/approvals/${approval.approvalId}/approve`),
      store,
      toolBroker: {
        async executeApprovedApproval(executing) {
          executions.push(executing);
          assert.equal(executing.status, "executing");
          assert.equal(executing.decision, "approve");
          return { siteId: "site_1" };
        },
      },
      requireOperatorAuth(req) {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) throw new Error("operator token is invalid");
      },
    });

    const { statusCode, payload } = response.json();
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.approval.status, "approved");
    assert.deepEqual(payload.result, { siteId: "site_1" });
    assert.equal(executions.length, 1);
  } finally {
    cleanup();
  }
});
