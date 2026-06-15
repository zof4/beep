import { randomBytes } from "node:crypto";
import { normalizeBeepInput } from "../../../shared/native-input.mjs";
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { NotesBeepGateway } from "./beep-gateway.mjs";
import {
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
} from "./handwriting-domain.mjs";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  NATIVE_NOTES_IMAGE_MIME_TYPES,
  captureMimeTypeFromUpload,
  normalizeUploadedImageMediaFile,
} from "./image-media.mjs";
import { createPipelineRun, runPipeline } from "./pipeline-engine.mjs";
import { readItemForBeep } from "./workspace-domain.mjs";
import { NotesWorkspaceStore } from "./workspace-store.mjs";

const IMAGE_DETAIL_VALUES = new Set(["low", "high", "original", "auto"]);
const MAX_MULTIPART_CAPTURE_BYTES = MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024;

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

function isMultipartFormData(request) {
  return String(request.headers?.["content-type"] || "").toLowerCase().startsWith("multipart/form-data");
}

function multipartBoundary(request) {
  const contentType = String(request.headers?.["content-type"] || "");
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/iu);
  const boundary = (match?.[1] || match?.[2] || "").trim();
  if (!boundary) throw new Error("multipart boundary is required");
  return boundary;
}

async function readRequestBuffer(request, limitBytes) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > limitBytes) {
      const error = new Error("request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

function parseHeaderParameters(value) {
  const parameters = {};
  for (const segment of value.split(";").slice(1)) {
    const [rawKey, ...rawValueParts] = segment.split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key) continue;
    const rawValue = rawValueParts.join("=").trim();
    parameters[key] = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
  }
  return parameters;
}

function parseMultipartHeaders(value) {
  const headers = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function parseMultipartFormData(buffer, boundary) {
  const boundaryMarker = Buffer.from(`--${boundary}`, "utf8");
  const nextBoundaryMarker = Buffer.from(`\r\n--${boundary}`, "utf8");
  let boundaryIndex = buffer.indexOf(boundaryMarker);
  if (boundaryIndex < 0) throw new Error("multipart boundary was not found");
  const parts = [];

  while (boundaryIndex >= 0) {
    let cursor = boundaryIndex + boundaryMarker.length;
    const trailer = buffer.subarray(cursor, cursor + 2).toString("latin1");
    if (trailer === "--") break;
    if (trailer !== "\r\n") throw new Error("invalid multipart boundary");
    cursor += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n", "utf8"), cursor);
    if (headerEnd < 0) throw new Error("invalid multipart part headers");
    const headers = parseMultipartHeaders(buffer.subarray(cursor, headerEnd).toString("latin1"));
    const bodyStart = headerEnd + 4;
    const nextBoundaryIndex = buffer.indexOf(nextBoundaryMarker, bodyStart);
    if (nextBoundaryIndex < 0) throw new Error("multipart closing boundary was not found");

    const disposition = headers["content-disposition"] || "";
    const dispositionParams = parseHeaderParameters(disposition);
    if (dispositionParams.name) {
      parts.push({
        name: dispositionParams.name,
        filename: dispositionParams.filename || "",
        contentType: String(headers["content-type"] || "").trim().toLowerCase(),
        data: buffer.subarray(bodyStart, nextBoundaryIndex),
      });
    }
    boundaryIndex = nextBoundaryIndex + 2;
  }

  return parts;
}

async function localImageInputPartForMediaFile(file, index) {
  const inputFile = requiredPlainObject(file, `media.files[${index}]`);
  const mimeType = String(inputFile.mimeType ?? "").trim().toLowerCase();
  if (!NATIVE_NOTES_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`unsupported image MIME type: ${mimeType || "unknown"}`);
  }
  const detail = normalizeImageDetail(inputFile.detail);
  const path = String(inputFile.workspacePath ?? "").trim();
  if (!path) throw new Error(`media.files[${index}].workspacePath is required`);
  return normalizeBeepInput([
    { type: "text", text: "image capture" },
    { type: "localImage", path, detail },
  ])[1];
}

async function normalizeCaptureInput(body, options = {}) {
  const input = requiredPlainObject(body, "capture body");
  const kind = String(input.kind || "text").trim();
  if (kind === "text") {
    return { ...input, kind, body: String(input.body ?? ""), media: null };
  }
  if (kind === "image") {
    throw new Error("image captures must use multipart/form-data");
  }
  throw new Error(`unsupported source artifact kind: ${kind}`);
}

async function normalizeMultipartCaptureInput(request, options = {}) {
  const body = await readRequestBuffer(request, MAX_MULTIPART_CAPTURE_BYTES);
  const parts = parseMultipartFormData(body, multipartBoundary(request));
  const fields = {};
  const files = [];
  for (const part of parts) {
    if (part.filename) {
      files.push(part);
    } else {
      fields[part.name] = part.data.toString("utf8");
    }
  }
  const kind = String(fields.kind || "image").trim();
  if (kind !== "image") throw new Error("multipart captures must be image captures");
  if (files.length !== 1) throw new Error("image capture multipart body must include one image file");
  const detail = normalizeImageDetail(fields.detail);
  const upload = files[0];
  captureMimeTypeFromUpload(upload);
  const file = await normalizeUploadedImageMediaFile(upload, {
    detail,
    workspaceHostPath: options.workspaceHostPath,
    targetFormat: "jpeg",
    convertHeif: options.convertHeif,
  });
  return {
    ...(String(fields.id ?? "").trim() ? { id: String(fields.id).trim() } : {}),
    kind,
    body: String(fields.body ?? ""),
    media: { schemaVersion: 1, files: [file] },
  };
}

async function normalizeMultipartHandwritingSampleInput(request, options = {}) {
  const body = await readRequestBuffer(request, MAX_MULTIPART_CAPTURE_BYTES);
  const parts = parseMultipartFormData(body, multipartBoundary(request));
  const fields = {};
  const files = [];
  for (const part of parts) {
    if (part.filename) files.push(part);
    else fields[part.name] = part.data.toString("utf8");
  }
  if (files.length !== 1) throw new Error("handwriting sample multipart body must include one image file");
  const referenceText = String(fields.referenceText ?? "").trim();
  if (!referenceText) throw new Error("referenceText is required");
  const file = await normalizeUploadedImageMediaFile(files[0], {
    detail: "original",
    workspaceHostPath: options.workspaceHostPath,
    targetFormat: "png",
    convertHeif: options.convertHeifToPng || options.convertHeifToJpeg,
  });
  return {
    profileId: Object.hasOwn(fields, "profileId") ? String(fields.profileId).trim() : DEFAULT_HANDWRITING_PROFILE_ID,
    promptId: Object.hasOwn(fields, "promptId") ? String(fields.promptId).trim() : DEFAULT_HANDWRITING_PROMPT_ID,
    referenceText,
    file,
  };
}

async function imageInputPartsForSource(source, options = {}) {
  if (source?.kind !== "image") return [];
  const files = Array.isArray(source.media?.files) ? source.media.files : [];
  return Promise.all(files.map((file, index) => localImageInputPartForMediaFile(file, index, options)));
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

function handwritingProfileProjection(notesStore) {
  const workspace = notesStore.readWorkspace();
  const profile = workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID];
  const prompt = workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID];
  const samples = (profile.activeSampleIds || [])
    .map((id) => workspace.handwritingSamples[id])
    .filter(Boolean);
  return { profile, prompt, samples };
}

export async function handleNotesRoute({
  request,
  response,
  pathname,
  store,
  requireOperatorAuth,
  forwardRuntimeRequest,
  notesImageConverter,
  notesWorkspaceHostPath,
}) {
  requireOperatorAuth(request);

  const notesStore = new NotesWorkspaceStore({ store });
  const parts = pathname.split("/").filter(Boolean);

  try {
  if (parts.length === 5 && parts[2] === "handwriting" && parts[3] === "prompts" && parts[4] === "default") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return true;
    }
    sendJson(response, 200, { ok: true, prompt: notesStore.getDefaultHandwritingPrompt() });
    return true;
  }

  if (parts.length === 4 && parts[2] === "handwriting" && parts[3] === "profile") {
    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return true;
    }
    sendJson(response, 200, { ok: true, ...handwritingProfileProjection(notesStore) });
    return true;
  }

  if (parts.length === 4 && parts[2] === "handwriting" && parts[3] === "samples") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    if (!isMultipartFormData(request)) {
      const error = new Error("handwriting samples must use multipart/form-data");
      error.status = 400;
      throw error;
    }
    const input = await normalizeMultipartHandwritingSampleInput(request, {
      workspaceHostPath: notesWorkspaceHostPath,
      convertHeifToPng: notesImageConverter,
    });
    const source = notesStore.createSourceArtifact({
      kind: "image",
      body: "handwriting calibration sample",
      media: { schemaVersion: 1, files: [input.file] },
    });
    const sample = notesStore.createHandwritingSample({
      profileId: input.profileId,
      promptId: input.promptId,
      referenceText: input.referenceText,
      sourceArtifactId: source.id,
      image: input.file,
    });
    sendJson(response, 200, { ok: true, source, sample, ...handwritingProfileProjection(notesStore) });
    return true;
  }

  if (parts.length === 6 && parts[2] === "handwriting" && parts[3] === "samples" && parts[5] === "toggle") {
    if (request.method !== "POST") {
      sendMethodNotAllowed(response);
      return true;
    }
    const body = await readJsonBody(request);
    const sample = notesStore.toggleHandwritingSample(parts[4], { active: body.active });
    sendJson(response, 200, { ok: true, sample, ...handwritingProfileProjection(notesStore) });
    return true;
  }

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
    const input = isMultipartFormData(request)
      ? await normalizeMultipartCaptureInput(request, {
          workspaceHostPath: notesWorkspaceHostPath,
          convertHeif: notesImageConverter,
        })
      : await normalizeCaptureInput(await readJsonBody(request), { convertHeif: notesImageConverter });
    const source = notesStore.createSourceArtifact(input);
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
      context: { attachments: await imageInputPartsForSource(source, { convertHeif: notesImageConverter }) },
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
