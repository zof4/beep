import { validateStageOutput } from "./beep-gateway.mjs";

export const AGENT_OWNED_PROCESS_NOTE_KIND = "agentOwnedProcessNote";
export const AGENT_OWNED_NOTES_STAGE = "agentOwnedNoteProcessing";
export const AGENT_OWNED_THINKING = "xhigh";

const ATTEMPT_STATUSES = new Set(["retry", "accepted", "failed"]);
const MAX_ATTEMPT_REASON_LENGTH = 240;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePart(part) {
  return structuredClone(part);
}

function localImageParts(parts = []) {
  if (!Array.isArray(parts)) return [];
  return parts.filter((part) => part?.type === "localImage").map(clonePart);
}

function uniqueStringIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function nonnegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function sanitizeWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function compactString(value, maxLength) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function sanitizeAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((attempt) => isPlainObject(attempt))
    .map((attempt) => {
      const status = String(attempt.status ?? "").trim();
      const reason = compactString(attempt.reason, MAX_ATTEMPT_REASON_LENGTH);
      return reason ? { status, reason } : { status };
    })
    .filter((attempt) => ATTEMPT_STATUSES.has(attempt.status));
}

function currentImageSource(source) {
  if (isPlainObject(source?.image)) return source.image;
  const firstMediaFile = Array.isArray(source?.media?.files) ? source.media.files[0] : null;
  if (!isPlainObject(firstMediaFile)) return {};
  return firstMediaFile ?? {};
}

function currentCaptureManifest({ source, attachments }) {
  const image = currentImageSource(source);
  const imagePath = image.workspacePath || source?.workspacePath || null;
  const attachmentDetail =
    attachments.find((part) => part?.type === "localImage" && part.path === imagePath)?.detail || null;
  const imageDetail = image.detail ?? attachmentDetail;
  return {
    sourceId: source?.id ?? null,
    imagePath,
    imageDetail,
    imageMimeType: image.mimeType ?? null,
    imageByteSize: image.byteSize ?? image.sizeBytes ?? null,
    attachments: attachments.map((part) => ({
      type: part.type,
      path: part.path,
      detail: part.detail ?? null,
    })),
  };
}

function handwritingManifest(handwriting) {
  const enabled = Boolean(handwriting?.enabled);
  const samples = enabled && Array.isArray(handwriting?.samples) ? handwriting.samples : [];
  return {
    enabled,
    profileId: handwriting?.profileId ?? null,
    samples: samples.map((sample) => ({
      id: sample.id ?? null,
      promptId: sample.promptId ?? null,
      referenceText: sample.referenceText ?? "",
      imagePath: sample.imagePart?.path ?? null,
      imageDetail: sample.imagePart?.detail ?? null,
      coverage: sample.coverage ?? null,
    })),
    referenceText: samples.map((sample) => sample.referenceText ?? "").filter(Boolean),
    coverage: samples.map((sample) => sample.coverage).filter(Boolean),
    lexicon: Array.isArray(handwriting?.lexicon) ? handwriting.lexicon : [],
  };
}

function requiredFinalJsonContract() {
  return {
    derivedArtifacts: [
      {
        kind: "readableRendition",
        body: "Readable transcription or concise readable summary of the image note.",
        sourceArtifactIds: ["sourceArtifactId"],
      },
    ],
    comments: [
      {
        targetId: "workspace item id when commenting on an item",
        body: "Comment text.",
        sourceArtifactIds: ["sourceArtifactId"],
      },
    ],
    proposals: [
      {
        kind: "todo",
        allowedKinds: ["todo", "calendarBlock", "research", "comment", "estimate", "plan"],
        title: "Proposal title.",
        body: "Proposal detail.",
        sourceArtifactIds: ["sourceArtifactId"],
      },
    ],
    handwriting: {
      sampleIdsUsed: ["sample id when calibration informs the reading"],
      uncertainSpans: [{ text: "uncertain text", alternatives: ["alternative"], reason: "why uncertain" }],
    },
  };
}

export function agentTextFromResult(result) {
  if (typeof result === "string") return result;
  return (
    result?.finalText ??
    result?.text ??
    result?.message ??
    result?.result?.finalText ??
    result?.result?.text ??
    result?.result?.message ??
    result?.request?.finalText ??
    result?.request?.text ??
    result?.request?.message ??
    ""
  );
}

export function parseAgentOwnedJson(result) {
  const text = String(agentTextFromResult(result) ?? "").trim();
  if (!text) throw new Error("Agent-owned note processing returned no final text.");
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent-owned note processing returned invalid JSON: ${message}`);
  }
}

export function buildAgentOwnedNoteInput({ source, sourceArtifactId, attachments = [], handwriting = null }) {
  const currentAttachments = localImageParts(attachments);
  const handwritingSamples = handwriting?.enabled && Array.isArray(handwriting.samples) ? handwriting.samples : [];
  const manifest = {
    sourceArtifactId: sourceArtifactId ?? null,
    sourceKind: source?.kind ?? null,
    currentCapture: currentCaptureManifest({ source, attachments: currentAttachments }),
    handwritingCalibration: handwritingManifest(handwriting),
    requiredFinalJson: requiredFinalJsonContract(),
  };
  const text = [
    "You are running Beep Notes agent-owned image-note processing.",
    "You own the whole multimodal processing loop for this note: inspect the native image inputs, use available tools when useful, reason over handwriting calibration samples, and produce the final structured note output.",
    "Return exactly one JSON object and no markdown, code fences, prose, or hidden analysis.",
    "The output must satisfy the requiredFinalJson contract in the manifest. Use `body`, not `text` or `content`; use `kind`, not `type`.",
    "JSON manifest:",
    JSON.stringify(manifest, null, 2),
  ].join("\n");

  return [
    { type: "text", text },
    ...handwritingSamples.map((sample) => clonePart(sample.imagePart)).filter((part) => part?.type === "localImage"),
    ...currentAttachments,
  ];
}

export function recoverableAgentOwnedValidationErrors(
  output,
  { calibrationEnabled = false, sampleIdsProvided = [] } = {},
) {
  const errors = [];
  const readableRenditions = Array.isArray(output?.derivedArtifacts)
    ? output.derivedArtifacts.filter((artifact) => artifact?.kind === "readableRendition")
    : [];
  if (readableRenditions.length === 0) {
    errors.push("Agent-owned image processing must return at least one readableRendition derived artifact.");
  }

  if (
    calibrationEnabled &&
    uniqueStringIds(sampleIdsProvided).length > 0 &&
    uniqueStringIds(output?.handwriting?.sampleIdsUsed).length === 0
  ) {
    errors.push("Calibration was enabled with samples, but the output did not report any handwriting.sampleIdsUsed.");
  }
  return errors;
}

export function normalizeRunSummary(
  rawSummary = {},
  {
    thinking = AGENT_OWNED_THINKING,
    calibrationEnabled = false,
    sampleIdsProvided = [],
    sampleIdsUsed = [],
  } = {},
) {
  const input = isPlainObject(rawSummary) ? rawSummary : {};
  const usedSampleIds = uniqueStringIds(sampleIdsUsed);
  const tools = isPlainObject(input.tools) ? input.tools : {};
  const toolCount = nonnegativeInteger(tools.count);
  return {
    mode: "agentOwned",
    thinking,
    calibration: {
      enabled: Boolean(calibrationEnabled),
      sampleCount: uniqueStringIds(sampleIdsProvided).length,
      sampleIdsUsed: usedSampleIds,
    },
    tools: {
      used: Boolean(tools.used || toolCount > 0),
      count: toolCount,
    },
    attempts: sanitizeAttempts(input.attempts),
    validation: {
      ok: true,
      warnings: sanitizeWarnings(input.validation?.warnings),
    },
  };
}

export function validateAgentOwnedNoteOutput(raw, options = {}) {
  const stageOutput = validateStageOutput(raw);
  const validationErrors = recoverableAgentOwnedValidationErrors(stageOutput, options);
  if (validationErrors.length > 0) {
    const error = new Error("Agent-owned note processing output failed recoverable validation.");
    error.validationErrors = validationErrors;
    throw error;
  }
  return {
    ...stageOutput,
    runSummary: normalizeRunSummary(raw?.runSummary, {
      ...options,
      sampleIdsUsed: stageOutput.handwriting?.sampleIdsUsed,
    }),
  };
}

export function buildAgentOwnedRetryInput({ validationErrors, attemptNumber }) {
  return [
    {
      type: "text",
      text: [
        `Agent-owned image-note processing validation failed after attempt ${attemptNumber}.`,
        "Rework the same note using the native images and file paths already available in this session.",
        "Fix every validation issue. Return final JSON only, with no markdown, code fences, prose, or thinking text.",
        "Validation errors:",
        JSON.stringify({ validationErrors: Array.isArray(validationErrors) ? validationErrors : [] }, null, 2),
      ].join("\n"),
    },
  ];
}
