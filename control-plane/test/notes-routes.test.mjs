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

function multipartFieldsBody({ boundary, fields = {} }) {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`,
        "utf8",
      ),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
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

function runtimeSubmitBody(body) {
  const submitBody = typeof body === "string" ? JSON.parse(body) : body;
  assert.ok(
    submitBody && typeof submitBody === "object" && !Array.isArray(submitBody),
    "runtime submit body should be an object",
  );
  return submitBody;
}

function runtimePromptFromSubmitBody(body) {
  const { input } = runtimeSubmitBody(body);
  assert.ok(Array.isArray(input), "runtime submit body should contain native input parts");
  return input.find((part) => part?.type === "text")?.text || "";
}

async function assertNoHandwritingSampleState(handler, auth) {
  const workspace = await call(handler, "GET", "/api/notes/workspace", null, auth);
  assert.equal(workspace.statusCode, 200);
  assert.deepEqual(workspace.payload.workspace.sourceArtifacts, {});
  assert.deepEqual(workspace.payload.workspace.sourceOrder, []);
  assert.deepEqual(workspace.payload.workspace.handwritingSamples, {});
  assert.deepEqual(workspace.payload.workspace.handwritingSampleOrder, []);
  assert.deepEqual(workspace.payload.workspace.handwritingProfiles.profile_default.activeSampleIds, []);
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
    const submitted = runtimeSubmitBody(runtimeCalls[0].options.body);
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

test("handwriting default prompt route returns calibration prompt", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/api/notes/handwriting/prompts/default", null, auth);

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.prompt.id, "hw_prompt_v2");
    assert.equal(result.payload.prompt.promptVersion, "v2");
    assert.match(result.payload.prompt.referenceText, /At the beginning of a quiet Monday meeting/u);
    assert.match(result.payload.prompt.referenceText, /invoice #6190/u);
    assert.equal(result.payload.prompt.coverage.ambiguousPairs.includes("m/n/u/w"), true);
  } finally {
    cleanup();
  }
});

test("handwriting profile route returns default profile with prompt and no samples", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/api/notes/handwriting/profile", null, auth);

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.profile.id, "profile_default");
    assert.equal(result.payload.prompt.id, "hw_prompt_v2");
    assert.deepEqual(
      result.payload.prompts.map((prompt) => prompt.id),
      ["hw_prompt_v2", "hw_prompt_v2_partial", "hw_prompt_v2_story"],
    );
    assert.match(result.payload.prompts[1].referenceText, /The quick brown fox jumps over the lazy dog/u);
    assert.match(result.payload.prompts[2].referenceText, /On a rainy Thursday evening/u);
    assert.deepEqual(result.payload.samples, []);
  } finally {
    cleanup();
  }
});

test("handwriting sample route accepts HEIC multipart upload and projects active sample", async () => {
  const converterCalls = [];
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const heicData = Buffer.from("fake-heic");
  const pngData = Buffer.from("converted-png");
  const { handler, auth, cleanup } = tempHandler({
    notesWorkspaceHostPath: workspaceDir,
    notesImageConverter: async (input) => {
      converterCalls.push(input);
      return { mimeType: "image/png", data: pngData };
    },
  });
  try {
    const boundary = "beep-notes-handwriting-sample";
    const referenceText = "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.";
    const body = multipartBody({
      boundary,
      fields: {
        profileId: "profile_default",
        promptId: "hw_prompt_v2",
        referenceText,
      },
      file: { filename: "sample.HEIC", mimeType: "image/heic", data: heicData },
    });
    const result = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(converterCalls.length, 1);
    assert.deepEqual(
      {
        mimeType: converterCalls[0].mimeType,
        data: converterCalls[0].data,
        name: converterCalls[0].name,
        detail: converterCalls[0].detail,
        targetFormat: converterCalls[0].targetFormat,
        targetMimeType: converterCalls[0].targetMimeType,
      },
      {
        mimeType: "image/heic",
        data: heicData,
        name: "sample.HEIC",
        detail: "original",
        targetFormat: "png",
        targetMimeType: "image/png",
      },
    );
    assert.equal(result.payload.sample.profileId, "profile_default");
    assert.equal(result.payload.sample.promptId, "hw_prompt_v2");
    assert.equal(result.payload.sample.image.mimeType, "image/png");
    assert.equal(result.payload.sample.image.originalMimeType, "image/heic");
    assert.match(result.payload.sample.image.workspacePath, /^notes-captures\/.+\.png$/u);
    assert.equal(result.payload.source.kind, "image");
    assert.equal(result.payload.profile.activeSampleIds.includes(result.payload.sample.id), true);
    assert.equal(result.payload.samples.length, 1);
    assert.equal(result.payload.samples[0].id, result.payload.sample.id);
    assert.deepEqual(readFileSync(join(workspaceDir, result.payload.sample.image.workspacePath)), pngData);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("handwriting sample toggle route deactivates a sample and updates profile projection", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const { handler, auth, cleanup } = tempHandler({ notesWorkspaceHostPath: workspaceDir });
  try {
    const boundary = "beep-notes-handwriting-toggle";
    const body = multipartBody({
      boundary,
      fields: {
        profileId: "profile_default",
        promptId: "hw_prompt_v2",
        referenceText: "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.",
      },
      file: { filename: "sample.png", mimeType: "image/png", data: Buffer.from("fake-png") },
    });
    const created = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });

    assert.equal(created.statusCode, 200);
    const toggled = await call(
      handler,
      "POST",
      `/api/notes/handwriting/samples/${created.payload.sample.id}/toggle`,
      { active: false },
      auth,
    );

    assert.equal(toggled.statusCode, 200);
    assert.equal(toggled.payload.ok, true);
    assert.equal(toggled.payload.sample.active, false);
    assert.deepEqual(toggled.payload.profile.activeSampleIds, []);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("handwriting sample toggle route maps unknown sample to 404", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const result = await call(
      handler,
      "POST",
      "/api/notes/handwriting/samples/hw_sample_missing/toggle",
      { active: false },
      auth,
    );

    assert.equal(result.statusCode, 404);
    assert.match(result.payload.error, /unknown handwriting sample: hw_sample_missing/u);
  } finally {
    cleanup();
  }
});

test("handwriting sample route rejects unknown profile or prompt without persisting sample state", async () => {
  const referenceText = "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.";
  const cases = [
    {
      name: "unknown profile",
      fields: { profileId: "profile_missing", promptId: "hw_prompt_v2", referenceText },
      expectedError: /unknown handwriting profile: profile_missing/u,
    },
    {
      name: "unknown prompt",
      fields: { profileId: "profile_default", promptId: "hw_prompt_missing", referenceText },
      expectedError: /unknown handwriting prompt: hw_prompt_missing/u,
    },
  ];

  for (const testCase of cases) {
    const converterCalls = [];
    const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
    const { handler, auth, cleanup } = tempHandler({
      notesWorkspaceHostPath: workspaceDir,
      notesImageConverter: async (input) => {
        converterCalls.push(input);
        return { mimeType: "image/png", data: Buffer.from("converted-png") };
      },
    });
    try {
      const boundary = `beep-notes-handwriting-${testCase.name.replace(/\s+/gu, "-")}`;
      const body = multipartBody({
        boundary,
        fields: testCase.fields,
        file: { filename: "sample.HEIC", mimeType: "image/heic", data: Buffer.from("fake-heic") },
      });
      const result = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
        ...auth,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.byteLength),
      });

      assert.equal(result.statusCode, 404, testCase.name);
      assert.match(result.payload.error, testCase.expectedError);
      assert.deepEqual(converterCalls, []);
      await assertNoHandwritingSampleState(handler, auth);
    } finally {
      cleanup();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
});

test("handwriting sample route rejects blank profile or prompt without persisting sample state", async () => {
  const referenceText = "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.";
  const cases = [
    {
      name: "blank profile",
      fields: { profileId: " ", promptId: "hw_prompt_v2", referenceText },
      expectedError: /handwriting profile id is required/u,
    },
    {
      name: "blank prompt",
      fields: { profileId: "profile_default", promptId: " ", referenceText },
      expectedError: /handwriting prompt id is required/u,
    },
  ];

  for (const testCase of cases) {
    const converterCalls = [];
    const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
    const { handler, auth, cleanup } = tempHandler({
      notesWorkspaceHostPath: workspaceDir,
      notesImageConverter: async (input) => {
        converterCalls.push(input);
        return { mimeType: "image/png", data: Buffer.from("converted-png") };
      },
    });
    try {
      const boundary = `beep-notes-handwriting-${testCase.name.replace(/\s+/gu, "-")}`;
      const body = multipartBody({
        boundary,
        fields: testCase.fields,
        file: { filename: "sample.HEIC", mimeType: "image/heic", data: Buffer.from("fake-heic") },
      });
      const result = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
        ...auth,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.byteLength),
      });

      assert.equal(result.statusCode, 400, testCase.name);
      assert.match(result.payload.error, testCase.expectedError);
      assert.deepEqual(converterCalls, []);
      await assertNoHandwritingSampleState(handler, auth);
    } finally {
      cleanup();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
});

test("handwriting sample route rejects non-multipart uploads as client errors", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const result = await call(
      handler,
      "POST",
      "/api/notes/handwriting/samples",
      { profileId: "profile_default", promptId: "hw_prompt_v2", referenceText: "Text" },
      auth,
    );

    assert.equal(result.statusCode, 400);
    assert.match(result.payload.error, /multipart\/form-data/u);
    await assertNoHandwritingSampleState(handler, auth);
  } finally {
    cleanup();
  }
});

test("handwriting sample route rejects multipart uploads without an image file", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const { handler, auth, cleanup } = tempHandler({ notesWorkspaceHostPath: workspaceDir });
  try {
    const boundary = "beep-notes-handwriting-missing-image";
    const body = multipartFieldsBody({
      boundary,
      fields: {
        profileId: "profile_default",
        promptId: "hw_prompt_v2",
        referenceText: "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.",
      },
    });
    const result = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });

    assert.equal(result.statusCode, 400);
    assert.match(result.payload.error, /handwriting sample multipart body must include one image file/u);
    await assertNoHandwritingSampleState(handler, auth);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("handwriting sample route rejects multipart uploads without referenceText", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const { handler, auth, cleanup } = tempHandler({ notesWorkspaceHostPath: workspaceDir });
  try {
    const boundary = "beep-notes-handwriting-missing-reference";
    const body = multipartBody({
      boundary,
      fields: { profileId: "profile_default", promptId: "hw_prompt_v2" },
      file: { filename: "sample.png", mimeType: "image/png", data: Buffer.from("fake-png") },
    });
    const result = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });

    assert.equal(result.statusCode, 400);
    assert.match(result.payload.error, /referenceText is required/u);
    await assertNoHandwritingSampleState(handler, auth);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("handwriting sample toggle route rejects non-boolean active values", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const { handler, auth, cleanup } = tempHandler({ notesWorkspaceHostPath: workspaceDir });
  try {
    const boundary = "beep-notes-handwriting-invalid-active";
    const body = multipartBody({
      boundary,
      fields: {
        profileId: "profile_default",
        promptId: "hw_prompt_v2",
        referenceText: "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.",
      },
      file: { filename: "sample.png", mimeType: "image/png", data: Buffer.from("fake-png") },
    });
    const created = await callRaw(handler, "POST", "/api/notes/handwriting/samples", body, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.byteLength),
    });
    const result = await call(
      handler,
      "POST",
      `/api/notes/handwriting/samples/${created.payload.sample.id}/toggle`,
      { active: "false" },
      auth,
    );
    const profile = await call(handler, "GET", "/api/notes/handwriting/profile", null, auth);

    assert.equal(created.statusCode, 200);
    assert.equal(result.statusCode, 400);
    assert.match(result.payload.error, /active must be a boolean/u);
    assert.deepEqual(profile.payload.profile.activeSampleIds, [created.payload.sample.id]);
  } finally {
    cleanup();
    rmSync(workspaceDir, { recursive: true, force: true });
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
      const body = runtimeSubmitBody(options.body);
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

test("capture processing route includes active handwriting calibration samples", async () => {
  const runtimeBodies = [];
  const converterCalls = [];
  const workspaceDir = mkdtempSync(join(tmpdir(), "beep-notes-workspace-test-"));
  const samplePng = Buffer.from("converted-sample-png");
  const captureJpeg = Buffer.from("converted-capture-jpeg");
  const { handler, auth, cleanup } = tempHandler({
    notesWorkspaceHostPath: workspaceDir,
    notesImageConverter: async (input) => {
      converterCalls.push(input);
      if (input.targetFormat === "png" || input.targetMimeType === "image/png") {
        return { mimeType: "image/png", data: samplePng };
      }
      return { mimeType: "image/jpeg", data: captureJpeg };
    },
    proxyToRuntime: async (path, options) => {
      assert.equal(path, "/agent/submit");
      const body = runtimeSubmitBody(options.body);
      runtimeBodies.push(body);
      return {
        ok: true,
        finalText: JSON.stringify({
          derivedArtifacts: [
            {
              kind: "readableRendition",
              body: "Current capture says call Sam after lunch.",
              sourceArtifactIds: ["src_handwriting_current"],
            },
          ],
        }),
      };
    },
  });
  try {
    const sampleBoundary = "beep-notes-handwriting-context-sample";
    const sampleBody = multipartBody({
      boundary: sampleBoundary,
      fields: {
        profileId: "profile_default",
        promptId: "hw_prompt_v2",
        referenceText: "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.",
      },
      file: { filename: "sample.HEIC", mimeType: "image/heic", data: Buffer.from("sample-heic") },
    });
    const sample = await callRaw(handler, "POST", "/api/notes/handwriting/samples", sampleBody, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${sampleBoundary}`,
      "content-length": String(sampleBody.byteLength),
    });

    const captureBoundary = "beep-notes-handwriting-context-capture";
    const captureBody = multipartBody({
      boundary: captureBoundary,
      fields: { id: "src_handwriting_current", kind: "image", body: "Whiteboard capture", detail: "auto" },
      file: { filename: "capture.HEIC", mimeType: "image/heic", data: Buffer.from("capture-heic") },
    });
    const source = await callRaw(handler, "POST", "/api/notes/captures", captureBody, {
      ...auth,
      "content-type": `multipart/form-data; boundary=${captureBoundary}`,
      "content-length": String(captureBody.byteLength),
    });
    const processed = await call(
      handler,
      "POST",
      `/api/notes/captures/${source.payload.source.id}/process`,
      { beepMode: "localAgent", reviewPolicy: "stepReview", useHandwritingCalibration: true },
      auth,
    );

    assert.equal(sample.statusCode, 200);
    assert.equal(source.statusCode, 200);
    assert.equal(processed.statusCode, 200);
    assert.equal(converterCalls.length, 2);
    assert.equal(sample.payload.sample.image.mimeType, "image/png");
    assert.equal(source.payload.source.media.files[0].mimeType, "image/jpeg");
    assert.equal(runtimeBodies.length, 1);
    const firstInput = runtimeBodies[0].input;
    assert.ok(Array.isArray(firstInput), "runtime input should be an array");
    const localImages = firstInput.filter((part) => part?.type === "localImage");
    assert.deepEqual(localImages, [
      { type: "localImage", path: sample.payload.sample.image.workspacePath, detail: "original" },
      { type: "localImage", path: source.payload.source.media.files[0].workspacePath, detail: "auto" },
    ]);
    const promptText = firstInput
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(promptText, /Calibration sample/u);
    assert.match(promptText, /Current capture to transcribe follows/u);
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
      const body = runtimeSubmitBody(options.body);
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
