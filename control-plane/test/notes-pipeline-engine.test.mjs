import assert from "node:assert/strict";
import test from "node:test";
import { createPipelineRun, runPipeline } from "../src/notes/pipeline-engine.mjs";

const NOW = "2026-06-14T18:00:00.000Z";

function fakeGateway() {
  return {
    async runStage(stage, context) {
      return {
        comments:
          stage === "agentCommentary"
            ? [
                {
                  targetId: context.targetItemId,
                  body: "This note has two useful tasks.",
                  sourceItemIds: [context.targetItemId],
                },
              ]
            : [],
        proposals:
          stage === "draftExtraction"
            ? [
                {
                  kind: "todo",
                  title: "Call Sam",
                  body: "Ask about demo timing.",
                  sourceItemIds: [context.targetItemId],
                },
              ]
            : [],
        derivedArtifacts:
          stage === "readableRendition"
            ? [{ kind: "readableRendition", body: "Call Sam about demo timing." }]
            : [],
      };
    },
  };
}

test("stepReview pauses after the first completed stage", async () => {
  const run = createPipelineRun({
    id: "run_1",
    kind: "processNote",
    reviewPolicy: "stepReview",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "paused");
  assert.equal(result.currentStage, "formattedNote");
  assert.equal(result.stages[0].status, "completed");
  assert.equal(result.stages[1].status, "pending");
});

test("firstReadCheckpoint pauses after readable rendition", async () => {
  const run = createPipelineRun({
    id: "run_2",
    kind: "processNote",
    reviewPolicy: "firstReadCheckpoint",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "paused");
  assert.equal(result.pauseReason, "first_read_checkpoint");
  assert.equal(result.outputs.derivedArtifacts.length, 1);
});

test("firstReadCheckpoint pauses askBeep after read context", async () => {
  const run = createPipelineRun({
    id: "run_ask_read_checkpoint",
    kind: "askBeep",
    reviewPolicy: "firstReadCheckpoint",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "paused");
  assert.equal(result.pauseReason, "first_read_checkpoint");
  assert.equal(result.currentStage, "agentCommentary");
  assert.equal(result.stages[0].name, "readContext");
  assert.equal(result.stages[0].status, "completed");
  assert.equal(result.stages[1].status, "pending");
  assert.equal(result.outputs.comments.length, 0);
  assert.equal(result.outputs.proposals.length, 0);
});

test("autopilot completes all note-processing stages", async () => {
  const run = createPipelineRun({
    id: "run_3",
    kind: "processNote",
    reviewPolicy: "autopilot",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "completed");
  assert.equal(
    result.stages.every((stage) => stage.status === "completed"),
    true,
  );
  assert.equal(result.outputs.comments.length, 1);
  assert.equal(result.outputs.proposals.length, 1);
});

test("askBeep workflow uses a shorter stage list", () => {
  const run = createPipelineRun({
    id: "run_4",
    kind: "askBeep",
    reviewPolicy: "autopilot",
    targetItemId: "item_todo",
    createdAt: NOW,
  });

  assert.deepEqual(run.stages.map((stage) => stage.name), [
    "readContext",
    "agentCommentary",
    "draftExtraction",
  ]);
});

test("agent-owned note processing runs as a single-stage workflow with a run summary", async () => {
  const run = createPipelineRun({
    id: "run_agent_owned",
    kind: "agentOwnedProcessNote",
    sourceArtifactId: "source_capture_1",
    reviewPolicy: "autopilot",
    createdAt: NOW,
  });

  assert.deepEqual(run.stages.map((stage) => stage.name), ["agentOwnedNoteProcessing"]);
  assert.equal(run.outputs.runSummary, null);

  const completed = await runPipeline(run, {
    gateway: {
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
    },
    now: () => NOW,
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.outputs.derivedArtifacts[0].body, "Buy milk.");
  assert.equal(completed.outputs.runSummary.mode, "agentOwned");
});

test("stepReview resumes stage by stage and completes after the final stage", async () => {
  let run = createPipelineRun({
    id: "run_5",
    kind: "processNote",
    reviewPolicy: "stepReview",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  for (const nextStage of [
    "formattedNote",
    "agentCommentary",
    "draftExtraction",
    "plannerPass",
  ]) {
    run = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

    assert.equal(run.status, "paused");
    assert.equal(run.pauseReason, "step_review");
    assert.equal(run.currentStage, nextStage);
  }

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "completed");
  assert.equal(result.currentStage, null);
  assert.equal(result.pauseReason, null);
  assert.equal(
    result.stages.every((stage) => stage.status === "completed"),
    true,
  );
});

test("runPipeline refuses to advance runs with an existing failed stage", async () => {
  const run = createPipelineRun({
    id: "run_6",
    kind: "processNote",
    reviewPolicy: "autopilot",
    targetItemId: "item_note",
    createdAt: NOW,
  });
  run.status = "paused";
  run.currentStage = "readableRendition";
  run.pauseReason = "step_review";
  run.stages[0].status = "failed";
  run.stages[0].startedAt = NOW;
  run.stages[0].error = "gateway unavailable";

  let calls = 0;
  const result = await runPipeline(run, {
    gateway: {
      async runStage() {
        calls += 1;
        return {};
      },
    },
    now: () => NOW,
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.currentStage, "readableRendition");
  assert.equal(result.pauseReason, null);
  assert.equal(result.stages[0].status, "failed");
  assert.equal(result.stages[1].status, "pending");
});

test("gateway mutations of context outputs do not mutate accumulated outputs", async () => {
  const run = createPipelineRun({
    id: "run_7",
    kind: "askBeep",
    reviewPolicy: "autopilot",
    targetItemId: "item_todo",
    createdAt: NOW,
  });

  const result = await runPipeline(run, {
    gateway: {
      async runStage(stage, context) {
        context.outputs.comments.push({
          targetId: context.targetItemId,
          body: `mutated during ${stage}`,
          sourceItemIds: [context.targetItemId],
        });
        return stage === "agentCommentary"
          ? {
              comments: [
                {
                  targetId: context.targetItemId,
                  body: "Returned commentary.",
                  sourceItemIds: [context.targetItemId],
                },
              ],
            }
          : {};
      },
    },
    now: () => NOW,
  });

  assert.deepEqual(result.outputs.comments, [
    {
      targetId: "item_todo",
      body: "Returned commentary.",
      sourceItemIds: ["item_todo"],
    },
  ]);
});

test("malformed stage output fails the current stage without completing it", async () => {
  const run = createPipelineRun({
    id: "run_8",
    kind: "processNote",
    reviewPolicy: "autopilot",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, {
    gateway: {
      async runStage() {
        return { derivedArtifacts: { kind: "readableRendition" } };
      },
    },
    now: () => NOW,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.currentStage, "readableRendition");
  assert.equal(result.stages[0].status, "failed");
  assert.equal(result.stages[0].completedAt, null);
  assert.match(result.stages[0].error, /derivedArtifacts must be an array/);
});

test("pipeline preserves handwriting metadata separately from derived artifacts", async () => {
  const run = createPipelineRun({
    id: "run_handwriting",
    kind: "processNote",
    reviewPolicy: "stepReview",
    sourceArtifactId: "src_current",
    createdAt: NOW,
  });
  const gateway = {
    async runStage() {
      return {
        derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam.", sourceArtifactIds: ["src_current"] }],
        handwriting: {
          sampleIdsUsed: ["hw_sample_1"],
          uncertainSpans: [{ text: "Sam", alternatives: ["5am"], reason: "ambiguous S" }],
        },
      };
    },
  };

  const result = await runPipeline(run, { gateway, now: () => NOW });

  assert.equal(result.status, "paused");
  assert.equal(result.outputs.derivedArtifacts.length, 1);
  assert.deepEqual(result.outputs.handwriting.sampleIdsUsed, ["hw_sample_1"]);
  assert.deepEqual(result.outputs.handwriting.uncertainSpans[0].alternatives, ["5am"]);
});

test("pipeline preserves omitted handwriting metadata and replaces explicit later metadata", async () => {
  const run = createPipelineRun({
    id: "run_handwriting_merge",
    kind: "processNote",
    reviewPolicy: "autopilot",
    sourceArtifactId: "src_current",
    createdAt: NOW,
  });
  const handwritingA = {
    sampleIdsUsed: ["hw_sample_a"],
    uncertainSpans: [{ text: "Sam", alternatives: ["5am"], reason: "ambiguous S" }],
  };
  const handwritingB = {
    sampleIdsUsed: ["hw_sample_b"],
    uncertainSpans: [{ text: "plans", alternatives: ["pants"], reason: "ambiguous word" }],
  };
  const observed = [];
  const gateway = {
    async runStage(stage, context) {
      observed.push({ stage, handwriting: structuredClone(context.outputs.handwriting) });
      if (stage === "readableRendition") {
        return {
          derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam.", sourceArtifactIds: ["src_current"] }],
          handwriting: handwritingA,
        };
      }
      if (stage === "formattedNote") {
        return {
          derivedArtifacts: [{ kind: "formattedNote", body: "Call Sam.", sourceArtifactIds: ["src_current"] }],
        };
      }
      if (stage === "draftExtraction") {
        return { handwriting: handwritingB };
      }
      return {};
    },
  };

  const result = await runPipeline(run, { gateway, now: () => NOW });

  assert.equal(result.status, "completed");
  assert.deepEqual(observed.find((entry) => entry.stage === "formattedNote").handwriting, handwritingA);
  assert.deepEqual(observed.find((entry) => entry.stage === "agentCommentary").handwriting, handwritingA);
  assert.deepEqual(observed.find((entry) => entry.stage === "plannerPass").handwriting, handwritingB);
  assert.deepEqual(result.outputs.handwriting, handwritingB);
});
