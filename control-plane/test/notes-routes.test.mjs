import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempHandler({
  proxyToRuntime = async () => ({ ok: true, finalText: "{}" }),
  notesImageConverter = undefined,
  notesWorkspaceHostPath = undefined,
} = {}) {
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
    notesImageConverter,
    notesWorkspaceHostPath,
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

function rawRequest(method, url, body, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.write(body);
    req.end();
  });
  return req;
}

function multipartBody({ boundary, fields = {}, file }) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName || "image"}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8",
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );
  return Buffer.concat(chunks);
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

async function callRaw(handler, method, url, body, headers) {
  const captured = captureResponse();
  await handler(rawRequest(method, url, body, headers), captured.response);
  return captured.json();
}

function runtimePromptFromSubmitBody(body) {
  const { input } = JSON.parse(body);
  assert.ok(Array.isArray(input), "runtime submit body should contain native input parts");
  return input.find((part) => part?.type === "text")?.text || "";
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

test("ask-beep route does not leak locked item body through replay output", async () => {
  const { handler, auth, cleanup } = tempHandler();
  const secret = "SECRET-BEEP-NOTES-LOCKED-BODY-9361";
  try {
    const created = await call(
      handler,
      "POST",
      "/api/notes/items",
      { type: "note", title: "Private note", body: secret },
      auth,
    );
    const itemId = created.payload.item.id;
    await call(handler, "POST", `/api/notes/items/${itemId}/lock`, {}, auth);

    const asked = await call(handler, "POST", `/api/notes/items/${itemId}/ask-beep`, { reviewPolicy: "autopilot" }, auth);

    assert.equal(asked.statusCode, 200);
    assert.equal(asked.payload.run.status, "completed");
    assert.equal(JSON.stringify(asked.payload).includes(secret), false);
    assert.match(asked.payload.comments[0].body, /locked|private|hidden/i);
    assert.match(asked.payload.proposals[0].body, /locked|private|hidden/i);
  } finally {
    cleanup();
  }
});

test("ask-beep route localAgent parses nested runtime finalText", async () => {
  const runtimeCalls = [];
  const { handler, auth, cleanup } = tempHandler({
    proxyToRuntime: async (path, options) => {
      runtimeCalls.push({ path, options });
      const message = runtimePromptFromSubmitBody(options.body);
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
    const submitted = JSON.parse(runtimeCalls[0].options.body);
    assert.equal(Object.hasOwn(submitted, "message"), false);
    assert.equal(submitted.waitForCompletion, true);
    assert.equal(asked.payload.run.status, "completed");
    assert.equal(asked.payload.comments[0].body, "Nested runtime comment.");
    assert.equal(asked.payload.proposals[0].title, "Nested runtime todo");
  } finally {
    cleanup();
  }
});

test("item read route returns item-derived artifacts from ask-beep materialization", async () => {
  const { handler, auth, cleanup } = tempHandler({
    proxyToRuntime: async (path, options) => {
      const message = runtimePromptFromSubmitBody(options.body);
      const stageOutput = message.includes("agentCommentary")
        ? {
            comments: [{ targetId: "item_derived", body: "Derived artifact comment.", sourceItemIds: ["item_derived"] }],
          }
        : message.includes("draftExtraction")
          ? {
              proposals: [
                { kind: "todo", title: "Derived artifact todo", body: "Use the derivation.", sourceItemIds: ["item_derived"] },
              ],
            }
          : message.includes("readContext")
            ? {
                derivedArtifacts: [{ kind: "readableRendition", body: "Item-derived readable text." }],
              }
            : {};
      return { ok: true, finalText: JSON.stringify(stageOutput) };
    },
  });
  try {
    const created = await call(
      handler,
      "POST",
      "/api/notes/items",
      { id: "item_derived", type: "note", title: "Inbox", body: "Call Sam" },
      auth,
    );
    const asked = await call(
      handler,
      "POST",
      `/api/notes/items/${created.payload.item.id}/ask-beep`,
      { beepMode: "localAgent", reviewPolicy: "autopilot" },
      auth,
    );
    const read = await call(handler, "GET", `/api/notes/items/${created.payload.item.id}`, null, auth);

    assert.equal(asked.statusCode, 200);
    assert.equal(asked.payload.derivedArtifacts.length, 1);
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.payload.item.derivedArtifactIds, [asked.payload.derivedArtifacts[0].id]);
    assert.equal(read.payload.derivedArtifacts[0].body, "Item-derived readable text.");
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
    const asked = await call(
      handler,
      "POST",
      `/api/notes/items/${created.payload.item.id}/ask-beep`,
      { reviewPolicy: "autopilot" },
      auth,
    );
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
    const asked = await call(
      handler,
      "POST",
      `/api/notes/items/${created.payload.item.id}/ask-beep`,
      { reviewPolicy: "autopilot" },
      auth,
    );
    const proposalId = asked.payload.proposals[0].id;
    const accepted = await call(handler, "POST", `/api/notes/proposals/${proposalId}/accept`, {}, auth);

    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.payload.item.type, "todo");
  } finally {
    cleanup();
  }
});

test("proposal accept route maps non-promotable proposal kinds to client errors", async () => {
  const { handler, auth, cleanup } = tempHandler({
    proxyToRuntime: async (path, options) => {
      const message = runtimePromptFromSubmitBody(options.body);
      const stageOutput = message.includes("draftExtraction")
        ? {
            proposals: [{ kind: "comment", title: "Comment only", body: "Do not promote.", sourceItemIds: ["item_comment"] }],
          }
        : {};
      return { ok: true, finalText: JSON.stringify(stageOutput) };
    },
  });
  try {
    const created = await call(
      handler,
      "POST",
      "/api/notes/items",
      { id: "item_comment", type: "note", title: "Inbox", body: "Call Sam" },
      auth,
    );
    const asked = await call(
      handler,
      "POST",
      `/api/notes/items/${created.payload.item.id}/ask-beep`,
      { beepMode: "localAgent", reviewPolicy: "autopilot" },
      auth,
    );
    const accepted = await call(handler, "POST", `/api/notes/proposals/${asked.payload.proposals[0].id}/accept`, {}, auth);

    assert.equal(accepted.statusCode, 400);
    assert.match(accepted.payload.error, /proposal kind cannot be promoted: comment/);
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

test("capture route accepts multipart image over 1 MiB and writes a workspace file without dataUrl metadata", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const imageBytes = Buffer.alloc(1024 * 1024 + 17, 0x61);
  const { handler, auth, cleanup } = tempHandler({ notesWorkspaceHostPath: workspaceDir });
  try {
    const boundary = "beep-notes-large-image";
    const body = multipartBody({
      boundary,
      fields: { kind: "image", body: "Large whiteboard capture", detail: "auto" },
      file: { filename: "whiteboard.png", mimeType: "image/png", data: imageBytes },
    });
    const source = await callRaw(handler, "POST", "/api/notes/captures", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });

    assert.equal(source.statusCode, 200);
    const file = source.payload.source.media.files[0];
    assert.equal(file.name, "whiteboard.png");
    assert.equal(file.mimeType, "image/png");
    assert.equal(file.sizeBytes, imageBytes.byteLength);
    assert.equal(file.detail, "auto");
    assert.match(file.workspacePath, /^notes-captures\/.+\.png$/u);
    assert.equal(Object.hasOwn(file, "dataUrl"), false);
    assert.deepEqual(readFileSync(join(workspaceDir, file.workspacePath)), imageBytes);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("capture processing route localAgent forwards image capture as localImage input", async () => {
  const runtimeBodies = [];
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const imageBytes = Buffer.from("fake-image");
  const { handler, auth, cleanup } = tempHandler({
    notesWorkspaceHostPath: workspaceDir,
    proxyToRuntime: async (path, options) => {
      assert.equal(path, "/agent/submit");
      const body = JSON.parse(options.body);
      runtimeBodies.push(body);
      const message = body.input.find((part) => part?.type === "text")?.text || "";
      const stageOutput = message.includes("readableRendition")
        ? {
            derivedArtifacts: [
              { kind: "readableRendition", body: "Photo shows a whiteboard note.", sourceArtifactIds: ["src_image"] },
            ],
          }
        : {};
      return { ok: true, finalText: JSON.stringify(stageOutput) };
    },
  });
  try {
    const boundary = "beep-notes-local-image";
    const body = multipartBody({
      boundary,
      fields: { id: "src_image", kind: "image", body: "Whiteboard capture", detail: "auto" },
      file: { filename: "whiteboard.png", mimeType: "image/png", data: imageBytes },
    });
    const source = await callRaw(handler, "POST", "/api/notes/captures", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });
    const processed = await call(
      handler,
      "POST",
      `/api/notes/captures/${source.payload.source.id}/process`,
      { beepMode: "localAgent", reviewPolicy: "autopilot" },
      auth,
    );

    assert.equal(source.statusCode, 200);
    assert.equal(source.payload.source.media.files[0].mimeType, "image/png");
    assert.equal(processed.statusCode, 200);
    assert.equal(runtimeBodies.length > 0, true);
    assert.equal(runtimeBodies.every((body) => Object.hasOwn(body, "message") === false), true);
    assert.equal(runtimeBodies.every((body) => body.input.some((part) => part?.type === "localImage")), true);
    assert.equal(runtimeBodies.every((body) => body.input.some((part) => part?.type === "image")), false);
    assert.deepEqual(runtimeBodies[0].input.find((part) => part?.type === "localImage"), {
      type: "localImage",
      path: source.payload.source.media.files[0].workspacePath,
      detail: "auto",
    });
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("capture processing route converts HEIF multipart capture to JPEG workspace localImage", async () => {
  const runtimeBodies = [];
  const converterCalls = [];
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const heifData = Buffer.from("fake-heif");
  const jpegData = Buffer.from("converted-jpeg");
  const { handler, auth, cleanup } = tempHandler({
    notesWorkspaceHostPath: workspaceDir,
    notesImageConverter: async (input) => {
      converterCalls.push(input);
      return { mimeType: "image/jpeg", data: jpegData };
    },
    proxyToRuntime: async (path, options) => {
      assert.equal(path, "/agent/submit");
      const body = JSON.parse(options.body);
      runtimeBodies.push(body);
      const message = body.input.find((part) => part?.type === "text")?.text || "";
      const stageOutput = message.includes("readableRendition")
        ? {
            derivedArtifacts: [
              { kind: "readableRendition", body: "Converted iPhone photo.", sourceArtifactIds: ["src_heif"] },
            ],
          }
        : {};
      return { ok: true, finalText: JSON.stringify(stageOutput) };
    },
  });
  try {
    const boundary = "beep-notes-heif-image";
    const body = multipartBody({
      boundary,
      fields: { id: "src_heif", kind: "image", body: "iPhone photo", detail: "auto" },
      file: { filename: "IMG_0001.HEIC", mimeType: "image/heic", data: heifData },
    });
    const source = await callRaw(handler, "POST", "/api/notes/captures", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });
    const processed = await call(
      handler,
      "POST",
      `/api/notes/captures/${source.payload.source.id}/process`,
      { beepMode: "localAgent", reviewPolicy: "autopilot" },
      auth,
    );

    assert.equal(source.statusCode, 200);
    assert.equal(converterCalls.length, 1);
    assert.deepEqual(
      {
        mimeType: converterCalls[0].mimeType,
        data: converterCalls[0].data,
        name: converterCalls[0].name,
        detail: converterCalls[0].detail,
      },
      { mimeType: "image/heic", data: heifData, name: "IMG_0001.HEIC", detail: "auto" },
    );
    assert.equal(Buffer.isBuffer(converterCalls[0].data), true);
    assert.equal(source.payload.source.media.files[0].mimeType, "image/jpeg");
    assert.equal(source.payload.source.media.files[0].originalMimeType, "image/heic");
    assert.equal(source.payload.source.media.files[0].originalName, "IMG_0001.HEIC");
    assert.equal(source.payload.source.media.files[0].originalSizeBytes, heifData.byteLength);
    assert.equal(Object.hasOwn(source.payload.source.media.files[0], "dataUrl"), false);
    assert.deepEqual(readFileSync(join(workspaceDir, source.payload.source.media.files[0].workspacePath)), jpegData);
    assert.equal(processed.statusCode, 200);
    assert.equal(runtimeBodies.length > 0, true);
    assert.deepEqual(runtimeBodies[0].input.find((part) => part?.type === "localImage"), {
      type: "localImage",
      path: source.payload.source.media.files[0].workspacePath,
      detail: "auto",
    });
    assert.equal(runtimeBodies[0].input.some((part) => part?.type === "image"), false);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("capture route rejects unsupported image media", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const { handler, auth, cleanup } = tempHandler({ notesWorkspaceHostPath: workspaceDir });
  try {
    const boundary = "beep-notes-bad-image";
    const body = multipartBody({
      boundary,
      fields: { kind: "image", body: "bad" },
      file: { filename: "bad.gif", mimeType: "image/gif", data: Buffer.from("GIF89a") },
    });
    const rejected = await callRaw(handler, "POST", "/api/notes/captures", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });

    assert.equal(rejected.statusCode, 415);
    assert.match(rejected.payload.error, /unsupported image MIME type: image\/gif/u);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
