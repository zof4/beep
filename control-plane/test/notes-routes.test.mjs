import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempHandler({ proxyToRuntime = async () => ({ ok: true, finalText: "{}" }) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "beep-notes-routes-test-"));
  const store = new StateStore(dir);
  const operatorToken = store.ensureOperatorToken();
  const handler = createControlPlaneHandler({
    store,
    runtimeManager: {
      status: async () => ({ runtimeId: "local", running: false }),
      ensureRuntime: async () => ({ runtimeId: "local", running: true }),
      proxyToRuntime,
    },
    toolBroker: { manifest: () => ({ tools: [] }), call: async () => ({ ok: false }) },
    localPortProxy: async () => {
      throw new Error("local port proxy should not be called");
    },
  });
  return {
    handler,
    auth: { authorization: `Bearer ${operatorToken}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(method, url, body = null, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  return req;
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

async function call(handler, method, url, body, headers) {
  const captured = captureResponse();
  await handler(request(method, url, body, { "content-type": "application/json", ...headers }), captured.response);
  return captured.json();
}

test("notes workspace route requires operator auth", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/api/notes/workspace", null, {});
    assert.equal(result.statusCode, 401);
  } finally {
    cleanup();
  }
});

test("notes routes create items and list workspace projection", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const workspace = await call(handler, "GET", "/api/notes/workspace", null, auth);

    assert.equal(created.statusCode, 200);
    assert.equal(created.payload.item.type, "note");
    assert.equal(workspace.payload.workspace.itemOrder.length, 1);
  } finally {
    cleanup();
  }
});

test("ask-beep route attaches replay comments and proposals", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const itemId = created.payload.item.id;
    const asked = await call(handler, "POST", `/api/notes/items/${itemId}/ask-beep`, { reviewPolicy: "autopilot" }, auth);

    assert.equal(asked.statusCode, 200);
    assert.equal(asked.payload.run.status, "completed");
    assert.equal(asked.payload.comments.length >= 1, true);
    assert.equal(asked.payload.proposals.length >= 1, true);
  } finally {
    cleanup();
  }
});

test("ask-beep route localAgent parses nested runtime finalText", async () => {
  const runtimeCalls = [];
  const { handler, auth, cleanup } = tempHandler({
    proxyToRuntime: async (path, options) => {
      runtimeCalls.push({ path, options });
      const { message } = JSON.parse(options.body);
      const stageOutput = message.includes("agentCommentary")
        ? {
            comments: [{ targetId: "item_local", body: "Nested runtime comment.", sourceItemIds: ["item_local"] }],
          }
        : message.includes("draftExtraction")
          ? {
              proposals: [
                { kind: "todo", title: "Nested runtime todo", body: "From local agent.", sourceItemIds: ["item_local"] },
              ],
            }
          : {};
      return { ok: true, request: { finalText: JSON.stringify(stageOutput) } };
    },
  });
  try {
    const created = await call(
      handler,
      "POST",
      "/api/notes/items",
      { id: "item_local", type: "note", title: "Inbox", body: "Call Sam" },
      auth,
    );
    const asked = await call(
      handler,
      "POST",
      `/api/notes/items/${created.payload.item.id}/ask-beep`,
      { beepMode: "localAgent", reviewPolicy: "autopilot" },
      auth,
    );

    assert.equal(asked.statusCode, 200);
    assert.equal(runtimeCalls.every((callRecord) => callRecord.path === "/agent/submit"), true);
    assert.equal(asked.payload.run.status, "completed");
    assert.equal(asked.payload.comments[0].body, "Nested runtime comment.");
    assert.equal(asked.payload.proposals[0].title, "Nested runtime todo");
  } finally {
    cleanup();
  }
});

test("item read route returns attached comments and proposals", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const itemId = created.payload.item.id;
    await call(handler, "POST", `/api/notes/items/${itemId}/ask-beep`, { reviewPolicy: "autopilot" }, auth);
    const read = await call(handler, "GET", `/api/notes/items/${itemId}`, null, auth);

    assert.equal(read.statusCode, 200);
    assert.equal(read.payload.item.id, itemId);
    assert.equal(read.payload.comments.length, 1);
    assert.equal(read.payload.comments[0].targetId, itemId);
    assert.equal(read.payload.proposals.length, 1);
    assert.equal(read.payload.proposals[0].sourceItemIds[0], itemId);
  } finally {
    cleanup();
  }
});

test("notes routes translate unknown item actions to 404", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const locked = await call(handler, "POST", "/api/notes/items/missing_item/lock", {}, auth);
    const unlocked = await call(handler, "POST", "/api/notes/items/missing_item/unlock", {}, auth);

    assert.equal(locked.statusCode, 404);
    assert.match(locked.payload.error, /unknown item: missing_item/);
    assert.equal(unlocked.statusCode, 404);
    assert.match(unlocked.payload.error, /unknown item: missing_item/);
  } finally {
    cleanup();
  }
});

test("notes routes translate unknown proposal actions to 404", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const accepted = await call(handler, "POST", "/api/notes/proposals/missing_proposal/accept", {}, auth);
    const rejected = await call(handler, "POST", "/api/notes/proposals/missing_proposal/reject", {}, auth);

    assert.equal(accepted.statusCode, 404);
    assert.match(accepted.payload.error, /unknown proposal: missing_proposal/);
    assert.equal(rejected.statusCode, 404);
    assert.match(rejected.payload.error, /unknown proposal: missing_proposal/);
  } finally {
    cleanup();
  }
});

test("notes routes translate non-pending proposal actions to 409", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const asked = await call(handler, "POST", `/api/notes/items/${created.payload.item.id}/ask-beep`, {}, auth);
    const proposalId = asked.payload.proposals[0].id;
    await call(handler, "POST", `/api/notes/proposals/${proposalId}/accept`, {}, auth);
    const acceptedAgain = await call(handler, "POST", `/api/notes/proposals/${proposalId}/accept`, {}, auth);

    assert.equal(acceptedAgain.statusCode, 409);
    assert.match(acceptedAgain.payload.error, new RegExp(`proposal is not pending: ${proposalId}`));
  } finally {
    cleanup();
  }
});

test("notes routes translate invalid client input to 400", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const invalidItem = await call(handler, "POST", "/api/notes/items", { type: "note", body: "Call Sam" }, auth);
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const invalidPolicy = await call(
      handler,
      "POST",
      `/api/notes/items/${created.payload.item.id}/ask-beep`,
      { reviewPolicy: "neverReview" },
      auth,
    );

    assert.equal(invalidItem.statusCode, 400);
    assert.match(invalidItem.payload.error, /workspace item title is required/);
    assert.equal(invalidPolicy.statusCode, 400);
    assert.match(invalidPolicy.payload.error, /unsupported review policy: neverReview/);
  } finally {
    cleanup();
  }
});

test("proposal accept route promotes a todo", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const asked = await call(handler, "POST", `/api/notes/items/${created.payload.item.id}/ask-beep`, {}, auth);
    const proposalId = asked.payload.proposals[0].id;
    const accepted = await call(handler, "POST", `/api/notes/proposals/${proposalId}/accept`, {}, auth);

    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.payload.item.type, "todo");
  } finally {
    cleanup();
  }
});

test("capture processing route materializes derived artifacts", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const source = await call(handler, "POST", "/api/notes/captures", { kind: "text", body: "Call Sam" }, auth);
    const processed = await call(
      handler,
      "POST",
      `/api/notes/captures/${source.payload.source.id}/process`,
      { reviewPolicy: "autopilot" },
      auth,
    );

    assert.equal(processed.statusCode, 200);
    assert.equal(processed.payload.run.status, "completed");
    assert.equal(processed.payload.derivedArtifacts.length >= 1, true);
  } finally {
    cleanup();
  }
});
