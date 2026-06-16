# Agent-Owned Notes Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace image-note processing in the notes demo with a native multimodal, agent-owned path: the Pi/Codex-backed agent receives the current image, optional handwriting calibration images, reference text, and a task contract in one native input; the agent decides how much inspection/tool work to do; the control plane validates the final JSON, retries in the same session when validation fails, and stores only a compact run summary.

**Architecture:** Keep the existing staged pipeline for text/replay flows, but add a first-class `agentOwnedProcessNote` workflow for local-agent image captures. The control plane opens a Pi runtime session with `thinking: "xhigh"`, sends native `localImage` parts plus task text, validates final JSON with retry prompts, materializes derived artifacts/comments/proposals through the existing workspace store, and renders a compact summary in the demo.

**Tech Stack:** Node.js ESM, `node:test`, control-plane notes modules, Pi native runtime session API (`/sessions`, `/sessions/:id/prompt`), existing workspace media storage, in-app Browser for final demo verification.

---

## Current Code Map

- `control-plane/src/notes/routes.mjs`: capture process route, handwriting context construction, `localImage` input part construction, runtime forwarding.
- `control-plane/src/notes/beep-gateway.mjs`: staged prompt generation, local-agent submitter contract, stage-output validation.
- `control-plane/src/notes/pipeline-engine.mjs`: workflow stage list, pipeline run shape, output merging.
- `control-plane/src/notes/handwriting-domain.mjs`: handwriting calibration context with `localImage` parts and reference text.
- `control-plane/src/notes/demo-web.mjs`: browser UI for capture processing and run history.
- `runtime/src/beep-runtime-api.mjs`: Pi native session routes and one-shot `/agent/submit`.
- `control-plane/test/notes-routes.test.mjs`: API-level tests for captures, processing, and runtime forwarding.
- `control-plane/test/notes-pipeline-engine.test.mjs`: pipeline run and staged output tests.
- `control-plane/test/notes-beep-gateway.test.mjs`: prompt/input/validation tests.
- `control-plane/test/notes-demo-web.test.mjs`: static UI tests for the demo.

## Behavioral Contract

Agent-owned image processing must:

- Send image content as native `localImage` input parts, never as user-visible base64 text.
- Include explicit file paths in the task manifest so the agent can use general-purpose filesystem/image tools when useful.
- Include handwriting calibration as native `localImage` parts plus exact reference text, not as a correction after failure.
- Use a Pi runtime session for the whole processing run so retries preserve context.
- Use `thinking: "xhigh"` for local-agent image-note processing.
- Let the agent choose whether to crop, zoom, inspect, run scripts, or answer directly.
- Require final output as one JSON object matching the existing notes output schema plus compact run metadata.
- Retry validation failures in-session with a direct rework prompt.
- Store only compact summary metadata in the workspace run, not verbose logs.
- Preserve the existing staged path for text captures, replay tests, and non-local-agent modes until those flows intentionally migrate.

## Output Shape

The final JSON from the agent-owned path must validate to:

```json
{
  "derivedArtifacts": [
    {
      "kind": "readableRendition",
      "title": "Readable transcription",
      "body": "Transcribed note text."
    }
  ],
  "comments": [
    {
      "body": "Confidence notes or ambiguity notes.",
      "anchors": []
    }
  ],
  "proposals": [
    {
      "kind": "task",
      "title": "Follow up",
      "body": "A proposed action from the note."
    }
  ],
  "handwriting": {
    "sampleIdsUsed": ["sample_1"],
    "observations": ["The writer's e and l forms are narrow."]
  },
  "runSummary": {
    "mode": "agentOwned",
    "thinking": "xhigh",
    "calibration": {
      "enabled": true,
      "sampleCount": 1,
      "sampleIdsUsed": ["sample_1"]
    },
    "tools": {
      "used": true,
      "count": 3
    },
    "attempts": [
      {
        "status": "accepted",
        "reason": "Readable rendition and calibration usage reported."
      }
    ],
    "validation": {
      "ok": true,
      "warnings": []
    }
  }
}
```

## Task 1: Add Agent-Owned Processing Domain Module

**Purpose:** Create a small notes-domain module that builds native multimodal input, parses runtime result text, validates final JSON, and normalizes compact run metadata.

### Tests First

- [ ] Create `control-plane/test/notes-agent-owned-processing.test.mjs`.
- [ ] Add this RED test file:

```js
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentOwnedNoteInput,
  parseAgentOwnedJson,
  recoverableAgentOwnedValidationErrors,
  validateAgentOwnedNoteOutput,
} from "../src/notes/agent-owned-processing.mjs";

const source = {
  id: "source_capture_1",
  kind: "image",
  image: {
    workspacePath: "/workspace/demo/notes-captures/current.jpg",
    mimeType: "image/jpeg",
    byteSize: 12345,
  },
};

const attachment = {
  type: "localImage",
  path: "/workspace/demo/notes-captures/current.jpg",
  detail: "high",
};

const handwriting = {
  enabled: true,
  profileId: "profile_1",
  samples: [
    {
      id: "sample_1",
      promptId: "flow_story",
      referenceText: "Every quiet river bends around the old stone bridge.",
      coverage: {
        mode: "full",
        textLength: 58,
        promptTitle: "Flowing story",
      },
      imagePart: {
        type: "localImage",
        path: "/workspace/demo/handwriting/sample_1.jpg",
        detail: "original",
      },
    },
  ],
  lexicon: ["quiet", "river"],
};

test("buildAgentOwnedNoteInput exposes paths, reference text, and native local image parts", () => {
  const input = buildAgentOwnedNoteInput({
    source,
    sourceArtifactId: "source_capture_1",
    attachments: [attachment],
    handwriting,
  });

  const textParts = input.filter((part) => part.type === "text").map((part) => part.text);
  const imageParts = input.filter((part) => part.type === "localImage");
  const manifest = textParts.join("\n");

  assert.match(manifest, /source_capture_1/);
  assert.match(manifest, /notes-captures\/current\.jpg/);
  assert.match(manifest, /sample_1/);
  assert.match(manifest, /Every quiet river bends around the old stone bridge/);
  assert.equal(imageParts.length, 2);
  assert.deepEqual(imageParts.map((part) => part.path), [
    "/workspace/demo/handwriting/sample_1.jpg",
    "/workspace/demo/notes-captures/current.jpg",
  ]);
});

test("parseAgentOwnedJson accepts Pi session and supervisor result shapes", () => {
  const body = JSON.stringify({
    derivedArtifacts: [{ kind: "readableRendition", title: "Read", body: "Milk, rent, 10:30." }],
  });

  assert.deepEqual(parseAgentOwnedJson({ finalText: body }).derivedArtifacts[0].kind, "readableRendition");
  assert.deepEqual(parseAgentOwnedJson({ result: { finalText: body } }).derivedArtifacts[0].title, "Read");
  assert.deepEqual(parseAgentOwnedJson({ request: { finalText: body } }).derivedArtifacts[0].body, "Milk, rent, 10:30.");
});

test("recoverableAgentOwnedValidationErrors requires readable rendition and calibration usage", () => {
  const errors = recoverableAgentOwnedValidationErrors(
    {
      derivedArtifacts: [],
      comments: [],
      proposals: [],
      handwriting: { sampleIdsUsed: [] },
    },
    {
      calibrationEnabled: true,
      sampleIdsProvided: ["sample_1"],
    },
  );

  assert.deepEqual(errors, [
    "Agent-owned image processing must return at least one readableRendition derived artifact.",
    "Calibration was enabled with samples, but the output did not report any handwriting.sampleIdsUsed.",
  ]);
});

test("validateAgentOwnedNoteOutput normalizes compact run summary", () => {
  const output = validateAgentOwnedNoteOutput(
    {
      derivedArtifacts: [{ kind: "readableRendition", title: "Readable", body: "Call Sam at 4." }],
      comments: [{ body: "The last word is uncertain.", anchors: [] }],
      proposals: [{ kind: "task", title: "Call Sam", body: "Call Sam at 4." }],
      handwriting: { sampleIdsUsed: ["sample_1"], observations: ["Tall l resembles numeral 1."] },
      runSummary: {
        tools: { used: true, count: 2 },
        attempts: [{ status: "accepted", reason: "Final answer validated." }],
      },
    },
    {
      thinking: "xhigh",
      calibrationEnabled: true,
      sampleIdsProvided: ["sample_1"],
    },
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
```

- [ ] Run:

```bash
node --test control-plane/test/notes-agent-owned-processing.test.mjs
```

- [ ] Confirm the failure is caused by the missing `agent-owned-processing.mjs` module.

### Implementation

- [ ] Create `control-plane/src/notes/agent-owned-processing.mjs`.
- [ ] Implement the module with these exports:

```js
import { validateStageOutput } from "./beep-gateway.mjs";

export const AGENT_OWNED_PROCESS_NOTE_KIND = "agentOwnedProcessNote";
export const AGENT_OWNED_NOTES_STAGE = "agentOwnedNoteProcessing";
export const AGENT_OWNED_THINKING = "xhigh";

export function agentTextFromResult(result) {
  if (typeof result === "string") return result;
  return (
    result?.finalText ??
    result?.text ??
    result?.message ??
    result?.result?.finalText ??
    result?.result?.text ??
    result?.request?.finalText ??
    result?.request?.text ??
    ""
  );
}

export function parseAgentOwnedJson(result) {
  const text = agentTextFromResult(result).trim();
  if (!text) {
    throw new Error("Agent-owned note processing returned no final text.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Agent-owned note processing returned invalid JSON: ${error.message}`);
  }
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function uniqueStrings(value) {
  return Array.from(new Set(stringArray(value)));
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function summarizeSample(sample) {
  return {
    id: sample.id,
    promptId: sample.promptId,
    referenceText: sample.referenceText,
    imagePath: sample.imagePart?.path,
    imageDetail: sample.imagePart?.detail ?? "auto",
    coverage: sample.coverage ?? null,
  };
}

export function buildAgentOwnedNoteInput({ source, sourceArtifactId, attachments = [], handwriting = null }) {
  const samples = handwriting?.enabled ? handwriting.samples ?? [] : [];
  const sampleManifest = samples.map(summarizeSample);
  const captureManifest = attachments.map((part, index) => ({
    index,
    type: part.type,
    path: part.path,
    detail: part.detail ?? "auto",
  }));

  const task = {
    role: "notes-agent-owned-processing",
    sourceArtifactId,
    sourceKind: source?.kind ?? "unknown",
    objective:
      "Transcribe and structure the handwritten note image. Decide whether to inspect directly or use tools such as cropping, zooming, OCR helpers, or image scripts. Return final JSON only when the result is ready.",
    currentCapture: captureManifest,
    handwritingCalibration: {
      enabled: Boolean(handwriting?.enabled),
      profileId: handwriting?.profileId ?? null,
      samples: sampleManifest,
      lexicon: handwriting?.lexicon ?? [],
    },
    requiredFinalJson: {
      derivedArtifacts: "Array; must include at least one readableRendition item for image captures.",
      comments: "Array of reviewer-facing notes or uncertainties.",
      proposals: "Array of extracted tasks, dates, decisions, or follow-up proposals.",
      handwriting:
        "Object with sampleIdsUsed and observations when calibration was available. Use sample ids only when they influenced interpretation.",
      runSummary:
        "Compact object with mode, thinking, calibration, tools, attempts, and validation. Do not include verbose logs.",
    },
  };

  return [
    {
      type: "text",
      text: [
        "You are the Beep notes processing agent.",
        "You own the whole image-note processing loop for this run.",
        "Use the native image parts and the listed local paths. If the handwriting is difficult, inspect the image carefully and use tools before returning final JSON.",
        "When validation feedback is provided in a retry turn, rework the answer instead of repeating the same failure.",
        "Return exactly one JSON object and no markdown.",
        JSON.stringify(task, null, 2),
      ].join("\n\n"),
    },
    ...samples.map((sample) => sample.imagePart).filter((part) => part?.type === "localImage" && part.path),
    ...attachments.filter((part) => part?.type === "localImage" && part.path),
  ];
}

export function recoverableAgentOwnedValidationErrors(output, { calibrationEnabled = false, sampleIdsProvided = [] } = {}) {
  const errors = [];
  const artifacts = Array.isArray(output?.derivedArtifacts) ? output.derivedArtifacts : [];
  const hasReadableRendition = artifacts.some((artifact) => artifact?.kind === "readableRendition");
  const reportedSampleIds = stringArray(output?.handwriting?.sampleIdsUsed);

  if (!hasReadableRendition) {
    errors.push("Agent-owned image processing must return at least one readableRendition derived artifact.");
  }
  if (calibrationEnabled && sampleIdsProvided.length > 0 && reportedSampleIds.length === 0) {
    errors.push("Calibration was enabled with samples, but the output did not report any handwriting.sampleIdsUsed.");
  }

  return errors;
}

export function normalizeRunSummary(rawSummary = {}, { thinking = AGENT_OWNED_THINKING, calibrationEnabled = false, sampleIdsProvided = [], sampleIdsUsed = [] } = {}) {
  const attempts = Array.isArray(rawSummary?.attempts)
    ? rawSummary.attempts
        .filter((attempt) => ["retry", "accepted", "failed"].includes(attempt?.status))
        .map((attempt) => ({
          status: attempt.status,
          reason: typeof attempt.reason === "string" ? attempt.reason : "",
        }))
    : [];

  const finalSampleIdsUsed = uniqueStrings(
    rawSummary?.calibration?.sampleIdsUsed?.length ? rawSummary.calibration.sampleIdsUsed : sampleIdsUsed,
  );
  const toolCount = nonNegativeInteger(rawSummary?.tools?.count);

  return {
    mode: "agentOwned",
    thinking,
    calibration: {
      enabled: Boolean(calibrationEnabled),
      sampleCount: sampleIdsProvided.length,
      sampleIdsUsed: finalSampleIdsUsed,
    },
    tools: {
      used: Boolean(rawSummary?.tools?.used || toolCount > 0),
      count: toolCount,
    },
    attempts,
    validation: {
      ok: true,
      warnings: stringArray(rawSummary?.validation?.warnings),
    },
  };
}

export function validateAgentOwnedNoteOutput(raw, options = {}) {
  const stageOutput = validateStageOutput(raw);
  const validationErrors = recoverableAgentOwnedValidationErrors(stageOutput, options);
  if (validationErrors.length > 0) {
    const error = new Error(validationErrors.join(" "));
    error.validationErrors = validationErrors;
    throw error;
  }

  const sampleIdsUsed = stringArray(stageOutput.handwriting?.sampleIdsUsed);
  return {
    ...stageOutput,
    runSummary: normalizeRunSummary(raw?.runSummary, {
      ...options,
      sampleIdsUsed,
    }),
  };
}

export function buildAgentOwnedRetryInput({ validationErrors, attemptNumber }) {
  return [
    {
      type: "text",
      text: [
        `Validation failed after attempt ${attemptNumber}. Rework the same note using the native images and paths already in this session.`,
        "Fix every validation issue and return exactly one final JSON object.",
        JSON.stringify({ validationErrors }, null, 2),
      ].join("\n\n"),
    },
  ];
}
```

- [ ] Run:

```bash
node --test control-plane/test/notes-agent-owned-processing.test.mjs
```

- [ ] Commit:

```bash
git add control-plane/src/notes/agent-owned-processing.mjs control-plane/test/notes-agent-owned-processing.test.mjs
git commit -m "Add agent-owned notes processing domain"
```

## Task 2: Extend Pipeline Run Shape for Agent-Owned Runs

**Purpose:** Make agent-owned processing a first-class workflow kind with its own stage and `runSummary` output slot.

### Tests First

- [ ] In `control-plane/test/notes-pipeline-engine.test.mjs`, add:

```js
test("agent-owned process note runs one native multimodal stage and preserves run summary", async () => {
  const run = createPipelineRun({
    kind: "agentOwnedProcessNote",
    sourceArtifactId: "source_capture_1",
    reviewPolicy: "autoApply",
  });

  assert.equal(run.stages.length, 1);
  assert.equal(run.stages[0].name, "agentOwnedNoteProcessing");
  assert.deepEqual(run.outputs.runSummary, null);

  const gateway = {
    async runStage(stage) {
      assert.equal(stage, "agentOwnedNoteProcessing");
      return {
        derivedArtifacts: [{ kind: "readableRendition", title: "Readable", body: "Buy milk." }],
        comments: [],
        proposals: [],
        handwriting: { sampleIdsUsed: ["sample_1"], observations: [] },
        runSummary: {
          mode: "agentOwned",
          thinking: "xhigh",
          calibration: { enabled: true, sampleCount: 1, sampleIdsUsed: ["sample_1"] },
          tools: { used: false, count: 0 },
          attempts: [{ status: "accepted", reason: "Valid." }],
          validation: { ok: true, warnings: [] },
        },
      };
    },
  };

  const completed = await runPipeline({ run, gateway, context: {}, now: () => "2026-06-15T12:00:00.000Z" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.outputs.derivedArtifacts[0].body, "Buy milk.");
  assert.equal(completed.outputs.runSummary.mode, "agentOwned");
});
```

- [ ] Run:

```bash
node --test control-plane/test/notes-pipeline-engine.test.mjs
```

- [ ] Confirm it fails because `agentOwnedProcessNote` is unknown or `runSummary` is absent.

### Implementation

- [ ] Edit `control-plane/src/notes/pipeline-engine.mjs`.
- [ ] Add the new workflow stage:

```js
const WORKFLOW_STAGES = {
  processNote: ["readableRendition", "formattedNote", "agentCommentary", "draftExtraction", "plannerPass"],
  askBeep: ["answerQuestion"],
  agentOwnedProcessNote: ["agentOwnedNoteProcessing"],
};
```

- [ ] Add `runSummary` to new runs:

```js
outputs: {
  derivedArtifacts: [],
  comments: [],
  proposals: [],
  handwriting: null,
  runSummary: null,
},
```

- [ ] Preserve `runSummary` in `mergeOutputs`:

```js
runSummary: output.runSummary ?? current.runSummary ?? null,
```

- [ ] Ensure existing tests that deep-compare output objects are updated to include `runSummary: null`.
- [ ] Run:

```bash
node --test control-plane/test/notes-pipeline-engine.test.mjs
```

- [ ] Run:

```bash
node --test control-plane/test/notes-routes.test.mjs control-plane/test/notes-beep-gateway.test.mjs
```

- [ ] Commit:

```bash
git add control-plane/src/notes/pipeline-engine.mjs control-plane/test/notes-pipeline-engine.test.mjs control-plane/test/notes-routes.test.mjs control-plane/test/notes-beep-gateway.test.mjs
git commit -m "Make agent-owned notes a pipeline workflow"
```

## Task 3: Route Image Captures Through Pi Native Sessions

**Purpose:** Use `/sessions` and `/sessions/:id/prompt` for local-agent image captures, with in-session validation retry and compact run storage.

### Tests First

- [ ] In `control-plane/test/notes-routes.test.mjs`, add a helper runtime proxy recorder near existing runtime forwarding tests:

```js
function createAgentOwnedRuntimeProxy({ firstFinalText, secondFinalText = null }) {
  const calls = [];
  let promptCount = 0;

  return {
    calls,
    async proxyToRuntime(path, init) {
      const body = init?.body ? JSON.parse(init.body) : null;
      calls.push({ path, body });

      if (path === "/sessions") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, session: { id: "sess_notes_1" } }),
        };
      }

      if (path === "/sessions/sess_notes_1/prompt") {
        promptCount += 1;
        const finalText = promptCount === 1 ? firstFinalText : secondFinalText ?? firstFinalText;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { finalText } }),
        };
      }

      throw new Error(`unexpected runtime path ${path}`);
    },
  };
}
```

- [ ] Add a route test proving the image path uses sessions and `xhigh` thinking:

```js
test("local-agent image capture processing uses Pi native session with xhigh thinking", async () => {
  const workspaceRoot = await makeTempWorkspace();
  const notesStore = new NotesWorkspaceStore({ workspaceRoot });
  const app = createNotesApp({ notesStore });

  const source = await notesStore.createSourceArtifact({
    kind: "image",
    title: "Photo note",
    image: {
      workspacePath: `${workspaceRoot}/notes-captures/current.jpg`,
      mimeType: "image/jpeg",
      byteSize: 1200,
    },
  });
  const capture = await notesStore.createCapture({ sourceArtifactId: source.id, title: "Photo note" });

  const finalText = JSON.stringify({
    derivedArtifacts: [{ kind: "readableRendition", title: "Readable", body: "Call Alex at 10:30." }],
    comments: [],
    proposals: [{ kind: "task", title: "Call Alex", body: "Call Alex at 10:30." }],
    handwriting: { sampleIdsUsed: [], observations: [] },
    runSummary: {
      tools: { used: false, count: 0 },
      attempts: [{ status: "accepted", reason: "Valid transcription." }],
    },
  });
  const runtime = createAgentOwnedRuntimeProxy({ firstFinalText: finalText });

  const response = await app.inject({
    method: "POST",
    path: `/api/notes/captures/${capture.id}/process`,
    payload: {
      beepMode: "localAgent",
      useHandwritingCalibration: false,
    },
    proxyToRuntime: runtime.proxyToRuntime,
  });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.run.kind, "agentOwnedProcessNote");
  assert.equal(body.run.outputs.runSummary.thinking, "xhigh");
  assert.deepEqual(runtime.calls.map((call) => call.path), ["/sessions", "/sessions/sess_notes_1/prompt"]);
  assert.equal(runtime.calls[0].body.thinking, "xhigh");
  assert.match(JSON.stringify(runtime.calls[1].body.input), /notes-captures\/current\.jpg/);
});
```

- [ ] Add a route test proving recoverable validation retry happens in the same session:

```js
test("agent-owned image processing retries validation failures in the same session", async () => {
  const workspaceRoot = await makeTempWorkspace();
  const notesStore = new NotesWorkspaceStore({ workspaceRoot });
  const app = createNotesApp({ notesStore });

  const source = await notesStore.createSourceArtifact({
    kind: "image",
    title: "Photo note",
    image: {
      workspacePath: `${workspaceRoot}/notes-captures/current.jpg`,
      mimeType: "image/jpeg",
      byteSize: 1200,
    },
  });
  const capture = await notesStore.createCapture({ sourceArtifactId: source.id, title: "Photo note" });

  const invalidText = JSON.stringify({
    derivedArtifacts: [],
    comments: [],
    proposals: [],
    handwriting: { sampleIdsUsed: [], observations: [] },
  });
  const validText = JSON.stringify({
    derivedArtifacts: [{ kind: "readableRendition", title: "Readable", body: "The budget review moved to Friday." }],
    comments: [],
    proposals: [],
    handwriting: { sampleIdsUsed: [], observations: [] },
    runSummary: {
      tools: { used: true, count: 1 },
      attempts: [{ status: "accepted", reason: "Valid after rework." }],
    },
  });
  const runtime = createAgentOwnedRuntimeProxy({ firstFinalText: invalidText, secondFinalText: validText });

  const response = await app.inject({
    method: "POST",
    path: `/api/notes/captures/${capture.id}/process`,
    payload: {
      beepMode: "localAgent",
      useHandwritingCalibration: false,
    },
    proxyToRuntime: runtime.proxyToRuntime,
  });

  assert.equal(response.statusCode, 200);
  const promptCalls = runtime.calls.filter((call) => call.path === "/sessions/sess_notes_1/prompt");
  assert.equal(promptCalls.length, 2);
  assert.match(JSON.stringify(promptCalls[1].body.input), /Validation failed after attempt 1/);
  assert.equal(JSON.parse(response.body).run.outputs.derivedArtifacts[0].body, "The budget review moved to Friday.");
});
```

- [ ] Add a route test proving text captures still use `/agent/submit` in local-agent mode:

```js
test("local-agent text capture processing stays on staged submit path", async () => {
  const workspaceRoot = await makeTempWorkspace();
  const notesStore = new NotesWorkspaceStore({ workspaceRoot });
  const app = createNotesApp({ notesStore });

  const source = await notesStore.createSourceArtifact({
    kind: "text",
    title: "Typed note",
    body: "Call Alex at 10:30.",
  });
  const capture = await notesStore.createCapture({ sourceArtifactId: source.id, title: "Typed note" });
  const calls = [];

  const response = await app.inject({
    method: "POST",
    path: `/api/notes/captures/${capture.id}/process`,
    payload: { beepMode: "localAgent" },
    proxyToRuntime: async (path, init) => {
      calls.push({ path, body: init?.body ? JSON.parse(init.body) : null });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          request: {
            finalText: JSON.stringify({
              derivedArtifacts: [{ kind: "readableRendition", title: "Readable", body: "Call Alex at 10:30." }],
              comments: [],
              proposals: [],
            }),
          },
        }),
      };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.ok(calls.every((call) => call.path === "/agent/submit"));
  assert.equal(JSON.parse(response.body).run.kind, "processNote");
});
```

- [ ] Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

- [ ] Confirm failures show the route still sends image captures through `/agent/submit`.

### Implementation

- [ ] Edit `control-plane/src/notes/routes.mjs`.
- [ ] Import agent-owned helpers:

```js
import {
  AGENT_OWNED_PROCESS_NOTE_KIND,
  AGENT_OWNED_THINKING,
  buildAgentOwnedNoteInput,
  buildAgentOwnedRetryInput,
  parseAgentOwnedJson,
  validateAgentOwnedNoteOutput,
} from "./agent-owned-processing.mjs";
```

- [ ] Add a local predicate:

```js
function shouldUseAgentOwnedImageProcessing({ body, source }) {
  return body?.beepMode === "localAgent" && source?.kind === "image";
}
```

- [ ] Add runtime response assertion:

```js
async function readRuntimeJson(response, label) {
  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(`${label} failed with status ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}
```

- [ ] Add `runAgentOwnedNotesPipeline` near `runNotesPipeline`:

```js
async function runAgentOwnedNotesPipeline({
  notesStore,
  body,
  forwardRuntimeRequest,
  source,
  context,
  reviewPolicy,
  sourceArtifactId,
}) {
  const run = createPipelineRun({
    kind: AGENT_OWNED_PROCESS_NOTE_KIND,
    sourceArtifactId,
    reviewPolicy,
  });

  const sampleIdsProvided = context.handwriting?.enabled
    ? (context.handwriting.samples ?? []).map((sample) => sample.id).filter(Boolean)
    : [];
  const validationOptions = {
    thinking: AGENT_OWNED_THINKING,
    calibrationEnabled: Boolean(context.handwriting?.enabled),
    sampleIdsProvided,
  };
  const attempts = [];

  const sessionResponse = await forwardRuntimeRequest("/sessions", {
    method: "POST",
    body: JSON.stringify({
      prefix: "notes-agent-owned",
      thinking: AGENT_OWNED_THINKING,
    }),
  });
  const sessionPayload = await readRuntimeJson(sessionResponse, "Creating notes agent-owned session");
  const sessionId = sessionPayload?.session?.id;
  if (!sessionId) {
    throw new Error("Creating notes agent-owned session did not return session.id.");
  }

  let promptInput = buildAgentOwnedNoteInput({
    source,
    sourceArtifactId,
    attachments: context.attachments,
    handwriting: context.handwriting,
  });

  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const promptResponse = await forwardRuntimeRequest(`/sessions/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        input: promptInput,
        waitForCompletion: true,
      }),
    });
    const promptPayload = await readRuntimeJson(promptResponse, `Agent-owned notes prompt attempt ${attemptNumber}`);

    try {
      const parsed = parseAgentOwnedJson(promptPayload);
      const output = validateAgentOwnedNoteOutput(parsed, validationOptions);
      const finalAttempts = [
        ...attempts,
        ...(output.runSummary.attempts.length > 0
          ? output.runSummary.attempts
          : [{ status: "accepted", reason: "Validated by control plane." }]),
      ];
      const completedOutput = {
        ...output,
        runSummary: {
          ...output.runSummary,
          attempts: finalAttempts,
        },
      };

      run.outputs = mergeAgentOwnedRunOutputs(run.outputs, completedOutput);
      run.status = "completed";
      run.stages = run.stages.map((stage) =>
        stage.name === "agentOwnedNoteProcessing"
          ? { ...stage, status: "completed", completedAt: new Date().toISOString() }
          : stage,
      );
      return run;
    } catch (error) {
      const validationErrors = error.validationErrors ?? [error.message];
      attempts.push({ status: "retry", reason: validationErrors.join(" ") });
      if (attemptNumber === 3) {
        run.status = "failed";
        run.error = validationErrors.join(" ");
        run.outputs.runSummary = {
          mode: "agentOwned",
          thinking: AGENT_OWNED_THINKING,
          calibration: {
            enabled: validationOptions.calibrationEnabled,
            sampleCount: sampleIdsProvided.length,
            sampleIdsUsed: [],
          },
          tools: { used: false, count: 0 },
          attempts: [...attempts, { status: "failed", reason: validationErrors.join(" ") }],
          validation: { ok: false, warnings: validationErrors },
        };
        return run;
      }
      promptInput = buildAgentOwnedRetryInput({ validationErrors, attemptNumber });
    }
  }

  return run;
}
```

- [ ] Add `mergeAgentOwnedRunOutputs` in `routes.mjs` or export `mergeOutputs` from `pipeline-engine.mjs`. Prefer exporting `mergeOutputs` if the existing function is already pure; otherwise keep this local minimal merge:

```js
function mergeAgentOwnedRunOutputs(current, output) {
  return {
    derivedArtifacts: [...(current.derivedArtifacts ?? []), ...(output.derivedArtifacts ?? [])],
    comments: [...(current.comments ?? []), ...(output.comments ?? [])],
    proposals: [...(current.proposals ?? []), ...(output.proposals ?? [])],
    handwriting: output.handwriting ?? current.handwriting ?? null,
    runSummary: output.runSummary ?? current.runSummary ?? null,
  };
}
```

- [ ] In the capture process route, after `attachments` and `handwriting` are built, branch local-agent images:

```js
const context = { attachments, handwriting };
const run =
  shouldUseAgentOwnedImageProcessing({ body, source })
    ? await runAgentOwnedNotesPipeline({
        notesStore,
        body,
        forwardRuntimeRequest,
        source,
        context,
        reviewPolicy,
        sourceArtifactId: source.id,
      })
    : await runNotesPipeline({
        notesStore,
        body,
        forwardRuntimeRequest,
        replay,
        runInput: { kind: "processNote", sourceArtifactId: source.id },
        context,
        reviewPolicy,
      });
```

- [ ] Keep the existing materialization and `notesStore.upsertRun(run)` behavior so agent-owned outputs become artifacts/comments/proposals through the same store path.
- [ ] Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

- [ ] Run:

```bash
node --test control-plane/test/notes-agent-owned-processing.test.mjs control-plane/test/notes-pipeline-engine.test.mjs
```

- [ ] Commit:

```bash
git add control-plane/src/notes/routes.mjs control-plane/test/notes-routes.test.mjs
git commit -m "Route image notes through agent-owned Pi sessions"
```

## Task 4: Render Compact Agent Run Summary in the Notes Demo

**Purpose:** Give the test area enough visibility to confirm native agent-owned processing happened without creating a bulky audit log.

### Tests First

- [ ] In `control-plane/test/notes-demo-web.test.mjs`, add assertions that the demo renders run summary labels:

```js
test("notes demo script renders compact agent-owned run summary", async () => {
  const html = await renderNotesDemoHtml();
  assert.match(html, /function runSummaryText/);
  assert.match(html, /Agent run/);
  assert.match(html, /calibration/);
  assert.match(html, /tools/);
});
```

- [ ] Run:

```bash
node --test control-plane/test/notes-demo-web.test.mjs
```

- [ ] Confirm it fails because the UI has no compact agent summary renderer.

### Implementation

- [ ] Edit `control-plane/src/notes/demo-web.mjs`.
- [ ] Add a helper in the browser script:

```js
function runSummaryText(run) {
  const summary = run.outputs?.runSummary;
  if (!summary || summary.mode !== 'agentOwned') return '';
  const calibration = summary.calibration || {};
  const tools = summary.tools || {};
  const attempts = Array.isArray(summary.attempts) ? summary.attempts : [];
  const retryCount = attempts.filter((attempt) => attempt.status === 'retry').length;
  const sampleCount = Array.isArray(calibration.sampleIdsUsed) ? calibration.sampleIdsUsed.length : 0;
  const validation = summary.validation?.ok === false ? 'validation failed' : 'validated';
  return [
    'Agent run',
    summary.thinking || 'thinking unknown',
    `calibration ${sampleCount}/${calibration.sampleCount || 0}`,
    `tools ${tools.count || 0}`,
    `retries ${retryCount}`,
    validation,
  ].join(' | ');
}
```

- [ ] In `renderRuns()`, render the extra summary line only when present:

```js
const summary = runSummaryText(run);
return `
  <li class="run-item">
    <div>
      <strong>${escapeHtml(run.kind)}</strong>
      <span>${escapeHtml(run.reviewPolicy)} | ${escapeHtml(run.status)}</span>
      ${summary ? `<span>${escapeHtml(summary)}</span>` : ''}
    </div>
    <time>${escapeHtml(new Date(run.createdAt).toLocaleString())}</time>
  </li>
`;
```

- [ ] Keep this compact: one additional text row, no expanding audit table.
- [ ] Run:

```bash
node --test control-plane/test/notes-demo-web.test.mjs
```

- [ ] Commit:

```bash
git add control-plane/src/notes/demo-web.mjs control-plane/test/notes-demo-web.test.mjs
git commit -m "Show compact agent-owned run summaries"
```

## Task 5: Full Static Verification

**Purpose:** Verify the notes backbone still passes as a whole after the native agent-owned route is added.

- [ ] Run the focused suite:

```bash
node --test control-plane/test/notes-agent-owned-processing.test.mjs control-plane/test/notes-pipeline-engine.test.mjs control-plane/test/notes-routes.test.mjs control-plane/test/notes-demo-web.test.mjs
```

- [ ] Run the package script:

```bash
npm run test:notes-backbone-static
```

- [ ] If static tests expose deep-equality failures, update expected run objects to include `runSummary: null` only where the existing run shape now includes that field.
- [ ] Commit final test expectation adjustments:

```bash
git add control-plane/test package.json
git commit -m "Update notes tests for agent-owned run summaries"
```

## Task 6: Live Demo Verification

**Purpose:** Prove the current browser test area actually uses the new route.

- [ ] Start or reuse the control-plane server on `http://127.0.0.1:18789/notes`.
- [ ] Open the in-app Browser at `http://127.0.0.1:18789/notes`.
- [ ] Use the notes demo with:
  - `beepMode: localAgent`
  - image capture selected
  - `Use calibration in captures` checked when testing handwriting calibration
- [ ] Process an image note.
- [ ] Confirm the run list shows:
  - `agentOwnedProcessNote`
  - `Agent run | xhigh`
  - compact calibration count
  - compact tool count
  - retry count
  - validation status
- [ ] Confirm the network path is `/api/notes/captures/:id/process`; runtime forwarding should go through `/sessions` and `/sessions/:id/prompt`, not `/agent/submit`, for local-agent image captures.
- [ ] Test a text capture in local-agent mode and confirm it still completes as `processNote`.

## Failure Handling Rules

- If `/sessions` returns no `session.id`, fail the run with a clear control-plane error.
- If final text is empty, invalid JSON, missing `readableRendition`, or missing calibration usage when calibration samples were supplied, retry in the same session.
- Retry at most three prompt attempts per run.
- Store failed attempts in `run.outputs.runSummary.attempts` with compact reasons.
- Do not store tool transcripts, raw model reasoning, or image base64 in workspace run data.
- Do not add a separate audit-log collection for this demo path.

## Completion Criteria

- `npm run test:notes-backbone-static` passes.
- Local-agent image capture processing creates an `agentOwnedProcessNote` run.
- Runtime calls for local-agent image capture use `/sessions` and `/sessions/:id/prompt`.
- The first session create request sets `thinking` to `"xhigh"`.
- The prompt input contains native `localImage` parts for the capture and enabled calibration samples.
- Validation failure triggers an in-session retry prompt.
- The demo run history shows compact agent-owned status without bulky audit output.
- No code path converts image bytes into prompt-visible base64 text.
