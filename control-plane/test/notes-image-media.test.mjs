import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_IMAGE_UPLOAD_BYTES,
  captureMimeTypeFromUpload,
  normalizeUploadedImageMediaFile,
} from "../src/notes/image-media.mjs";

test("captureMimeTypeFromUpload recognizes HEIC and HEIF filenames", () => {
  assert.equal(
    captureMimeTypeFromUpload({ filename: "IMG_1001.HEIC", headers: {}, data: Buffer.from("x") }),
    "image/heic",
  );
  assert.equal(
    captureMimeTypeFromUpload({ filename: "IMG_1002.heif", headers: {}, data: Buffer.from("x") }),
    "image/heif",
  );
});

test("captureMimeTypeFromUpload strips content type parameters", () => {
  assert.equal(
    captureMimeTypeFromUpload({
      filename: "whiteboard.png",
      headers: { "content-type": "IMAGE/PNG; charset=binary" },
      data: Buffer.from("x"),
    }),
    "image/png",
  );
});

test("captureMimeTypeFromUpload rejects unsupported image media with 415 status", () => {
  assert.throws(
    () =>
      captureMimeTypeFromUpload({
        filename: "bad.gif",
        headers: { "content-type": "image/gif" },
        data: Buffer.from("GIF89a"),
      }),
    (error) => {
      assert.equal(error.status, 415);
      assert.match(error.message, /unsupported image MIME type: image\/gif/u);
      return true;
    },
  );
});

test("handwriting HEIC uploads convert to PNG workspace images", async () => {
  const workspaceHostPath = await mkdtemp(join(tmpdir(), "beep-notes-image-media-"));
  try {
    const original = Buffer.from("fake-heic");
    const png = Buffer.from("converted-png");
    const file = await normalizeUploadedImageMediaFile(
      { filename: "IMG_1001.HEIC", headers: { "content-type": "image/heic" }, data: original },
      {
        detail: "original",
        workspaceHostPath,
        targetFormat: "png",
        convertHeif: async () => ({ mimeType: "image/png", data: png }),
      },
    );

    assert.equal(file.name, "IMG_1001.png");
    assert.equal(file.mimeType, "image/png");
    assert.equal(file.originalName, "IMG_1001.HEIC");
    assert.equal(file.originalMimeType, "image/heic");
    assert.equal(file.convertedFrom, "image/heic");
    assert.match(file.workspacePath, /^notes-captures\/.+\.png$/u);
    assert.deepEqual(await readFile(join(workspaceHostPath, file.workspacePath)), png);
  } finally {
    await rm(workspaceHostPath, { recursive: true, force: true });
  }
});

test("ordinary HEIC uploads keep JPEG conversion policy", async () => {
  const workspaceHostPath = await mkdtemp(join(tmpdir(), "beep-notes-image-media-"));
  try {
    const original = Buffer.from("fake-heic");
    const jpeg = Buffer.from("converted-jpeg");
    const file = await normalizeUploadedImageMediaFile(
      { filename: "IMG_1001.HEIC", headers: { "content-type": "image/heic" }, data: original },
      {
        detail: "auto",
        workspaceHostPath,
        targetFormat: "jpeg",
        convertHeif: async () => ({ mimeType: "image/jpeg", data: jpeg }),
      },
    );

    assert.equal(file.name, "IMG_1001.jpg");
    assert.equal(file.mimeType, "image/jpeg");
    assert.match(file.workspacePath, /^notes-captures\/.+\.jpg$/u);
  } finally {
    await rm(workspaceHostPath, { recursive: true, force: true });
  }
});

test("PNG-targeted HEIC conversion rejects injected JPEG output without writing a file", async () => {
  const workspaceHostPath = await mkdtemp(join(tmpdir(), "beep-notes-image-media-"));
  try {
    await assert.rejects(
      normalizeUploadedImageMediaFile(
        {
          filename: "IMG_1001.HEIC",
          headers: { "content-type": "image/heic" },
          data: Buffer.from("fake-heic"),
        },
        {
          detail: "original",
          workspaceHostPath,
          targetFormat: "png",
          convertHeif: async () => ({ mimeType: "image/jpeg", data: Buffer.from("converted-jpeg") }),
        },
      ),
      /converted image MIME type image\/jpeg does not match requested image\/png/u,
    );
    await assert.rejects(readdir(join(workspaceHostPath, "notes-captures")), { code: "ENOENT" });
  } finally {
    await rm(workspaceHostPath, { recursive: true, force: true });
  }
});

test("HEIC converter receives requested target context", async () => {
  const workspaceHostPath = await mkdtemp(join(tmpdir(), "beep-notes-image-media-"));
  const converterCalls = [];
  try {
    await normalizeUploadedImageMediaFile(
      { filename: "IMG_1001.HEIC", headers: { "content-type": "image/heic" }, data: Buffer.from("fake-heic") },
      {
        detail: "original",
        workspaceHostPath,
        targetFormat: "png",
        convertHeif: async (input) => {
          converterCalls.push(input);
          return { mimeType: "image/png", data: Buffer.from("converted-png") };
        },
      },
    );

    assert.equal(converterCalls.length, 1);
    assert.equal(converterCalls[0].name, "IMG_1001.HEIC");
    assert.equal(converterCalls[0].detail, "original");
    assert.equal(converterCalls[0].targetFormat, "png");
    assert.equal(converterCalls[0].targetMimeType, "image/png");
  } finally {
    await rm(workspaceHostPath, { recursive: true, force: true });
  }
});

test("oversized original HEIC uploads are rejected before conversion", async () => {
  const workspaceHostPath = await mkdtemp(join(tmpdir(), "beep-notes-image-media-"));
  let converterCalled = false;
  try {
    await assert.rejects(
      normalizeUploadedImageMediaFile(
        {
          filename: "IMG_1001.HEIC",
          headers: { "content-type": "image/heic" },
          data: Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1),
        },
        {
          workspaceHostPath,
          targetFormat: "jpeg",
          convertHeif: async () => {
            converterCalled = true;
            return { mimeType: "image/jpeg", data: Buffer.from("converted-jpeg") };
          },
        },
      ),
      (error) => {
        assert.equal(error.status, 413);
        assert.match(error.message, /image file must be 40 MiB or smaller/u);
        return true;
      },
    );
    assert.equal(converterCalled, false);
    await assert.rejects(readdir(join(workspaceHostPath, "notes-captures")), { code: "ENOENT" });
  } finally {
    await rm(workspaceHostPath, { recursive: true, force: true });
  }
});

test("oversized converted HEIC output is rejected before writing a file", async () => {
  const workspaceHostPath = await mkdtemp(join(tmpdir(), "beep-notes-image-media-"));
  try {
    await assert.rejects(
      normalizeUploadedImageMediaFile(
        {
          filename: "IMG_1001.HEIC",
          headers: { "content-type": "image/heic" },
          data: Buffer.from("fake-heic"),
        },
        {
          workspaceHostPath,
          targetFormat: "jpeg",
          convertHeif: async () => ({ mimeType: "image/jpeg", data: Buffer.alloc(MAX_IMAGE_UPLOAD_BYTES + 1) }),
        },
      ),
      (error) => {
        assert.equal(error.status, 413);
        assert.match(error.message, /image file must be 40 MiB or smaller after conversion/u);
        return true;
      },
    );
    await assert.rejects(readdir(join(workspaceHostPath, "notes-captures")), { code: "ENOENT" });
  } finally {
    await rm(workspaceHostPath, { recursive: true, force: true });
  }
});
