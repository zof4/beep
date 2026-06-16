import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { ROOT_DIR } from "../src/config.mjs";
import { collectGatekeeperContext } from "../src/gatekeeper/context.mjs";
import { normalizeGatekeeperDecision } from "../src/gatekeeper/decision-schema.mjs";
import { Gatekeeper } from "../src/gatekeeper/index.mjs";
import { StateStore } from "../src/state-store.mjs";
import { ToolBroker } from "../src/tool-broker.mjs";
import { TOOL_MANIFEST } from "../src/tool-manifest.mjs";
import { createRuntimeHealthProof } from "../../runtime/src/runtime-api-auth.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-gatekeeper-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function staticSiteWorkspaceFixture() {
  const workspaceRoot = join(ROOT_DIR, ".beep-dev/workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const hostPath = mkdtempSync(join(workspaceRoot, "gatekeeper-update-"));
  writeFileSync(join(hostPath, "index.html"), "<!doctype html><title>Preview</title>\n");
  const workspaceRelativePath = relative(workspaceRoot, hostPath).split(sep).join("/");
  return {
    sourcePath: `/workspace/${workspaceRelativePath}`,
    cleanup: () => rmSync(hostPath, { recursive: true, force: true }),
  };
}

function staticSiteDefinition() {
  return TOOL_MANIFEST.find((tool) => tool.action === "preview.container.createStaticSite");
}

function staticSiteUpdateDefinition() {
  return TOOL_MANIFEST.find((tool) => tool.action === "preview.container.updateStaticSite");
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

function installRuntimeFetchMock(
  t,
  { store = null, onFetch = null, proveHealth = true, eventsPayload = { events: [] } } = {},
) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    onFetch?.(url, options);
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname === "/health") {
      const challenge = requestUrl.searchParams.get("challenge");
      const runtimeApiToken =
        proveHealth && store && challenge ? store.ensureRuntimeApiToken() : null;
      return {
        ok: true,
        json: async () => ({
          ok: true,
          service: "beep-agentd",
          runtimeId: "local",
          ...(runtimeApiToken
            ? {
                managedProof: createRuntimeHealthProof({
                  challenge,
                  runtimeApiToken,
                }),
              }
            : {}),
        }),
      };
    }
    if (requestUrl.pathname === "/agent/requests") {
      return { ok: true, json: async () => ({ requests: [] }) };
    }
    if (requestUrl.pathname === "/agent/events") {
      return { ok: true, json: async () => eventsPayload };
    }
    if (requestUrl.pathname === "/agent/summary") {
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

test("gatekeeper allows a bounded static preview update when recent context authorizes it", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Update the managed static site demo-site from /workspace/api-sessions/agent_beep/site and keep the same live URL.",
        text:
          "Update the managed static site demo-site from /workspace/api-sessions/agent_beep/site and keep the same live URL.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_allow",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "allow");
    assert.equal(review.decision.scope, "once");
    assert.equal(review.decision.userAuthorization, "medium");
  } finally {
    cleanup();
  }
});

test("gatekeeper collects default evidence for a bounded static preview update", async () => {
  const { sourcePath, cleanup: cleanupSite } = staticSiteWorkspaceFixture();
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: `Redeploy the managed static preview demo-site from ${sourcePath} and keep the live URL.`,
        text: `Redeploy the managed static preview demo-site from ${sourcePath} and keep the live URL.`,
      }),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_default_evidence",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "allow");
    assert.equal(review.evidence.kind, "static_site");
    assert.equal(review.evidence.ok, true);
    assert.equal(review.evidence.sourcePath, sourcePath);
    assert.equal(review.evidence.hasIndexHtml, true);
  } finally {
    cleanupSite();
    cleanup();
  }
});

test("gatekeeper does not treat an ambiguous path update as static preview update authorization", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Update /workspace/api-sessions/agent_beep/site.",
        text: "Update /workspace/api-sessions/agent_beep/site.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_ambiguous",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.notEqual(review.decision.userAuthorization, "medium");
    assert.match(review.decision.userPrompt, /update|redeploy/iu);
    assert.match(review.decision.userPrompt, /demo-site/iu);
    assert.doesNotMatch(review.decision.userPrompt, /creating/iu);
  } finally {
    cleanup();
  }
});

test("gatekeeper does not treat an html path name as static preview create authorization", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Create /workspace/site-html.",
        text: "Create /workspace/site-html.",
      }),
      collectEvidence: () => validStaticSiteEvidence({ sourcePath: "/workspace/site-html" }),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_create_html_path",
      action: "preview.container.createStaticSite",
      args: { siteName: "site-html", sourcePath: "/workspace/site-html" },
      definition: staticSiteDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.notEqual(review.decision.userAuthorization, "medium");
  } finally {
    cleanup();
  }
});

test("gatekeeper does not treat a website path name as static preview update authorization", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText: "Update /workspace/website.",
        text: "Update /workspace/website.",
      }),
      collectEvidence: () => validStaticSiteEvidence({ sourcePath: "/workspace/website" }),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_website_path",
      action: "preview.container.updateStaticSite",
      args: { siteId: "website-site", sourcePath: "/workspace/website" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "escalate_to_user");
    assert.notEqual(review.decision.userAuthorization, "medium");
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

test("gatekeeper treats explicit static preview update denial as a hard deny", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "Do not update the managed static site demo-site from /workspace/api-sessions/agent_beep/site.",
        text:
          "Do not update the managed static site demo-site from /workspace/api-sessions/agent_beep/site.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_deny",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "deny");
    assert.equal(review.decision.userAuthorization, "unknown");
    assert.match(review.decision.auditRationale, /explicitly denied/iu);
    assert.match(review.decision.auditRationale, /update|redeploy/iu);
    assert.match(review.decision.auditRationale, /demo-site/iu);
    assert.doesNotMatch(review.decision.auditRationale, /creating/iu);
  } finally {
    cleanup();
  }
});

test("gatekeeper ignores unrelated update denial before valid static preview update authorization", async () => {
  const { store, cleanup } = tempStore();
  try {
    const gatekeeper = new Gatekeeper({
      store,
      mode: "auto_review",
      collectContext: async () => ({
        ok: true,
        errors: [],
        authorizationText:
          "No need to update dependencies. Update the managed static site demo-site from /workspace/api-sessions/agent_beep/site and keep the same live URL.",
        text:
          "No need to update dependencies. Update the managed static site demo-site from /workspace/api-sessions/agent_beep/site and keep the same live URL.",
      }),
      collectEvidence: () => validStaticSiteEvidence(),
    });

    const review = await gatekeeper.review({
      runtimeId: "local",
      toolCallId: "call_update_unrelated_denial",
      action: "preview.container.updateStaticSite",
      args: { siteId: "demo-site", sourcePath: "/workspace/api-sessions/agent_beep/site" },
      definition: staticSiteUpdateDefinition(),
      classification: { risk: "high", reason: "Tool is configured for review." },
    });

    assert.equal(review.decision.outcome, "allow");
    assert.equal(review.decision.userAuthorization, "medium");
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
  const { store, cleanup } = tempStore();
  installRuntimeFetchMock(t, { store });
  try {
    store.createAgentRequest({
      runtimeId: "local",
      toolCallId: "call_stale",
      input: [{ type: "text", text: "Create a static preview container for /workspace/stale-site." }],
      inputSummary: {
        partCount: 1,
        textPartCount: 1,
        imagePartCount: 0,
        localImagePartCount: 0,
        totalInlineImageBytes: 0,
        textPreview: "Create a static preview container for /workspace/stale-site.",
        imageParts: [],
      },
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

test("gatekeeper context includes native control-plane authorization scoped to the current tool call", async (t) => {
  const { store, cleanup } = tempStore();
  installRuntimeFetchMock(t, { store });
  try {
    store.createAgentRequest({
      runtimeId: "local",
      toolCallId: "call_current",
      input: [
        {
          type: "text",
          text: "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        },
        { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
      ],
      inputSummary: {
        partCount: 2,
        textPartCount: 1,
        imagePartCount: 1,
        localImagePartCount: 0,
        totalInlineImageBytes: 4,
        textPreview:
          "Create a static site and request a managed static preview container for /workspace/api-sessions/agent_beep/site.",
        imageParts: [{ index: 1, source: "inline", mimeType: "image/png", byteLength: 4, detail: "high" }],
      },
    });

    const context = await collectGatekeeperContext({
      store,
      runtimeId: "local",
      toolCallId: "call_current",
    });

    assert.match(context.authorizationText, /api-sessions\/agent_beep\/site/iu);
    assert.match(context.text, /CONTROL-PLANE USER REQUESTS/u);
    assert.doesNotMatch(context.authorizationText, /ZmFrZQ==/u);
    assert.doesNotMatch(context.text, /ZmFrZQ==/u);
  } finally {
    cleanup();
  }
});

test("gatekeeper context falls back to safe native text parts when input summary is absent", async (t) => {
  const { store, cleanup } = tempStore();
  installRuntimeFetchMock(t, { store });
  try {
    store.createAgentRequest({
      runtimeId: "local",
      toolCallId: "call_current",
      input: [
        {
          type: "text",
          text: "Deploy the managed static site demo-site from /workspace/api-sessions/agent_beep/site.",
        },
        { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "low" },
      ],
    });

    const context = await collectGatekeeperContext({
      store,
      runtimeId: "local",
      toolCallId: "call_current",
    });

    assert.match(context.authorizationText, /Deploy the managed static site demo-site/iu);
    assert.match(context.authorizationText, /api-sessions\/agent_beep\/site/iu);
    assert.doesNotMatch(context.text, /ZmFrZQ==/u);
  } finally {
    cleanup();
  }
});

test("gatekeeper context prefers full native text parts over truncated summary preview", async (t) => {
  const { store, cleanup } = tempStore();
  installRuntimeFetchMock(t, { store });
  try {
    const prefix = "Create a rich visual dashboard. ".repeat(14);
    const fullText = `${prefix}Request a managed static preview container for /workspace/api-sessions/agent_beep/site.`;
    assert.equal(fullText.slice(0, 240).includes("/workspace/api-sessions/agent_beep/site"), false);

    store.createAgentRequest({
      runtimeId: "local",
      toolCallId: "call_current",
      input: [
        { type: "text", text: fullText },
        { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "low" },
      ],
      inputSummary: {
        partCount: 2,
        textPartCount: 1,
        imagePartCount: 1,
        localImagePartCount: 0,
        totalInlineImageBytes: 4,
        textPreview: fullText.slice(0, 240),
        imageParts: [{ index: 1, source: "inline", mimeType: "image/png", byteLength: 4, detail: "low" }],
      },
    });

    const context = await collectGatekeeperContext({
      store,
      runtimeId: "local",
      toolCallId: "call_current",
    });

    assert.match(context.authorizationText, /api-sessions\/agent_beep\/site/iu);
    assert.doesNotMatch(context.text, /ZmFrZQ==/u);
  } finally {
    cleanup();
  }
});

test("gatekeeper context redacts inline image data from runtime events", async (t) => {
  const { store, cleanup } = tempStore();
  installRuntimeFetchMock(t, {
    store,
    eventsPayload: {
      events: [
        {
          type: "request.created",
          status: "queued",
          message: {
            role: "user",
            content: [
              { type: "input_text", text: "Create a static preview." },
              { type: "input_image", mimeType: "image/png", data: "ZmFrZQ==" },
            ],
          },
        },
      ],
    },
  });
  try {
    const context = await collectGatekeeperContext({
      store,
      runtimeId: "local",
      toolCallId: "call_current",
    });

    assert.match(context.text, /RECENT AGENT EVENTS/u);
    assert.match(context.text, /Create a static preview/iu);
    assert.match(context.text, /queued/iu);
    assert.doesNotMatch(context.text, /ZmFrZQ==/u);
  } finally {
    cleanup();
  }
});

test("gatekeeper context proves managed runtime before sending runtime API token", async (t) => {
  const { store, cleanup } = tempStore();
  try {
    const token = store.ensureRuntimeApiToken();
    const seen = [];
    installRuntimeFetchMock(t, {
      store,
      onFetch(url, options) {
        seen.push({ url: String(url), authorization: options.headers?.authorization });
      },
    });

    await collectGatekeeperContext({ store, runtimeId: "local", toolCallId: "call_auth" });

    const paths = seen.map((request) => new URL(request.url).pathname);
    const firstTokenIndex = seen.findIndex((request) => request.authorization === `Bearer ${token}`);
    assert.notEqual(firstTokenIndex, -1, "verified runtime context requests should include the runtime API token");
    assert.equal(
      seen.slice(0, firstTokenIndex).some((request) => new URL(request.url).pathname === "/health"),
      true,
      "runtime health proof must be checked before any token-bearing runtime request",
    );
    assert.deepEqual(
      paths.filter((path) => path.startsWith("/agent")),
      ["/agent/requests", "/agent/events", "/agent/summary"],
    );
  } finally {
    cleanup();
  }
});

test("gatekeeper context does not send runtime API token when managed health proof is missing", async (t) => {
  const { store, cleanup } = tempStore();
  try {
    const token = store.ensureRuntimeApiToken();
    const seen = [];
    installRuntimeFetchMock(t, {
      store,
      proveHealth: false,
      onFetch(url, options) {
        seen.push({ url: String(url), authorization: options.headers?.authorization });
      },
    });

    const context = await collectGatekeeperContext({ store, runtimeId: "local", toolCallId: "call_auth" });

    assert.equal(
      seen.some((request) => new URL(request.url).pathname === "/health"),
      true,
      "gatekeeper context should attempt managed-runtime proof",
    );
    assert.equal(
      seen.some(
        (request) =>
          new URL(request.url).pathname.startsWith("/agent") && request.authorization === `Bearer ${token}`,
      ),
      false,
      "runtime API token must not be sent to an unproven listener",
    );
    assert.match(context.errors.join("\n"), /managed runtime identity/iu);
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
