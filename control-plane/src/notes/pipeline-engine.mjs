const WORKFLOW_STAGES = {
  processNote: [
    "readableRendition",
    "formattedNote",
    "agentCommentary",
    "draftExtraction",
    "plannerPass",
  ],
  askBeep: ["readContext", "agentCommentary", "draftExtraction"],
  agentOwnedProcessNote: ["agentOwnedNoteProcessing"],
};

const REVIEW_POLICIES = new Set(["stepReview", "firstReadCheckpoint", "autopilot"]);

function nowIso() {
  return new Date().toISOString();
}

function stageRecords(kind) {
  const stages = WORKFLOW_STAGES[kind];
  if (!stages) throw new Error(`unsupported pipeline kind: ${kind}`);
  return stages.map((name) => ({
    name,
    status: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
  }));
}

function nextPendingStage(run) {
  return run.stages.find((stage) => stage.status === "pending") || null;
}

function failedStage(run) {
  return run.stages.find((stage) => stage.status === "failed") || null;
}

function outputArray(stageOutput, key) {
  const value = stageOutput[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function mergeOutputs(outputs, stageOutput = {}) {
  if (
    stageOutput === null ||
    typeof stageOutput !== "object" ||
    Array.isArray(stageOutput)
  ) {
    throw new Error("stage output must be an object");
  }

  return {
    derivedArtifacts: [
      ...outputs.derivedArtifacts,
      ...outputArray(stageOutput, "derivedArtifacts"),
    ],
    comments: [...outputs.comments, ...outputArray(stageOutput, "comments")],
    proposals: [...outputs.proposals, ...outputArray(stageOutput, "proposals")],
    handwriting: stageOutput.handwriting === undefined ? outputs.handwriting || null : stageOutput.handwriting,
    runSummary: stageOutput.runSummary ?? outputs.runSummary ?? null,
  };
}

function shouldPause(run, completedStageName) {
  if (!nextPendingStage(run)) return { pause: false, reason: null };
  if (run.reviewPolicy === "stepReview") return { pause: true, reason: "step_review" };
  if (
    run.reviewPolicy === "firstReadCheckpoint" &&
    (completedStageName === "readableRendition" || completedStageName === "readContext")
  ) {
    return { pause: true, reason: "first_read_checkpoint" };
  }
  return { pause: false, reason: null };
}

export function createPipelineRun(input) {
  const createdAt = input.createdAt || nowIso();
  const reviewPolicy = input.reviewPolicy || "firstReadCheckpoint";
  if (!REVIEW_POLICIES.has(reviewPolicy)) {
    throw new Error(`unsupported review policy: ${reviewPolicy}`);
  }
  const stages = stageRecords(input.kind);
  return {
    schemaVersion: 1,
    id: input.id,
    kind: input.kind,
    reviewPolicy,
    targetItemId: input.targetItemId || null,
    sourceArtifactId: input.sourceArtifactId || null,
    status: "pending",
    currentStage: stages[0]?.name || null,
    pauseReason: null,
    stages,
    outputs: { derivedArtifacts: [], comments: [], proposals: [], handwriting: null, runSummary: null },
    errors: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export async function runPipeline(run, { gateway, now = nowIso, context = {} } = {}) {
  if (!gateway?.runStage) throw new Error("gateway.runStage is required");

  const nextRun = structuredClone(run);
  const existingFailedStage = failedStage(nextRun);
  if (nextRun.status === "failed" || existingFailedStage) {
    nextRun.status = "failed";
    nextRun.pauseReason = null;
    nextRun.currentStage =
      existingFailedStage?.name || nextRun.currentStage || nextPendingStage(nextRun)?.name || null;
    return nextRun;
  }

  nextRun.status = "running";
  nextRun.pauseReason = null;

  while (true) {
    const stage = nextPendingStage(nextRun);
    if (!stage) {
      nextRun.status = "completed";
      nextRun.currentStage = null;
      nextRun.pauseReason = null;
      nextRun.updatedAt = now();
      return nextRun;
    }

    stage.status = "running";
    stage.startedAt = now();
    nextRun.currentStage = stage.name;
    nextRun.updatedAt = stage.startedAt;

    try {
      const stageOutput = await gateway.runStage(stage.name, {
        ...context,
        targetItemId: nextRun.targetItemId,
        sourceArtifactId: nextRun.sourceArtifactId,
        runId: nextRun.id,
        outputs: structuredClone(nextRun.outputs),
      });
      nextRun.outputs = mergeOutputs(nextRun.outputs, stageOutput);
      stage.status = "completed";
      stage.completedAt = now();

      const pause = shouldPause(nextRun, stage.name);
      if (pause.pause) {
        nextRun.status = "paused";
        nextRun.pauseReason = pause.reason;
        nextRun.currentStage = nextPendingStage(nextRun)?.name || null;
        nextRun.updatedAt = stage.completedAt;
        return nextRun;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = now();
      stage.status = "failed";
      stage.completedAt = null;
      stage.error = message;
      nextRun.status = "failed";
      nextRun.errors.push({ stage: stage.name, message, at: failedAt });
      nextRun.updatedAt = failedAt;
      return nextRun;
    }
  }
}
