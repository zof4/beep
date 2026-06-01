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
