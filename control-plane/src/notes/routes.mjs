import { randomBytes } from "node:crypto";
import { normalizeBeepInput } from "../../../shared/native-input.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { NotesBeepGateway } from "./beep-gateway.mjs";
import { createPipelineRun, runPipeline } from "./pipeline-engine.mjs";
import { readItemForBeep } from "./workspace-domain.mjs";
import { NotesWorkspaceStore } from "./workspace-store.mjs";

const NOTES_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_DETAIL_VALUES = new Set(["low", "high", "original", "auto"]);
const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;

function newRouteId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

function sendMethodNotAllowed(response) {
  sendJson(response, 405, { ok: false, error: "method not allowed" });
}

function sendUnknown(response, label, id) {
  sendJson(response, 404, { ok: false, error: `Unknown ${label}: ${id}` });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function explicitClientStatus(error) {
  const status = error?.status;
  return Number.isInteger(status) && status >= 400 && status <= 499 ? status : null;
}

function expectedNotesErrorStatus(error) {
  const explicitStatus = explicitClientStatus(error);
  if (explicitStatus) return explicitStatus;

  const message = errorMessage(error);
  if (/^unknown (?:item|proposal|source artifact|run): /u.test(message)) return 404;
  if (/^proposal is not pending: /u.test(message)) return 409;
  if (/^proposal kind cannot be promoted: /u.test(message)) return 400;
  if (/^duplicate /u.test(message)) return 409;
  if (
    /(?: is required| must be | entries must be |^unsupported |^unsafe state map key: |^invalid )/u.test(message)
  ) {
    return 400;
  }
  return null;
}

function sendExpectedNotesError(response, error) {
  const status = expectedNotesErrorStatus(error);
  if (!status) return false;
  sendJson(response, status, { ok: false, error: errorMessage(error) });
  return true;
}

function titleFromText(text, fallback) {
  const normalized = String(text ?? "").trim().replace(/\s+/gu, " ");
  if (!normalized) return fallback;
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredPlainObject(value, fieldName) {
  if (!isPlainObject(value)) throw new Error(`${fieldName} must be an object`);
  return value;
}

function normalizeImageDetail(value) {
  if (value === undefined || value === null || value === "") return "auto";
  const detail = String(value).trim();
  if (!IMAGE_DETAIL_VALUES.has(detail)) throw new Error("image detail must be low, high, original, or auto");
  return detail;
}

function parseImageDataUrl(value, expectedMimeType) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("invalid image data URL");
  }
  const match = value.trim().match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u);
  if (!match) throw new Error("invalid image data URL");
  const mimeType = match[1].toLowerCase();
  if (mimeType !== expectedMimeType) {
    throw new Error(`invalid image data URL MIME: expected ${expectedMimeType}`);
  }
  return { mimeType, data: match[2] };
}

function nativeImageInputPartForMediaFile(file, index) {
  const inputFile = requiredPlainObject(file, `media.files[${index}]`);
  const mimeType = String(inputFile.mimeType ?? "").trim().toLowerCase();
  if (!NOTES_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`unsupported image MIME type: ${mimeType || "unknown"}`);
  }
  const detail = normalizeImageDetail(inputFile.detail);
  const { data } = parseImageDataUrl(inputFile.dataUrl, mimeType);
  try {
    const normalized = normalizeBeepInput(
      [
        { type: "text", text: "image capture" },
        { type: "image", mimeType, data, detail },
      ],
      {
        maxInlineImageBytes: MAX_INLINE_IMAGE_BYTES,
        maxTotalInlineImageBytes: MAX_INLINE_IMAGE_BYTES,
      },
    );
    return normalized[1];
  } catch (error) {
    throw new Error(`invalid image data: ${errorMessage(error)}`);
  }
}

function normalizeImageMediaFile(file, index) {
  const inputFile = requiredPlainObject(file, `media.files[${index}]`);
  const part = nativeImageInputPartForMediaFile(inputFile, index);
  return {
    kind: "image",
    name: String(inputFile.name ?? "image").trim() || "image",
    mimeType: part.mimeType,
    sizeBytes: Buffer.from(part.data, "base64").length,
    dataUrl: `data:${part.mimeType};base64,${part.data}`,
    detail: part.detail || "auto",
  };
}

function normalizeImageCaptureMedia(media) {
  const inputMedia = requiredPlainObject(media, "image capture media");
  if (!Array.isArray(inputMedia.files) || inputMedia.files.length !== 1) {
    throw new Error("image capture media.files must be one image file");
  }
  return {
    schemaVersion: 1,
    files: [normalizeImageMediaFile(inputMedia.files[0], 0)],
  };
}

function normalizeCaptureInput(body) {
  const input = requiredPlainObject(body, "capture body");
  const kind = String(input.kind || "text").trim();
  if (kind === "text") {
    return { ...input, kind, body: String(input.body ?? ""), media: null };
  }
  if (kind === "image") {
    return { ...input, kind, body: String(input.body ?? ""), media: normalizeImageCaptureMedia(input.media) };
  }
  throw new Error(`unsupported source artifact kind: ${kind}`);
}

function imageInputPartsForSource(source) {
  if (source?.kind !== "image") return [];
  const files = Array.isArray(source.media?.files) ? source.media.files : [];
  return files.map((file, index) => nativeImageInputPartForMediaFile(file, index));
}

function replayFor(item) {
  const title = titleFromText(item.title || item.body, "Follow up on note");
  const body = item.contentHidden ? "This item's content is locked and hidden from Beep." : item.body || title;
  const commentBody = item.contentHidden
    ? "This item is locked, so Beep can only suggest a privacy-safe follow-up."
    : "This note has a clear follow-up Beep can help track.";
  return {
    readContext: {},
    agentCommentary: {
      comments: [
        {
          targetId: item.id,
          body: commentBody,
          sourceItemIds: [item.id],
        },
      ],
    },
    draftExtraction: {
      proposals: [
        {
          kind: "todo",
          title,
          body,
          sourceItemIds: [item.id],
          confidence: 0.86,
        },
      ],
    },
  };
}

function replayForSource(source) {
  const title = titleFromText(source.body, "Follow up on capture");
  return {
    readableRendition: {
      derivedArtifacts: [
        {
          kind: "readableRendition",
          body: source.body || title,
          sourceArtifactIds: [source.id],
        },
      ],
    },
    formattedNote: {},
    agentCommentary: {},
    draftExtraction: {
      proposals: [
        {
          kind: "todo",
          title,
          body: source.body || title,
          sourceArtifactIds: [source.id],
          confidence: 0.82,
        },
      ],
    },
    plannerPass: {},
  };
}

function materializeOutputs(notesStore, run) {
  const derivedArtifacts = run.outputs.derivedArtifacts.map((artifact) =>
    notesStore.createDerivedArtifact({
      ...artifact,
      sourceItemIds: artifact.sourceItemIds || (run.targetItemId ? [run.targetItemId] : []),
    }),
  );
  const comments = run.outputs.comments.map((comment) => notesStore.createComment(comment));
  const proposals = run.outputs.proposals.map((proposal) => notesStore.createProposal(proposal));
  return { derivedArtifacts, comments, proposals };
}

function gatewayFor({ body, replay, forwardRuntimeRequest }) {
  if (body.beepMode === "localAgent") {
    return new NotesBeepGateway({
      mode: "localAgent",
      submitToAgent: async ({ input }) =>
        forwardRuntimeRequest("/agent/submit", {
          method: "POST",
          body: { input, waitForCompletion: true },
        }),
    });
  }

  return new NotesBeepGateway({ mode: "replay", replay });
}

async function runNotesPipeline({ notesStore, body, replay, forwardRuntimeRequest, runInput, context = {} }) {
  const run = createPipelineRun({
    id: newRouteId("run"),
    reviewPolicy: body.reviewPolicy,
    ...runInput,
  });
  const completedRun = await runPipeline(run, {
    gateway: gatewayFor({ body, replay, forwardRuntimeRequest }),
    context,
  });
  const materialized = materializeOutputs(notesStore, completedRun);
  const storedRun = notesStore.upsertRun(completedRun);
  return { run: storedRun, ...materialized };
}

function linkedRecords(records, ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => records[id]).filter(Boolean);
}

function attachedLayers(workspace, item) {
  return {
    comments: linkedRecords(workspace.comments, item.agentCommentIds),
    proposals: linkedRecords(workspace.proposals, item.proposalIds),
    derivedArtifacts: linkedRecords(workspace.derivedArtifacts, item.derivedArtifactIds),
    sourceArtifacts: linkedRecords(workspace.sourceArtifacts, item.sourceArtifactIds),
  };
}

export async function handleNotesRoute({ request, response, pathname, store, requireOperatorAuth, forwardRuntimeRequest }) {
  requireOperatorAuth(request);

  const notesStore = new NotesWorkspaceStore({ store });
  const parts = pathname.split("/").filter(Boolean);

  try {
  if (parts.length === 3 && parts[2] === "workspace") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return true;
    }
    sendJson(response, 200, { ok: true, workspace: notesStore.readWorkspace() });
    return true;
  }

  if (parts.length === 3 && parts[2] === "items") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const body = await readJsonBody(request);
    const item = notesStore.createItem(body);
    sendJson(response, 200, { ok: true, item });
    return true;
  }

  if (parts.length === 4 && parts[2] === "items") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return true;
    }
    const item = notesStore.getItem(parts[3]);
    if (!item) {
      sendUnknown(response, "item", parts[3]);
      return true;
    }
    const workspace = notesStore.readWorkspace();
    sendJson(response, 200, { ok: true, item, ...attachedLayers(workspace, item) });
    return true;
  }

  if (parts.length === 5 && parts[2] === "items" && parts[4] === "lock") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const item = notesStore.lockItem(parts[3]);
    sendJson(response, 200, { ok: true, item });
    return true;
  }

  if (parts.length === 5 && parts[2] === "items" && parts[4] === "unlock") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const item = notesStore.unlockItem(parts[3]);
    sendJson(response, 200, { ok: true, item });
    return true;
  }

  if (parts.length === 5 && parts[2] === "items" && parts[4] === "ask-beep") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const body = await readJsonBody(request);
    const item = notesStore.getItem(parts[3]);
    if (!item) {
      sendUnknown(response, "item", parts[3]);
      return true;
    }
    const result = await runNotesPipeline({
      notesStore,
      body,
      replay: replayFor(readItemForBeep(item)),
      forwardRuntimeRequest,
      runInput: { kind: "askBeep", targetItemId: item.id },
    });
    sendJson(response, 200, { ok: true, ...result });
    return true;
  }

  if (parts.length === 3 && parts[2] === "captures") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const body = await readJsonBody(request);
    const source = notesStore.createSourceArtifact(normalizeCaptureInput(body));
    sendJson(response, 200, { ok: true, source });
    return true;
  }

  if (parts.length === 5 && parts[2] === "captures" && parts[4] === "process") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const body = await readJsonBody(request);
    const workspace = notesStore.readWorkspace();
    const source = Object.hasOwn(workspace.sourceArtifacts, parts[3]) ? workspace.sourceArtifacts[parts[3]] : null;
    if (!source) {
      sendUnknown(response, "source artifact", parts[3]);
      return true;
    }
    const result = await runNotesPipeline({
      notesStore,
      body,
      replay: replayForSource(source),
      forwardRuntimeRequest,
      runInput: { kind: "processNote", sourceArtifactId: source.id },
      context: { attachments: imageInputPartsForSource(source) },
    });
    sendJson(response, 200, { ok: true, ...result });
    return true;
  }

  if (parts.length === 5 && parts[2] === "proposals" && parts[4] === "accept") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const accepted = notesStore.acceptProposal(parts[3]);
    sendJson(response, 200, { ok: true, ...accepted });
    return true;
  }

  if (parts.length === 5 && parts[2] === "proposals" && parts[4] === "reject") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const proposal = notesStore.rejectProposal(parts[3]);
    sendJson(response, 200, { ok: true, proposal });
    return true;
  }

  if (parts.length === 4 && parts[2] === "runs") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return true;
    }
    const workspace = notesStore.readWorkspace();
    const run = Object.hasOwn(workspace.runs, parts[3]) ? workspace.runs[parts[3]] : null;
    if (!run) {
      sendUnknown(response, "run", parts[3]);
      return true;
    }
    sendJson(response, 200, { ok: true, run });
    return true;
  }

  return false;
  } catch (error) {
    if (sendExpectedNotesError(response, error)) return true;
    throw error;
  }
}
