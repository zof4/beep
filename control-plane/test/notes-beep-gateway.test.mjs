import assert from "node:assert/strict";
import test from "node:test";
import { NotesBeepGateway, validateStageOutput } from "../src/notes/beep-gateway.mjs";

test("validateStageOutput accepts structured comments and proposals", () => {
  const output = validateStageOutput({
    comments: [{ targetId: "item_1", body: "Looks actionable.", sourceItemIds: ["item_1"] }],
    proposals: [{ kind: "todo", title: "Call Sam", body: "Ask about timing.", sourceItemIds: ["item_1"] }],
    derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam." }],
  });

  assert.equal(output.comments.length, 1);
  assert.equal(output.proposals.length, 1);
  assert.equal(output.derivedArtifacts.length, 1);
});

test("validateStageOutput rejects malformed proposal kind", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: [{ kind: "externalEmail", title: "Send mail", body: "", sourceItemIds: ["item_1"] }],
      }),
    /unsupported proposal kind/,
  );
});

test("validateStageOutput rejects string stage output", () => {
  assert.throws(() => validateStageOutput("oops"), /stage output must be an object/);
});

test("validateStageOutput rejects array stage output", () => {
  assert.throws(() => validateStageOutput([]), /stage output must be an object/);
});

test("validateStageOutput rejects null stage output", () => {
  assert.throws(() => validateStageOutput(null), /stage output must be an object/);
});

test("validateStageOutput rejects number stage output", () => {
  assert.throws(() => validateStageOutput(42), /stage output must be an object/);
});

test("validateStageOutput rejects top-level comments when not an array", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: { targetId: "item_1", body: "Looks actionable." },
      }),
    /comments must be an array/,
  );
});

test("validateStageOutput rejects top-level comments when null", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: null,
      }),
    /comments must be an array/,
  );
});

test("validateStageOutput rejects comment sourceItemIds when not an array", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: [{ targetId: "item_1", body: "Looks actionable.", sourceItemIds: "item_1" }],
      }),
    /comment sourceItemIds must be an array/,
  );
});

test("validateStageOutput rejects comment sourceItemIds when null", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: [{ targetId: "item_1", body: "Looks actionable.", sourceItemIds: null }],
      }),
    /comment sourceItemIds must be an array/,
  );
});

test("validateStageOutput rejects blank comment targetId", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: [{ targetId: "   ", body: "Looks actionable.", sourceItemIds: ["item_1"] }],
      }),
    /comment targetId is required/,
  );
});

test("validateStageOutput rejects null comment entries", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: [null],
      }),
    /comments\[0\] must be an object/,
  );
});

test("validateStageOutput rejects object comment body", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: [{ targetId: "item_1", body: {}, sourceItemIds: ["item_1"] }],
      }),
    /comment body must be text/,
  );
});

test("validateStageOutput rejects object source IDs", () => {
  assert.throws(
    () =>
      validateStageOutput({
        comments: [{ targetId: "item_1", body: "Looks actionable.", sourceItemIds: [{}] }],
      }),
    /comment sourceItemIds entries must be primitive ids/,
  );
});

test("validateStageOutput rejects null source IDs", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam.", sourceArtifactIds: [null] }],
      }),
    /derived artifact sourceArtifactIds entries must be primitive ids/,
  );
});

test("validateStageOutput rejects top-level proposals when not an array", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: { kind: "todo", title: "Call Sam", body: "" },
      }),
    /proposals must be an array/,
  );
});

test("validateStageOutput rejects top-level proposals when null", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: null,
      }),
    /proposals must be an array/,
  );
});

test("validateStageOutput rejects null proposal entries", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: [null],
      }),
    /proposals\[0\] must be an object/,
  );
});

test("validateStageOutput rejects object proposal title", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: [{ kind: "todo", title: {}, body: "", sourceItemIds: ["item_1"] }],
      }),
    /proposal title must be text/,
  );
});

test("validateStageOutput rejects proposal sourceArtifactIds when not an array", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: [{ kind: "todo", title: "Call Sam", body: "", sourceArtifactIds: { id: "artifact_1" } }],
      }),
    /proposal sourceArtifactIds must be an array/,
  );
});

test("validateStageOutput rejects proposal sourceArtifactIds when null", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: [{ kind: "todo", title: "Call Sam", body: "", sourceArtifactIds: null }],
      }),
    /proposal sourceArtifactIds must be an array/,
  );
});

test("validateStageOutput rejects top-level derivedArtifacts when not an array", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: { kind: "readableRendition", body: "Call Sam." },
      }),
    /derivedArtifacts must be an array/,
  );
});

test("validateStageOutput rejects top-level derivedArtifacts when null", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: null,
      }),
    /derivedArtifacts must be an array/,
  );
});

test("validateStageOutput rejects null derived artifact entries", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: [null],
      }),
    /derivedArtifacts\[0\] must be an object/,
  );
});

test("validateStageOutput rejects array derived artifact body", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: [{ kind: "readableRendition", body: ["bad"] }],
      }),
    /derived artifact body must be text/,
  );
});

test("validateStageOutput rejects derived artifact sourceArtifactIds when not an array", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam.", sourceArtifactIds: "artifact_1" }],
      }),
    /derived artifact sourceArtifactIds must be an array/,
  );
});

test("validateStageOutput rejects derived artifact sourceArtifactIds when null", () => {
  assert.throws(
    () =>
      validateStageOutput({
        derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam.", sourceArtifactIds: null }],
      }),
    /derived artifact sourceArtifactIds must be an array/,
  );
});

test("replay gateway returns stage-specific canned output", async () => {
  const gateway = new NotesBeepGateway({
    mode: "replay",
    replay: {
      agentCommentary: {
        comments: [{ targetId: "item_1", body: "This has a follow-up.", sourceItemIds: ["item_1"] }],
      },
    },
  });

  const output = await gateway.runStage("agentCommentary", { targetItemId: "item_1" });

  assert.equal(output.comments[0].body, "This has a follow-up.");
});

test("replay gateway rejects null canned output", async () => {
  const gateway = new NotesBeepGateway({
    mode: "replay",
    replay: {
      agentCommentary: null,
    },
  });

  await assert.rejects(
    () => gateway.runStage("agentCommentary", { targetItemId: "item_1" }),
    /stage output must be an object/,
  );
});

test("local agent gateway calls injected submitter with native input parts", async () => {
  const calls = [];
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async (payload) => {
      calls.push(payload);
      return {
        finalText: JSON.stringify({
          comments: [{ targetId: "item_1", body: "Agent comment.", sourceItemIds: ["item_1"] }],
        }),
      };
    },
  });

  const output = await gateway.runStage("agentCommentary", {
    targetItemId: "item_1",
    attachments: [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" }],
  });

  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], "message"), false);
  assert.equal(calls[0].input.length, 2);
  assert.equal(calls[0].input[0].type, "text");
  assert.match(calls[0].input[0].text, /Return exactly one JSON object/u);
  assert.deepEqual(calls[0].input[1], {
    type: "image",
    mimeType: "image/png",
    data: "ZmFrZQ==",
    detail: "high",
  });
  assert.equal(output.comments[0].body, "Agent comment.");
});

test("local agent gateway prompt declares exact Notes JSON schema for source-only image stages", async () => {
  const calls = [];
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async (payload) => {
      calls.push(payload);
      return {
        finalText: JSON.stringify({
          derivedArtifacts: [{ kind: "readableRendition", body: "Readable text.", sourceArtifactIds: ["src_image"] }],
        }),
      };
    },
  });

  await gateway.runStage("readableRendition", {
    targetItemId: null,
    sourceArtifactId: "src_image",
    attachments: [{ type: "localImage", path: "notes-captures/capture.jpg", detail: "auto" }],
  });

  const prompt = calls[0].input[0].text;
  assert.match(prompt, /derivedArtifacts.*kind.*body.*sourceArtifactIds/su);
  assert.match(prompt, /comments.*targetId.*body/su);
  assert.match(prompt, /Use `body`, not `text` or `content`/u);
  assert.match(prompt, /Use `kind`, not `type`/u);
  assert.match(prompt, /Target item is none.*do not create comments/su);
  assert.match(prompt, /readableRendition.*derivedArtifacts/su);
  assert.equal(prompt.includes('sourceArtifactIds: ["src_image"]'), true);
  assert.deepEqual(calls[0].input[1], { type: "localImage", path: "notes-captures/capture.jpg", detail: "auto" });
});

test("local agent gateway parses text response", async () => {
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async () => ({
      text: JSON.stringify({
        comments: [{ targetId: "item_1", body: "Text comment.", sourceItemIds: ["item_1"] }],
      }),
    }),
  });

  const output = await gateway.runStage("agentCommentary", { targetItemId: "item_1" });

  assert.equal(output.comments[0].body, "Text comment.");
});

test("local agent gateway parses message response", async () => {
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async () => ({
      message: JSON.stringify({
        comments: [{ targetId: "item_1", body: "Message comment.", sourceItemIds: ["item_1"] }],
      }),
    }),
  });

  const output = await gateway.runStage("agentCommentary", { targetItemId: "item_1" });

  assert.equal(output.comments[0].body, "Message comment.");
});

test("local agent gateway parses nested runtime request finalText", async () => {
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async () => ({
      ok: true,
      request: {
        finalText: JSON.stringify({
          comments: [{ targetId: "item_1", body: "Nested comment.", sourceItemIds: ["item_1"] }],
        }),
      },
    }),
  });

  const output = await gateway.runStage("agentCommentary", { targetItemId: "item_1" });

  assert.equal(output.comments[0].body, "Nested comment.");
});

test("local agent gateway rejects invalid JSON", async () => {
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async () => ({ finalText: "not json" }),
  });

  await assert.rejects(
    () => gateway.runStage("agentCommentary", { targetItemId: "item_1" }),
    /local agent returned invalid JSON/,
  );
});
