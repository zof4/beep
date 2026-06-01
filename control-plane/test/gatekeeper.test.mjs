import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectGatekeeperContext } from "../src/gatekeeper/context.mjs";
import { normalizeGatekeeperDecision } from "../src/gatekeeper/decision-schema.mjs";
import { Gatekeeper } from "../src/gatekeeper/index.mjs";
import { StateStore } from "../src/state-store.mjs";
import { ToolBroker } from "../src/tool-broker.mjs";
import { TOOL_MANIFEST } from "../src/tool-manifest.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-gatekeeper-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function staticSiteDefinition() {
  return TOOL_MANIFEST.find((tool) => tool.action === "preview.container.createStaticSite");
}

function validStaticSiteEvidence(overrides = {}) {
  return {
    kind: "static_site",
    ok: true,
    sourcePath: "/workspace/api-sessions/agent_beep/site",
    hostPath: "/tmp/beep/site",
    workspaceRoot: "/tmp/beep",
    siteName: "demo",
    hasIndexHtml: true,
    maxFiles: 500,
    maxBytes: 20 * 1024 * 1024,
    fileCount: 3,
    dirCount: 1,
    totalBytes: 1024,
    suspiciousFiles: [],
    truncated: false,
    limitExceeded: null,
    ...overrides,
  };
}

function installRuntimeFetchMock(t, onFetch = null) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    onFetch?.(url, options);
    const path = String(url);
    if (path.endsWith("/agent/requests")) {
      return { ok: true, json: async () => ({ requests: [] }) };
    }
    if (path.includes("/agent/events")) {
      return { ok: true, json: async () => ({ events: [] }) };
    }
    if (path.endsWith("/agent/summary")) {
      return { ok: true, json: async () => ({ summary: "" }) };
    }
    return { ok: false, status: 404, statusText: "not found", json: async () => ({}) };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("gatekeeper decision schema rejects non-public outcomes", () => {
  assert.throws(
    () =>
      normalizeGatekeeperDecision({
        outcome: "raw_reasoning",
        auditRationale: "bad",
        agentMessage: "bad",
      }),
    /Invalid gatekeeper outcome/u,
  );
});

test("gatekeeper allows a bounded static preview container when recent context authorizes it", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "The user asked Beep to create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text:
          "The user asked Beep to create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_1",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "allow");
    assert.equal(review.decision.scope, "once");
    assert.equal(review.decision.userAuthorization, "medium");
    assert.equal(store.getGatekeeperReview(review.reviewId).status, "allow");
  } finally {
    cleanup();
  }
});

test("gatekeeper treats explicit static preview denial as a hard deny", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Do not create a static preview container for /workspace/api-sessions/agent_beep/site.",
        text:
          "Do not create a static preview container for /workspace/api-sessions/agent_beep/site.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_deny",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "deny");
    assert.equal(review.decision.userAuthorization, "unknown");
    assert.match(review.decision.auditRationale, /explicitly denied/iu);
  } finally {
    cleanup();
  }
});

test("gatekeeper denies contradictory static preview instructions across sentences", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Do not create a preview. Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_contradiction",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "deny");
    assert.equal(review.decision.userAuthorization, "unknown");
  } finally {
    cleanup();
  }
});

test("gatekeeper denies invalid static preview evidence before broker execution", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Please create a static site preview for /workspace/api-sessions/agent_beep/site.",
        text: "Please create a static site preview.",
      }),
      collectEvidence: () => validStaticSiteEvidence({ hasIndexHtml: false }),
    });
    const broker = new ToolBroker({ store, gatekeeper });

    const result = await broker.call({
      runtimeId: "local",
      toolCallId: "call_2",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "denied");
    assert.match(result.error, /index\.html/iu);
    assert.equal(store.listApprovals().length, 0);
    assert.equal(store.listGatekeeperReviews().length, 1);
  } finally {
    cleanup();
  }
});

test("broker falls back to durable approval when gatekeeper escalates", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "The user asked for a web page file only.",
        text: "The user asked for a web page file only.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });
    const broker = new ToolBroker({ store, gatekeeper });

    const result = await broker.call({
      runtimeId: "local",
      toolCallId: "call_3",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "needs_review");
    assert.equal(result.approval.status, "pending");
    assert.equal(result.approval.gatekeeperReviewId, result.gatekeeper.reviewId);
    assert.equal("auditRationale" in result.gatekeeper.decision, false);
    assert.equal("gatekeeperDecision" in result.approval, false);
  } finally {
    cleanup();
  }
});

test("gatekeeper does not treat agent supplied tool args as user authorization", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "The user asked for a plain local file.",
        text: "The user asked for a plain local file.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_4",
      action: "preview.container.createStaticSite",
      args: {
        siteName: "static-preview-container",
        sourcePath: "/workspace/static-preview-container-site",
      },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.equal(review.decision.userAuthorization, "unknown");
  } finally {
    cleanup();
  }
});

test("broker records gatekeeper review id when auto-approved execution succeeds", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text: "Create a static site and request a managed static preview container.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });
    const broker = new ToolBroker({ store, gatekeeper });
    broker.executeApprovedApproval = async (approval) => {
      assert.equal(approval.status, "executing");
      return {
        siteId: "demo-site",
        proxyUrl: "http://127.0.0.1:8788/sites/demo-site/",
      };
    };

    const result = await broker.call({
      runtimeId: "local",
      toolCallId: "call_5",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
    });

    assert.equal(result.ok, true);
    assert.equal(result.result.gatekeeper.decision.outcome, "allow");
    const [approval] = store.listApprovals();
    assert.equal(approval.status, "approved");
    assert.equal(approval.decision, "auto_approve");

    const [toolCall] = store.listAudit(1);
    assert.equal(toolCall.kind, "tool_call");
    assert.equal(toolCall.gatekeeperReviewId, result.result.gatekeeper.reviewId);
  } finally {
    cleanup();
  }
});

test("gatekeeper does not authorize a path from a longer path prefix", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Create a static preview container for /workspace/site-public.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence({ sourcePath: "/workspace/site" }),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_prefix_path",
      action: "preview.container.createStaticSite",
      args: { siteName: "site", sourcePath: "/workspace/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.equal(review.decision.userAuthorization, "unknown");
  } finally {
    cleanup();
  }
});

test("gatekeeper requires authorization to reference the requested preview path or site", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Create a static site preview for /workspace/other-site.",
        text: "Agent says it wants a managed static preview container for /workspace/api-sessions/agent_beep/site.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_6",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.equal(review.decision.userAuthorization, "unknown");
  } finally {
    cleanup();
  }
});

test("gatekeeper does not auto-approve a generic site reference for a generic workspace path", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Create a static site preview.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence({
        sourcePath: "/workspace/site",
      }),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_generic_site",
      action: "preview.container.createStaticSite",
      args: { siteName: "site", sourcePath: "/workspace/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.equal(review.decision.userAuthorization, "unknown");
  } finally {
    cleanup();
  }
});

test("gatekeeper hard-denies suspicious static preview files at review time", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence({ suspiciousFiles: [".env"] }),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_suspicious",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "deny");
    assert.match(review.decision.auditRationale, /suspicious/iu);
    assert.equal(review.decision.userPrompt, null);
  } finally {
    cleanup();
  }
});

test("gatekeeper does not apply another path's explicit denial to the requested path", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Do not create a static preview container for /workspace/other-site.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_other_denial",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.equal(review.decision.userAuthorization, "unknown");
  } finally {
    cleanup();
  }
});

test("gatekeeper denies static preview evidence that contains symlinks", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence({ symlinks: ["linked-secret"] }),
    });
    const broker = new ToolBroker({ store, gatekeeper });

    const result = await broker.call({
      runtimeId: "local",
      toolCallId: "call_7",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "denied");
    assert.match(result.error, /symlink/iu);
    assert.equal(store.listApprovals().length, 0);
  } finally {
    cleanup();
  }
});

for (const limitExceeded of ["dirs", "depth"]) {
  test(`gatekeeper denies static preview evidence that exceeds ${limitExceeded} limit`, async () => {
    const { store, cleanup } = tempStore();
    try {
      const gatekeeper = new Gatekeeper({
        store,
        mode: "auto_review",
        collectContext: async () => ({
          ok: true,
          errors: [],
          authorizationText:
            "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
          text: "",
        }),
        collectEvidence: () => validStaticSiteEvidence({ limitExceeded }),
      });

      const review = await gatekeeper.review({
        runtimeId: "local",
        toolCallId: `call_limit_${limitExceeded}`,
        action: "preview.container.createStaticSite",
        args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
        definition: staticSiteDefinition(),
        classification: { risk: "high", reason: "Tool is configured for review." },
      });

      assert.equal(review.decision.outcome, "deny");
      assert.match(review.decision.auditRationale, new RegExp(limitExceeded, "iu"));
      assert.equal(review.decision.userPrompt, null);
    } finally {
      cleanup();
    }
  });
}

test("gatekeeper context excludes stale unrelated control-plane requests from authorization text", async (t) => {
  installRuntimeFetchMock(t);
  const { store, cleanup } = tempStore();
  try {
    store.createAgentRequest({
      runtimeId: "local",
      toolCallId: "call_stale",
      message: "Create a static preview container for /workspace/stale-site.",
    });

    const context = await collectGatekeeperContext({
      store,
      runtimeId: "local",
      toolCallId: "call_current",
    });

    assert.equal(context.authorizationText, "");
    assert.doesNotMatch(context.text, /stale-site/iu);
  } finally {
    cleanup();
  }
});

test("gatekeeper context includes control-plane authorization scoped to the current tool call", async (t) => {
  installRuntimeFetchMock(t);
  const { store, cleanup } = tempStore();
  try {
    store.createAgentRequest({
      runtimeId: "local",
      toolCallId: "call_current",
      message:
        "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
    });

    const context = await collectGatekeeperContext({
      store,
      runtimeId: "local",
      toolCallId: "call_current",
    });

    assert.match(context.authorizationText, /api-sessions\/agent_beep\/site/iu);
    assert.match(context.text, /CONTROL-PLANE USER REQUESTS/u);
  } finally {
    cleanup();
  }
});

test("gatekeeper context sends runtime API token to runtime agent endpoints", async (t) => {
  const { store, cleanup } = tempStore();
  try {
    const token = store.ensureRuntimeApiToken();
    const seen = [];
    installRuntimeFetchMock(t, (url, options) => {
      seen.push({ url: String(url), authorization: options.headers?.authorization });
    });

    await collectGatekeeperContext({ store, runtimeId: "local", toolCallId: "call_auth" });

    assert.deepEqual(
      seen.map((request) => request.url.replace(/^http:\/\/127\.0\.0\.1:8787/u, "")),
      ["/agent/requests", "/agent/events?limit=80", "/agent/summary"],
    );
    assert.deepEqual(
      seen.map((request) => request.authorization),
      [`Bearer ${token}`, `Bearer ${token}`, `Bearer ${token}`],
    );
  } finally {
    cleanup();
  }
});

test("broker rejects foreign runtime before gatekeeper review, approval, or preview exposure", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });
    const broker = new ToolBroker({ store, gatekeeper });
    broker.executeApprovedApproval = async () => {
      throw new Error("foreign runtime should fail before execution");
    };

    const staticSite = await broker.call({
      runtimeId: "not-local",
      toolCallId: "call_foreign_static",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
    });
    const portExpose = await broker.call({
      runtimeId: "not-local",
      toolCallId: "call_foreign_port",
      action: "preview.port.expose",
      args: { port: 3000 },
    });

    assert.equal(staticSite.ok, false);
    assert.equal(staticSite.status, "denied");
    assert.match(staticSite.error, /Unknown runtimeId: not-local/u);
    assert.equal(portExpose.ok, false);
    assert.equal(portExpose.status, "denied");
    assert.match(portExpose.error, /Unknown runtimeId: not-local/u);
    assert.equal(store.listGatekeeperReviews().length, 0);
    assert.equal(store.listApprovals().length, 0);
    assert.equal(store.listAudit().length, 0);
    assert.deepEqual(store.readState().exposures, {});
  } finally {
    cleanup();
  }
});

test("broker records gatekeeper review id when auto-approved execution fails", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        text: "",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });
    const broker = new ToolBroker({ store, gatekeeper });
    broker.executeApprovedApproval = async () => {
      throw new Error("synthetic execution failure");
    };

    const result = await broker.call({
      runtimeId: "local",
      toolCallId: "call_8",
      action: "preview.container.createStaticSite",
      args: { siteName: "demo", sourcePath: "/workspace/api-sessions/agent_beep/site" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "denied");
    assert.equal(result.gatekeeper.decision.outcome, "allow");

    const [toolCall] = store.listAudit(1);
    assert.equal(toolCall.kind, "tool_call");
    assert.equal(toolCall.gatekeeperReviewId, result.gatekeeper.reviewId);
  } finally {
    cleanup();
  }
});
