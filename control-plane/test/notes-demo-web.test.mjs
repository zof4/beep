import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempHandler() {
  const dir = mkdtempSync(join(tmpdir(), "beep-notes-demo-web-test-"));
  const store = new StateStore(dir);
  const handler = createControlPlaneHandler({
    store,
    runtimeManager: {
      status: async () => ({ runtimeId: "local", running: false }),
      ensureRuntime: async () => ({ runtimeId: "local", running: true }),
      proxyToRuntime: async () => ({ ok: true, finalText: "{}" }),
    },
    toolBroker: { manifest: () => ({ tools: [] }), call: async () => ({ ok: false }) },
    localPortProxy: async () => {
      throw new Error("local port proxy should not be called");
    },
  });
  return {
    handler,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(method, url, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => req.end());
  return req;
}

function captureResponse() {
  let statusCode = 0;
  let headers = {};
  let body = "";
  return {
    response: {
      writeHead(status, nextHeaders = {}) {
        statusCode = status;
        headers = nextHeaders;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    result() {
      return { statusCode, headers, body };
    },
  };
}

async function call(handler, method, url) {
  const captured = captureResponse();
  await handler(request(method, url), captured.response);
  return captured.result();
}

test("/notes serves the product demo HTML without operator auth", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes");

    assert.equal(result.statusCode, 200);
    assert.match(result.headers["content-type"], /^text\/html; charset=utf-8$/u);
    assert.match(result.body, /Beep Notes/u);
    assert.match(result.body, /Ask Beep/u);
    assert.match(result.body, /Inspector/u);
    assert.match(result.body, /Review mode/u);
    assert.match(result.body, /stepReview/u);
    assert.match(result.body, /firstReadCheckpoint/u);
    assert.match(result.body, /autopilot/u);
    assert.match(result.body, /replay/u);
    assert.match(result.body, /localAgent/u);
    assert.match(result.body, /Original capture/u);
    assert.match(result.body, /Readable rendition/u);
    assert.match(result.body, /<label class="field-label" for="itemTitleInput">Title<\/label>/u);
    assert.match(result.body, /<label class="field-label" for="itemBodyInput">Body<\/label>/u);
    assert.match(result.body, /<label class="field-label" for="captureKindSelect">Capture type<\/label>/u);
    assert.match(result.body, /<label class="field-label" for="captureBodyInput">Capture text<\/label>/u);
    assert.match(result.body, /<label class="field-label" for="imageCaptureInput">Image file<\/label>/u);
    assert.match(result.body, /id="imagePreview"/u);
    assert.match(result.body, /accept="image\/png,image\/jpeg,image\/webp,image\/heic,image\/heif,.heic,.heif"/u);
    assert.match(result.body, /HEIC\/HEIF uploads convert to JPEG/u);
  } finally {
    cleanup();
  }
});

test("/notes/app.js serves demo JavaScript with core product controls", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes/app.js");

    assert.equal(result.statusCode, 200);
    assert.match(result.headers["content-type"], /^text\/javascript; charset=utf-8$/u);
    assert.match(result.body, /loadWorkspace/u);
    assert.match(result.body, /processCapture/u);
    assert.match(result.body, /toggleLock/u);
    assert.match(result.body, /acceptProposal/u);
    assert.match(result.body, /rejectProposal/u);
    assert.match(result.body, /askBeep/u);
    assert.match(result.body, /reviewPolicy/u);
    assert.match(result.body, /beepMode/u);
    assert.match(result.body, /captureKind/u);
    assert.match(result.body, /new FormData\(\)/u);
    assert.match(result.body, /URL\.createObjectURL\(file\)/u);
    assert.match(result.body, /URL\.revokeObjectURL/u);
    assert.match(result.body, /MAX_IMAGE_CAPTURE_BYTES = 40 \* 1024 \* 1024/u);
    assert.doesNotMatch(result.body, /FileReader/u);
    assert.doesNotMatch(result.body, /readAsDataURL/u);
    assert.match(result.body, /buildCapturePayload/u);
    assert.match(result.body, /renderSourceRecord/u);
    assert.match(result.body, /HEIF_CAPTURE_MIME_TYPES/u);
    assert.match(result.body, /captureMimeType/u);
    assert.doesNotMatch(result.body, /normalizeFileDataUrl/u);
    assert.doesNotMatch(result.body, /dataUrl/u);
    assert.match(result.body, /state\.selectedSourceId = item\.sourceArtifactIds\?\.\[0\] \|\| null/u);
    assert.match(result.body, /sourceIds\.includes\(state\.selectedSourceId\)/u);
    assert.match(result.body, /sortedRecords\(state\.workspace\?\.runs, state\.workspace\?\.runOrder\)\.slice\(0, 8\)/u);
    assert.match(result.body, /PROMOTABLE_PROPOSAL_KINDS/u);
    assert.match(result.body, /if \(isPromotableProposal\(proposal\)\) \{/u);
    assert.match(result.body, /actions\.append\(reject\)/u);
  } finally {
    cleanup();
  }
});

test("/notes/app.js includes compact agent-owned run summary rendering", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes/app.js");

    assert.equal(result.statusCode, 200);
    assert.match(result.body, /function runSummaryText/u);
    assert.match(result.body, /Agent run/u);
    assert.match(result.body, /calibration/u);
    assert.match(result.body, /tools/u);
  } finally {
    cleanup();
  }
});

test("/notes/app.js includes handwriting calibration UI without base64 image reads", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes/app.js");

    assert.equal(result.statusCode, 200);
    assert.match(result.body, /handwritingCalibrationForm/u);
    assert.match(result.body, /handwritingPromptSelect/u);
    assert.match(result.body, /selectHandwritingPrompt/u);
    assert.match(result.body, /split\(\/\\s\+\/u\)/u);
    assert.match(result.body, /handwritingReferenceText/u);
    assert.match(result.body, /useHandwritingCalibration/u);
    assert.match(result.body, /handwritingSampleOrder/u);
    assert.match(result.body, /uncertainSpans/u);
    assert.match(result.body, /new FormData\(\)/u);
    assert.doesNotMatch(result.body, /FileReader/u);
    assert.doesNotMatch(result.body, /readAsDataURL/u);
    assert.doesNotMatch(result.body, /dataUrl/u);
  } finally {
    cleanup();
  }
});

test("/notes serves handwriting calibration controls", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes");

    assert.equal(result.statusCode, 200);
    assert.match(result.body, /Handwriting calibration/u);
    assert.match(result.body, /id="handwritingPromptSelect"/u);
    assert.match(result.body, /Prompt length/u);
    assert.match(result.body, /id="handwritingPromptText"/u);
    assert.match(result.body, /id="handwritingCalibrationForm"/u);
    assert.match(result.body, /id="handwritingReferenceText"/u);
    assert.match(result.body, /id="handwritingImageInput"/u);
    assert.match(
      result.body,
      /id="handwritingImageInput"[^>]+accept="image\/png,image\/jpeg,image\/webp,image\/heic,image\/heif,\.png,\.jpg,\.jpeg,\.webp,\.heic,\.heif"/u,
    );
    assert.match(result.body, /id="useHandwritingCalibration"/u);
    assert.match(result.body, /id="useHandwritingCalibration" type="checkbox" checked/u);
    assert.match(result.body, /id="handwritingSamplesList"/u);
    assert.match(result.body, /id="handwritingUncertainty"/u);
    assert.match(result.body, /No handwriting uncertainty reported\./u);
  } finally {
    cleanup();
  }
});

test("/notes/styles.css serves demo CSS with sidebar layout", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes/styles.css");

    assert.equal(result.statusCode, 200);
    assert.match(result.headers["content-type"], /^text\/css; charset=utf-8$/u);
    assert.match(result.body, /sidebar/u);
    assert.match(result.body, /inspector/u);
    assert.match(result.body, /@media/u);
    assert.match(result.body, /\.row-body,\n\.row-meta,\n\.status-text \{\n  overflow-wrap: anywhere;\n\}/u);
  } finally {
    cleanup();
  }
});

test("unsupported methods for known demo assets are handled as method not allowed", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "POST", "/notes");

    assert.equal(result.statusCode, 405);
    assert.match(result.body, /method not allowed/u);
  } finally {
    cleanup();
  }
});

test("unknown notes demo asset paths fall through to the server not found response", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/notes/missing.js");

    assert.equal(result.statusCode, 404);
    assert.match(result.headers["content-type"], /^application\/json; charset=utf-8$/u);
    assert.deepEqual(JSON.parse(result.body), { ok: false, error: "not found" });
  } finally {
    cleanup();
  }
});
