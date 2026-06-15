import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

export const NATIVE_NOTES_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const HEIF_IMAGE_MIME_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
export const NOTES_IMAGE_MIME_TYPES = new Set([...NATIVE_NOTES_IMAGE_MIME_TYPES, ...HEIF_IMAGE_MIME_TYPES]);
export const MAX_IMAGE_UPLOAD_BYTES = 40 * 1024 * 1024;
export const NOTES_CAPTURE_WORKSPACE_DIR = "notes-captures";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function unsupportedImageMimeTypeError(mimeType) {
  const error = new Error(`unsupported image MIME type: ${mimeType || "unknown"}`);
  error.status = 415;
  return error;
}

function imageSizeError(message) {
  const error = new Error(message);
  error.status = 413;
  return error;
}

function contentTypeHeader(upload) {
  const headers = upload?.headers;
  if (headers && typeof headers === "object") {
    if (headers["content-type"] !== undefined) return headers["content-type"];
    const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === "content-type");
    if (headerKey) return headers[headerKey];
  }
  return upload?.contentType ?? "";
}

function stripContentTypeParameters(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function mimeTypeFromFilename(filename) {
  const name = String(filename || "").trim().toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return "";
}

function enforceImageUploadSize(data, message) {
  if (data.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw imageSizeError(message);
  }
}

function heifFileExtension(mimeType) {
  return String(mimeType || "").includes("heic") ? ".heic" : ".heif";
}

function randomCaptureName(mimeType) {
  return `capture_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}${fileExtensionForMimeType(mimeType)}`;
}

function convertedUploadName(originalName, mimeType) {
  const extension = fileExtensionForMimeType(mimeType);
  const baseName = String(originalName || "image").replace(/\.(?:heic|heif)$/iu, "") || "image";
  return `${baseName}${extension}`;
}

function normalizeConverterOutput(output) {
  const mimeType = String(output?.mimeType ?? "").trim().toLowerCase();
  if (!NATIVE_NOTES_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`unsupported converted image MIME type: ${mimeType || "unknown"}`);
  }
  const data = output?.data ?? output?.buffer;
  if (!Buffer.isBuffer(data)) {
    throw new Error("converted image data must be a Buffer");
  }
  return { mimeType, data };
}

function runSipsImageConversion({ inputPath, outputPath, target }) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/sips", ["-s", "format", target, inputPath, "--out", outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error((stderr || stdout || `sips exited with ${code}`).trim()));
    });
  });
}

async function convertHeifWithSips({ mimeType, data }, target) {
  const dir = await mkdtemp(join(tmpdir(), "beep-notes-heif-"));
  const inputPath = join(dir, `capture${heifFileExtension(mimeType)}`);
  const outputMimeType = target === "png" ? "image/png" : "image/jpeg";
  const outputPath = join(dir, `capture${fileExtensionForMimeType(outputMimeType)}`);
  try {
    await writeFile(inputPath, data);
    await runSipsImageConversion({ inputPath, outputPath, target });
    const converted = await readFile(outputPath);
    enforceImageUploadSize(converted, "image file must be 40 MiB or smaller after conversion");
    return { mimeType: outputMimeType, data: converted };
  } catch (error) {
    if (error?.status) throw error;
    throw new Error(`invalid HEIF image data: ${errorMessage(error)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function captureMimeTypeFromUpload(upload) {
  const headerMimeType = stripContentTypeParameters(contentTypeHeader(upload));
  if (NOTES_IMAGE_MIME_TYPES.has(headerMimeType)) return headerMimeType;

  const filenameMimeType = mimeTypeFromFilename(upload?.filename);
  if (NOTES_IMAGE_MIME_TYPES.has(filenameMimeType)) return filenameMimeType;

  throw unsupportedImageMimeTypeError(headerMimeType || filenameMimeType);
}

export function fileExtensionForMimeType(mimeType) {
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  if (normalizedMimeType === "image/png") return ".png";
  if (normalizedMimeType === "image/jpeg") return ".jpg";
  if (normalizedMimeType === "image/webp") return ".webp";
  if (normalizedMimeType.includes("heic")) return ".heic";
  if (normalizedMimeType.includes("heif")) return ".heif";
  throw unsupportedImageMimeTypeError(normalizedMimeType);
}

export async function convertHeifToJpegWithSips({ mimeType, data }) {
  return convertHeifWithSips({ mimeType, data }, "jpeg");
}

export async function convertHeifToPngWithSips({ mimeType, data }) {
  return convertHeifWithSips({ mimeType, data }, "png");
}

export async function writeWorkspaceCaptureFile({ workspaceHostPath, mimeType, data }) {
  if (typeof workspaceHostPath !== "string" || workspaceHostPath.trim() === "") {
    throw new Error("notes workspace host path is required for image captures");
  }
  if (!NATIVE_NOTES_IMAGE_MIME_TYPES.has(mimeType)) {
    throw unsupportedImageMimeTypeError(mimeType);
  }

  const name = randomCaptureName(mimeType);
  const workspacePath = posix.join(NOTES_CAPTURE_WORKSPACE_DIR, name);
  const hostPath = join(workspaceHostPath, workspacePath);
  await mkdir(join(workspaceHostPath, NOTES_CAPTURE_WORKSPACE_DIR), { recursive: true });
  await writeFile(hostPath, data);
  return { workspacePath, hostPath, name, mimeType, sizeBytes: data.byteLength };
}

export async function normalizeUploadedImageMediaFile(upload, options = {}) {
  const originalName = String(upload?.filename || "image").trim() || "image";
  const originalMimeType = captureMimeTypeFromUpload(upload);
  if (!Buffer.isBuffer(upload?.data)) {
    throw new Error("image file data must be a Buffer");
  }
  enforceImageUploadSize(upload.data, "image file must be 40 MiB or smaller");

  let mimeType = originalMimeType;
  let data = upload.data;
  if (HEIF_IMAGE_MIME_TYPES.has(originalMimeType)) {
    const targetFormat = options.targetFormat || "jpeg";
    if (targetFormat !== "jpeg" && targetFormat !== "png") {
      throw new Error("image target format must be jpeg or png");
    }
    const convertHeif =
      options.convertHeif || (targetFormat === "png" ? convertHeifToPngWithSips : convertHeifToJpegWithSips);
    const converted = normalizeConverterOutput(
      await convertHeif({
        mimeType: originalMimeType,
        data: upload.data,
        detail: options.detail,
        name: originalName,
      }),
    );
    mimeType = converted.mimeType;
    data = converted.data;
  }
  enforceImageUploadSize(data, "image file must be 40 MiB or smaller after conversion");

  const workspaceFile = await writeWorkspaceCaptureFile({ workspaceHostPath: options.workspaceHostPath, mimeType, data });
  const converted = originalMimeType !== mimeType;
  return {
    kind: "image",
    name: converted ? convertedUploadName(originalName, mimeType) : originalName,
    mimeType,
    sizeBytes: workspaceFile.sizeBytes,
    detail: options.detail,
    workspacePath: workspaceFile.workspacePath,
    ...(converted
      ? {
          originalName,
          originalMimeType,
          originalSizeBytes: upload.data.byteLength,
          convertedFrom: originalMimeType,
        }
      : {}),
  };
}
