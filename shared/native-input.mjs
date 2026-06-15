import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_DETAIL_VALUES = new Set(["low", "high", "original", "auto"]);
const DEFAULT_MAX_PARTS = 64;
const DEFAULT_MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_INLINE_IMAGE_BYTES = 24 * 1024 * 1024;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function normalizeDetail(value, index) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !IMAGE_DETAIL_VALUES.has(value)) {
    throw new Error(`input[${index}].detail must be one of low, high, original, or auto.`);
  }
  return value;
}

function getBase64DecodedByteLength(value, index) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    (value.includes("=") && value.length % 4 !== 0) ||
    (!value.includes("=") && value.length % 4 === 1)
  ) {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const fullQuartets = Math.floor(value.length / 4);
  const remainder = value.length % 4;
  const byteLength = fullQuartets * 3 - paddingLength + (paddingLength === 0 && remainder > 0 ? remainder - 1 : 0);
  if (byteLength <= 0) {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  return byteLength;
}

function assertCanonicalBase64(value, index) {
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  if (
    decoded.length === 0 ||
    decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")
  ) {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
}

function assertBase64(value, index) {
  const byteLength = getBase64DecodedByteLength(value, index);
  assertCanonicalBase64(value, index);
  return byteLength;
}

function assertHttpsUrl(value, index) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input[${index}].url must be an absolute https URL.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`input[${index}].url must be an absolute https URL.`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error(`input[${index}].url must be an absolute https URL.`);
  }
  return parsed.toString();
}

function parsePositiveIntegerOption(options, name, defaultValue) {
  const value = options[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function assertWorkspaceRelativePath(value, index) {
  const segments = value.split(/[\\/]+/u);
  let depth = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) {
        throw new Error(`input[${index}].path must stay inside the active workspace.`);
      }
      depth -= 1;
      continue;
    }
    depth += 1;
  }
}

function assertLocalImagePathShape(value, index, { allowAbsolute }) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input[${index}].path must be a non-empty workspace path.`);
  }
  if (value.includes("\0") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    throw new Error(`input[${index}].path must be a workspace path.`);
  }
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value)) {
    throw new Error(`input[${index}].path must stay inside the active workspace.`);
  }
  if (isAbsolute(value)) {
    if (allowAbsolute) return;
    throw new Error(`input[${index}].path must stay inside the active workspace.`);
  }
  assertWorkspaceRelativePath(value, index);
}

function normalizeLocalImagePath(value, index, workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    assertLocalImagePathShape(value, index, { allowAbsolute: false });
    return value;
  }
  assertLocalImagePathShape(value, index, { allowAbsolute: true });
  const root = resolve(workspaceRoot);
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  let realRoot;
  let realPath;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new Error("workspaceRoot must point to an existing workspace directory.");
  }
  if (!statSync(realRoot).isDirectory()) {
    throw new Error("workspaceRoot must point to an existing workspace directory.");
  }
  try {
    realPath = realpathSync(path);
  } catch {
    throw new Error(`input[${index}].path must point to an existing workspace file.`);
  }
  const rel = relative(realRoot, realPath);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/u.test(rel)) {
    throw new Error(`input[${index}].path must stay inside the active workspace.`);
  }
  if (!statSync(realPath).isFile()) {
    throw new Error(`input[${index}].path must point to an existing workspace file.`);
  }
  return realPath;
}

function normalizePublicBeepInput(input, { allowEmpty = false } = {}) {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) {
    throw new Error("input must contain at least one part.");
  }
  return input.map((part, index) => {
    if (!isPlainObject(part)) {
      throw new Error(`input[${index}] must be an object.`);
    }
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.trim() === "") {
        throw new Error(`input[${index}] contains empty text.`);
      }
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      const hasData = hasOwn(part, "data");
      const hasUrl = hasOwn(part, "url");
      if (hasData === hasUrl) {
        throw new Error(`input[${index}] image part must contain exactly one of data or url.`);
      }
      if (hasUrl) {
        const detail = normalizeDetail(part.detail, index);
        return { type: "image", url: assertHttpsUrl(part.url, index), ...(detail ? { detail } : {}) };
      }
      if (!IMAGE_MIME_TYPES.has(part.mimeType)) {
        throw new Error(`input[${index}].mimeType must be image/png, image/jpeg, image/webp, or image/gif.`);
      }
      assertBase64(part.data, index);
      const detail = normalizeDetail(part.detail, index);
      return { type: "image", mimeType: part.mimeType, data: part.data, ...(detail ? { detail } : {}) };
    }
    if (part.type === "localImage") {
      if (typeof part.path !== "string" || part.path.trim() === "" || part.path.includes("\0")) {
        throw new Error(`input[${index}].path must be a non-empty workspace path.`);
      }
      const detail = normalizeDetail(part.detail, index);
      return { type: "localImage", path: part.path, ...(detail ? { detail } : {}) };
    }
    throw new Error(`input[${index}] must be text, image, or localImage.`);
  });
}

export function normalizeBeepInput(rawInput, options = {}) {
  const config = options ?? {};
  const maxParts = parsePositiveIntegerOption(config, "maxParts", DEFAULT_MAX_PARTS);
  const maxInlineImageBytes = parsePositiveIntegerOption(config, "maxInlineImageBytes", DEFAULT_MAX_INLINE_IMAGE_BYTES);
  const maxTotalInlineImageBytes = parsePositiveIntegerOption(config, "maxTotalInlineImageBytes", DEFAULT_MAX_TOTAL_INLINE_IMAGE_BYTES);
  if (!Array.isArray(rawInput) || rawInput.length === 0) {
    throw new Error("input must contain at least one part.");
  }
  if (rawInput.length > maxParts) {
    throw new Error(`input must contain at most ${maxParts} parts.`);
  }

  let totalInlineBytes = 0;
  return rawInput.map((part, index) => {
    if (!isPlainObject(part)) {
      throw new Error(`input[${index}] must be an object.`);
    }
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.trim() === "") {
        throw new Error(`input[${index}] contains empty text.`);
      }
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      const hasData = hasOwn(part, "data");
      const hasUrl = hasOwn(part, "url");
      if (hasData === hasUrl) {
        throw new Error(`input[${index}] image part must contain exactly one of data or url.`);
      }
      if (hasUrl) {
        const detail = normalizeDetail(part.detail, index);
        return { type: "image", url: assertHttpsUrl(part.url, index), ...(detail ? { detail } : {}) };
      }
      if (!IMAGE_MIME_TYPES.has(part.mimeType)) {
        throw new Error(`input[${index}].mimeType must be image/png, image/jpeg, image/webp, or image/gif.`);
      }
      const byteLength = getBase64DecodedByteLength(part.data, index);
      if (byteLength > maxInlineImageBytes) {
        throw new Error(`input[${index}] inline image exceeds ${maxInlineImageBytes} bytes.`);
      }
      totalInlineBytes += byteLength;
      if (totalInlineBytes > maxTotalInlineImageBytes) {
        throw new Error(`input inline images exceed ${maxTotalInlineImageBytes} bytes total.`);
      }
      assertCanonicalBase64(part.data, index);
      const detail = normalizeDetail(part.detail, index);
      return { type: "image", mimeType: part.mimeType, data: part.data, ...(detail ? { detail } : {}) };
    }
    if (part.type === "localImage") {
      const detail = normalizeDetail(part.detail, index);
      return { type: "localImage", path: normalizeLocalImagePath(part.path, index, config.workspaceRoot), ...(detail ? { detail } : {}) };
    }
    throw new Error(`input[${index}] must be text, image, or localImage.`);
  });
}

export function summarizeBeepInput(input) {
  const normalized = normalizePublicBeepInput(input);
  const textParts = normalized.filter((part) => part.type === "text");
  const imageParts = [];
  let totalInlineImageBytes = 0;
  normalized.forEach((part, index) => {
    if (part.type === "image" && hasOwn(part, "data")) {
      const byteLength = getBase64DecodedByteLength(part.data, index);
      totalInlineImageBytes += byteLength;
      imageParts.push({ index, source: "inline", mimeType: part.mimeType, byteLength, detail: part.detail || "auto" });
    } else if (part.type === "image" && hasOwn(part, "url")) {
      imageParts.push({ index, source: "url", url: part.url, detail: part.detail || "auto" });
    } else if (part.type === "localImage") {
      imageParts.push({ index, source: "local", path: part.path, detail: part.detail || "auto" });
    }
  });
  const textPreview = textParts.map((part) => part.text.trim()).join(" ").replace(/\s+/gu, " ").slice(0, 240);
  return {
    partCount: normalized.length,
    textPartCount: textParts.length,
    imagePartCount: imageParts.filter((part) => part.source !== "local").length,
    localImagePartCount: imageParts.filter((part) => part.source === "local").length,
    totalInlineImageBytes,
    textPreview,
    imageParts,
  };
}

export function redactBeepInput(input) {
  return normalizePublicBeepInput(input, { allowEmpty: true }).map((part, index) => {
    if (part.type === "image" && hasOwn(part, "data")) {
      return {
        type: "image",
        mimeType: part.mimeType,
        byteLength: getBase64DecodedByteLength(part.data, index),
        detail: part.detail || "auto",
        data: "[redacted]",
      };
    }
    if (part.type === "image" && hasOwn(part, "url")) {
      return { type: "image", url: part.url, detail: part.detail || "auto" };
    }
    if (part.type === "localImage") {
      return { type: "localImage", path: part.path, detail: part.detail || "auto" };
    }
    return { type: "text", text: part.text };
  });
}

export function labelBeepInput(input) {
  const summary = summarizeBeepInput(input);
  const imageCount = summary.imagePartCount + summary.localImagePartCount;
  const base = summary.textPreview || `${summary.partCount} input parts`;
  return imageCount > 0 ? `${base} (${imageCount} ${imageCount === 1 ? "image" : "images"})` : base;
}
