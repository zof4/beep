import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(join(tmpdir(), "beep-state-store-test-"));
  const store = new StateStore(dir);
  return {
    dir,
    store,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
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
    assert.equal(fs.existsSync(join(dir, "state.lock")), false);
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

test("state store create methods ignore caller-supplied reserved fields", () => {
  const { store, cleanup } = tempStore();
  try {
    const agentRequest = store.createAgentRequest({
      requestId: "caller-request",
      runtimeId: "local",
      message: "hello",
      status: "approved",
      createdAt: "caller-created",
      updatedAt: "caller-updated",
    });
    const approval = store.createApproval({
      approvalId: "caller-approval",
      runtimeId: "local",
      toolCallId: "call_reserved",
      action: "preview.container.createStaticSite",
      status: "approved",
      createdAt: "caller-created",
      updatedAt: "caller-updated",
    });
    const review = store.createGatekeeperReview({
      reviewId: "caller-review",
      runtimeId: "local",
      toolCallId: "call_reserved",
      action: "preview.container.createStaticSite",
      status: "approved",
      createdAt: "caller-created",
      updatedAt: "caller-updated",
    });

    const state = store.readState();
    const requestAudit = state.audit.find((event) => event.kind === "agent_request_created");
    const approvalAudit = state.audit.find((event) => event.kind === "approval_created");
    const reviewAudit = state.audit.find((event) => event.kind === "gatekeeper_review_created");

    assert.match(agentRequest.requestId, /^cp_req_/);
    assert.equal(agentRequest.status, "submitted");
    assert.notEqual(agentRequest.createdAt, "caller-created");
    assert.notEqual(agentRequest.updatedAt, "caller-updated");
    assert.equal(state.agentRequests[agentRequest.requestId].requestId, agentRequest.requestId);
    assert.equal(state.agentRequests["caller-request"], undefined);
    assert.equal(requestAudit.requestId, agentRequest.requestId);
    assert.equal(requestAudit.status, "submitted");

    assert.match(approval.approvalId, /^appr_/);
    assert.equal(approval.status, "pending");
    assert.notEqual(approval.createdAt, "caller-created");
    assert.notEqual(approval.updatedAt, "caller-updated");
    assert.equal(state.approvals[approval.approvalId].approvalId, approval.approvalId);
    assert.equal(state.approvals["caller-approval"], undefined);
    assert.equal(approvalAudit.approvalId, approval.approvalId);
    assert.equal(approvalAudit.status, "pending");

    assert.match(review.reviewId, /^gk_/);
    assert.equal(review.status, "started");
    assert.notEqual(review.createdAt, "caller-created");
    assert.notEqual(review.updatedAt, "caller-updated");
    assert.equal(state.gatekeeperReviews[review.reviewId].reviewId, review.reviewId);
    assert.equal(state.gatekeeperReviews["caller-review"], undefined);
    assert.equal(reviewAudit.reviewId, review.reviewId);
    assert.equal(reviewAudit.status, "started");
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

test("state store creates first-time token files while holding the state lock", async () => {
  const { dir, cleanup } = tempStore();
  const tokenPath = join(dir, "runtime-token");
  const lockPath = join(dir, "state.lock");
  const originalWriteFileSync = fs.writeFileSync;

  try {
    fs.writeFileSync = function writeFileSyncWithTokenLockCheck(path, ...args) {
      if (path === tokenPath && !fs.existsSync(lockPath)) {
        throw new Error("token file was created without the state lock");
      }
      return originalWriteFileSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();

    const { StateStore: CheckedStateStore } = await import(`../src/state-store.mjs?token-lock=${Date.now()}`);
    const store = new CheckedStateStore(dir);

    assert.match(store.ensureRuntimeToken(), /^[A-Za-z0-9_-]+$/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("state store does not remove an existing fresh lock while waiting", async () => {
  const { dir, cleanup } = tempStore();
  const lockPath = join(dir, "state.lock");
  const freshLock = `${JSON.stringify({ pid: process.pid, acquiredAt: "fresh" })}\n`;
  const originalDateNow = Date.now;

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath, freshLock, { mode: 0o600 });
    let nowCalls = 0;
    Date.now = () => (nowCalls++ === 0 ? 0 : 40_001);

    const { StateStore: CheckedStateStore } = await import(`../src/state-store.mjs?fresh-lock=${originalDateNow()}`);
    const store = new CheckedStateStore(dir);

    assert.throws(
      () => {
        store.withLock(() => {
          throw new Error("acquired lock after removing fresh lock");
        });
      },
      /Timed out waiting for state lock/,
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), freshLock);
  } finally {
    Date.now = originalDateNow;
    cleanup();
  }
});

test("state store validates existing token files and tightens token permissions", () => {
  const { dir, store, cleanup } = tempStore();
  const validToken = "A".repeat(32);
  const validTokenPath = join(dir, "runtime-token");
  const invalidTokenPath = join(dir, "operator-token");

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(validTokenPath, `${validToken}\n`, { mode: 0o644 });
    fs.writeFileSync(invalidTokenPath, "not a valid token\n", { mode: 0o644 });

    assert.equal(store.ensureRuntimeToken(), validToken);
    assert.equal(fs.statSync(validTokenPath).mode & 0o777, 0o600);

    const replacement = store.ensureOperatorToken();
    assert.notEqual(replacement, "not a valid token");
    assert.match(replacement, /^[A-Za-z0-9_-]{32,}$/);
    assert.equal(fs.statSync(invalidTokenPath).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("state store replaces invalid regular token files through a temporary file", async () => {
  const { dir, cleanup } = tempStore();
  const tokenPath = join(dir, "operator-token");
  const originalWriteFileSync = fs.writeFileSync;

  try {
    fs.mkdirSync(dir, { recursive: true });
    originalWriteFileSync.call(fs, tokenPath, "not a valid token\n", { mode: 0o644 });
    fs.writeFileSync = function writeFileSyncWithoutDirectTokenReplace(path, ...args) {
      if (path === tokenPath) {
        throw new Error("direct token replacement");
      }
      return originalWriteFileSync.call(this, path, ...args);
    };
    syncBuiltinESMExports();

    const { StateStore: CheckedStateStore } = await import(`../src/state-store.mjs?token-replace=${Date.now()}`);
    const store = new CheckedStateStore(dir);
    const replacement = store.ensureOperatorToken();

    assert.match(replacement, /^[A-Za-z0-9_-]{32,}$/);
    assert.equal(fs.readFileSync(tokenPath, "utf8"), `${replacement}\n`);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    syncBuiltinESMExports();
    cleanup();
  }
});

test("state store rejects symlink token paths without touching the target", () => {
  const { dir, store, cleanup } = tempStore();
  const targetPath = join(dir, "token-target");
  const symlinkPath = join(dir, "operator-token");
  const originalTarget = "not a valid token\n";

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, originalTarget, { mode: 0o600 });
    fs.symlinkSync(targetPath, symlinkPath);

    assert.throws(() => store.ensureOperatorToken(), /refusing token path/);
    assert.equal(fs.readFileSync(targetPath, "utf8"), originalTarget);
    assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
  } finally {
    cleanup();
  }
});

test("state store fails closed and preserves malformed state JSON", () => {
  const { dir, store, cleanup } = tempStore();
  try {
    store.ensure();
    const statePath = join(dir, "state.json");
    fs.writeFileSync(statePath, "{not-json\n", { mode: 0o600 });

    assert.throws(() => store.readState(), /failed to read state JSON/);
    assert.throws(
      () => {
        store.update((state) => {
          state.audit.push({ kind: "should_not_write" });
        });
      },
      /failed to read state JSON/,
    );
    assert.equal(fs.readFileSync(statePath, "utf8"), "{not-json\n");
  } finally {
    cleanup();
  }
});

test("state store fails closed for malformed valid state shapes", () => {
  const cases = [
    { name: "top-level null", value: null },
    { name: "top-level array", value: [] },
    { name: "runtimes array", value: { runtimes: [], audit: [] } },
    { name: "exposures null", value: { exposures: null, audit: [] } },
    { name: "agentRequests string", value: { agentRequests: "bad", audit: [] } },
    { name: "approvals array", value: { approvals: [], audit: [] } },
    { name: "gatekeeperReviews array", value: { gatekeeperReviews: [], audit: [] } },
    { name: "sites array", value: { sites: [], audit: [] } },
    { name: "audit object", value: { audit: {} } },
  ];

  for (const { name, value } of cases) {
    const { dir, store, cleanup } = tempStore();
    try {
      const statePath = join(dir, "state.json");
      const originalState = `${JSON.stringify(value)}\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, originalState, { mode: 0o600 });

      assert.throws(() => store.readState(), /invalid state shape/, name);
      assert.throws(
        () => {
          store.update((state) => {
            state.audit.push({ kind: "should_not_write" });
          });
        },
        /invalid state shape/,
        name,
      );
      assert.equal(fs.readFileSync(statePath, "utf8"), originalState);
    } finally {
      cleanup();
    }
  }
});

test("state store fails closed for malformed nested map records", () => {
  const cases = [
    { name: "approval null", value: { approvals: { appr_bad: null }, audit: [] } },
    { name: "approval array", value: { approvals: { appr_bad: [] }, audit: [] } },
    { name: "agent request primitive", value: { agentRequests: { cp_req_bad: "bad" }, audit: [] } },
    {
      name: "approval id mismatch",
      value: { approvals: { appr_bad: { approvalId: "appr_other" } }, audit: [] },
    },
    {
      name: "agent request id mismatch",
      value: { agentRequests: { cp_req_bad: { requestId: "cp_req_other" } }, audit: [] },
    },
    {
      name: "gatekeeper review id mismatch",
      value: { gatekeeperReviews: { gk_bad: { reviewId: "gk_other" } }, audit: [] },
    },
    { name: "site id mismatch", value: { sites: { site_bad: { siteId: "site_other" } }, audit: [] } },
  ];

  for (const { name, value } of cases) {
    const { dir, store, cleanup } = tempStore();
    try {
      const statePath = join(dir, "state.json");
      const originalState = `${JSON.stringify(value)}\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, originalState, { mode: 0o600 });

      assert.throws(() => store.readState(), /invalid state shape/, name);
      assert.throws(
        () => {
          store.update((state) => {
            state.audit.push({ kind: "should_not_write" });
          });
        },
        /invalid state shape/,
        name,
      );
      assert.equal(fs.readFileSync(statePath, "utf8"), originalState);
    } finally {
      cleanup();
    }
  }
});

test("state store fails closed for malformed audit entries", () => {
  const cases = [
    { name: "audit null entry", value: { audit: [null] } },
    { name: "audit array entry", value: { audit: [[]] } },
    { name: "audit primitive entry", value: { audit: ["bad"] } },
  ];

  for (const { name, value } of cases) {
    const { dir, store, cleanup } = tempStore();
    try {
      const statePath = join(dir, "state.json");
      const originalState = `${JSON.stringify(value)}\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, originalState, { mode: 0o600 });

      assert.throws(() => store.readState(), /invalid state shape/, name);
      assert.throws(
        () => {
          store.update((state) => {
            state.audit.push({ kind: "should_not_write" });
          });
        },
        /invalid state shape/,
        name,
      );
      assert.equal(fs.readFileSync(statePath, "utf8"), originalState);
    } finally {
      cleanup();
    }
  }
});
