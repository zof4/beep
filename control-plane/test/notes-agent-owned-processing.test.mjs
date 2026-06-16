import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentOwnedNoteInput,
  parseAgentOwnedJson,
  recoverableAgentOwnedValidationErrors,
  validateAgentOwnedNoteOutput,
} from "../src/notes/agent-owned-processing.mjs";

const SOURCE = {
  id: "source_capture_1",
  kind: "image",
  image: {
    workspacePath: "/workspace/demo/notes-captures/current.jpg",
    mimeType: "image/jpeg",
    byteSize: 12345,
  },
};

const CURRENT_ATTACHMENT = {
  type: "localImage",
  path: "/workspace/demo/notes-captures/current.jpg",
  detail: "high",
};

const HANDWRITING = {
  enabled: true,
  profileId: "profile_1",
  samples: [
    {
      id: "sample_1",
      promptId: "flow_story",
      referenceText: "Every quiet river bends around the old stone bridge.",
      coverage: { domainTerms: ["river"], ambiguousPairs: ["m/n/u/w"] },
      imagePart: {
        type: "localImage",
        path: "/workspace/demo/handwriting/sample_1.jpg",
        detail: "original",
      },
    },
  ],
  lexicon: ["Beep"],
};

test("buildAgentOwnedNoteInput exposes paths, reference text, and native local image parts", () => {
  const input = buildAgentOwnedNoteInput({
    source: SOURCE,
    sourceArtifactId: "source_capture_1",
    attachments: [CURRENT_ATTACHMENT],
    handwriting: HANDWRITING,
  });

  assert.equal(input[0].type, "text");
  assert.match(input[0].text, /source_capture_1/u);
  assert.match(input[0].text, /notes-captures\/current\.jpg/u);
  assert.match(input[0].text, /sample_1/u);
  assert.match(input[0].text, /Every quiet river bends around the old stone bridge\./u);

  const imageParts = input.filter((part) => part.type === "localImage");
  assert.equal(imageParts.length, 2);
  assert.deepEqual(imageParts[0], {
    type: "localImage",
    path: "/workspace/demo/handwriting/sample_1.jpg",
    detail: "original",
  });
  assert.deepEqual(imageParts[1], CURRENT_ATTACHMENT);
});

test("parseAgentOwnedJson accepts Pi session and supervisor result shapes", () => {
  const body = {
    derivedArtifacts: [{ kind: "readableRendition", body: "River by bridge." }],
  };
  const text = JSON.stringify(body);

  assert.equal(parseAgentOwnedJson({ finalText: text }).derivedArtifacts[0].body, "River by bridge.");
  assert.equal(parseAgentOwnedJson({ result: { finalText: text } }).derivedArtifacts[0].kind, "readableRendition");
  assert.equal(parseAgentOwnedJson({ request: { finalText: text } }).derivedArtifacts[0].body, "River by bridge.");
});

test("recoverableAgentOwnedValidationErrors requires readable rendition and calibration usage", () => {
  const errors = recoverableAgentOwnedValidationErrors(
    {
      derivedArtifacts: [],
      handwriting: { sampleIdsUsed: [] },
    },
    { calibrationEnabled: true, sampleIdsProvided: ["sample_1"] },
  );

  assert.deepEqual(errors, [
    "Agent-owned image processing must return at least one readableRendition derived artifact.",
    "Calibration was enabled with samples, but the output did not report any handwriting.sampleIdsUsed.",
  ]);
});

test("validateAgentOwnedNoteOutput normalizes compact run summary", () => {
  const output = validateAgentOwnedNoteOutput(
    {
      derivedArtifacts: [{ kind: "readableRendition", body: "River by bridge.", sourceArtifactIds: ["source_capture_1"] }],
      comments: [{ targetId: "item_1", body: "Check the bridge note.", sourceArtifactIds: ["source_capture_1"] }],
      proposals: [{ kind: "todo", title: "Review bridge note", body: "Confirm the reading." }],
      handwriting: { sampleIdsUsed: ["sample_1"] },
      observations: ["ink is clear"],
      runSummary: {
        tools: { used: true, count: 2 },
        attempts: [{ status: "accepted" }],
      },
    },
    { thinking: "xhigh", calibrationEnabled: true, sampleIdsProvided: ["sample_1"] },
  );

  assert.equal(output.runSummary.mode, "agentOwned");
  assert.equal(output.runSummary.thinking, "xhigh");
  assert.deepEqual(output.runSummary.calibration, {
    enabled: true,
    sampleCount: 1,
    sampleIdsUsed: ["sample_1"],
  });
  assert.deepEqual(output.runSummary.tools, { used: true, count: 2 });
  assert.deepEqual(output.runSummary.validation, { ok: true, warnings: [] });
});
