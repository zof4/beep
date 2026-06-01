import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-state-store-test-"));
  const store = new StateStore(dir);
  return {
    dir,
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("state store records approval and audit entry in one locked mutation", () => {
  const { dir, store, cleanup } = tempStore();
  try {
    const approval = store.createApproval({
      runtimeId: "local",
      toolCallId: "call_state",
      action: "preview.container.createStaticSite",
      args: { sourcePath: "/workspace/site" },
      risk: "high",
      prompt: "Approve preview?",
      reason: "test",
    });

    const state = store.readState();
    assert.equal(state.approvals[approval.approvalId].approvalId, approval.approvalId);
    assert.equal(state.audit.at(-1).kind, "approval_created");
    assert.equal(state.audit.at(-1).approvalId, approval.approvalId);
    assert.equal(existsSync(join(dir, "state.lock")), false);
  } finally {
    cleanup();
  }
});

test("state store approval transitions compare current status under the lock", () => {
  const { store, cleanup } = tempStore();
  try {
    const approval = store.createApproval({
      runtimeId: "local",
      toolCallId: "call_transition",
      action: "preview.container.createStaticSite",
      args: { sourcePath: "/workspace/site" },
      risk: "high",
      prompt: "Approve preview?",
      reason: "test",
    });

    const first = store.transitionApproval(approval.approvalId, "pending", {
      status: "executing",
      decision: "approve",
    });
    const second = store.transitionApproval(approval.approvalId, "pending", {
      status: "executing",
      decision: "approve",
    });

    assert.equal(first.ok, true);
    assert.equal(first.approval.status, "executing");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "status_conflict");
    assert.equal(second.approval.status, "executing");
  } finally {
    cleanup();
  }
});

test("state store separates runtime, runtime API, model credential, and operator tokens", () => {
  const { store, cleanup } = tempStore();
  try {
    const runtimeToken = store.ensureRuntimeToken();
    const runtimeApiToken = store.ensureRuntimeApiToken();
    const modelCredentialToken = store.ensureModelCredentialToken();
    const operatorToken = store.ensureOperatorToken();

    assert.equal(new Set([runtimeToken, runtimeApiToken, modelCredentialToken, operatorToken]).size, 4);
    assert.equal(store.ensureRuntimeToken(), runtimeToken);
    assert.equal(store.ensureRuntimeApiToken(), runtimeApiToken);
    assert.equal(store.ensureModelCredentialToken(), modelCredentialToken);
    assert.equal(store.ensureOperatorToken(), operatorToken);
  } finally {
    cleanup();
  }
});
