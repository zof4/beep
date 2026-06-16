import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labelBeepInput,
  normalizeBeepInput,
  redactBeepInput,
  summarizeBeepInput,
} from "../shared/native-input.mjs";

test("normalizes text, base64 image, remote image, and local image parts", () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-native-input-"));
  try {
    const screenshotPath = join(workspace, "screen.png");
    writeFileSync(screenshotPath, Buffer.from("png bytes"));

    const input = normalizeBeepInput(
      [
        { type: "text", text: "What changed?" },
        { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
        { type: "image", url: "https://example.com/screen.webp", detail: "low" },
        { type: "localImage", path: screenshotPath, detail: "original" },
      ],
      { workspaceRoot: workspace },
    );

    assert.deepEqual(input, [
      { type: "text", text: "What changed?" },
      { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
      { type: "image", url: "https://example.com/screen.webp", detail: "low" },
      { type: "localImage", path: realpathSync(screenshotPath), detail: "original" },
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects empty input, blank text, invalid base64, non-https URLs, and escaped local paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-native-input-"));
  try {
    assert.throws(() => normalizeBeepInput([], { workspaceRoot: workspace }), /input must contain at least one part/i);
    assert.throws(() => normalizeBeepInput([{ type: "text", text: "   " }], { workspaceRoot: workspace }), /empty text/i);
    assert.throws(
      () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "not base64!" }], { workspaceRoot: workspace }),
      /valid base64/i,
    );
    assert.throws(
      () => normalizeBeepInput([{ type: "image", url: "http://example.com/image.png" }], { workspaceRoot: workspace }),
      /https/i,
    );
    assert.throws(
      () => normalizeBeepInput([{ type: "localImage", path: "/etc/passwd" }], { workspaceRoot: workspace }),
      /workspace/i,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects local image symlinks that resolve outside the workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-native-input-"));
  const outside = mkdtempSync(join(tmpdir(), "beep-native-input-outside-"));
  try {
    const outsideImagePath = join(outside, "outside.png");
    const symlinkPath = join(workspace, "linked-outside.png");
    writeFileSync(outsideImagePath, Buffer.from("outside png bytes"));
    symlinkSync(outsideImagePath, symlinkPath);

    assert.throws(
      () => normalizeBeepInput([{ type: "localImage", path: symlinkPath }], { workspaceRoot: workspace }),
      /workspace/i,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("normalizes in-workspace local image symlinks to their real target", () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-native-input-"));
  try {
    const targetPath = join(workspace, "target.png");
    const symlinkPath = join(workspace, "linked.png");
    writeFileSync(targetPath, Buffer.from("png bytes"));
    symlinkSync(targetPath, symlinkPath);

    assert.deepEqual(normalizeBeepInput([{ type: "localImage", path: symlinkPath }], { workspaceRoot: workspace }), [
      { type: "localImage", path: realpathSync(targetPath) },
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validates local image path shape without a workspace root", () => {
  assert.deepEqual(normalizeBeepInput([{ type: "localImage", path: "screens/screen.png", detail: "low" }]), [
    { type: "localImage", path: "screens/screen.png", detail: "low" },
  ]);

  for (const path of ["/etc/passwd", "C:/Users/ash/secret.png", "C:\\Users\\ash\\secret.png", "file:///tmp/screen.png", "../secret.png"]) {
    assert.throws(() => normalizeBeepInput([{ type: "localImage", path }]), /workspace/i);
  }
});

test("resolves relative local image paths against the workspace root", () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-native-input-"));
  try {
    const screenshotPath = join(workspace, "screen.png");
    writeFileSync(screenshotPath, Buffer.from("png bytes"));

    assert.deepEqual(normalizeBeepInput([{ type: "localImage", path: "screen.png" }], { workspaceRoot: workspace }), [
      { type: "localImage", path: realpathSync(screenshotPath) },
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("summarizes runtime-normalized local image paths without workspace root", () => {
  const workspace = mkdtempSync(join(tmpdir(), "beep-native-input-"));
  try {
    const screenshotPath = join(workspace, "screen.png");
    writeFileSync(screenshotPath, Buffer.from("png bytes"));
    const input = normalizeBeepInput([{ type: "localImage", path: "screen.png" }], { workspaceRoot: workspace });

    assert.deepEqual(summarizeBeepInput(input), {
      partCount: 1,
      textPartCount: 0,
      imagePartCount: 0,
      localImagePartCount: 1,
      totalInlineImageBytes: 0,
      textPreview: "",
      imageParts: [{ index: 0, source: "local", path: realpathSync(screenshotPath), detail: "auto" }],
    });
    assert.equal(labelBeepInput(input), "1 input parts (1 image)");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects invalid native input limits and accepts valid numeric limits", () => {
  for (const name of ["maxParts", "maxInlineImageBytes", "maxTotalInlineImageBytes"]) {
    for (const value of [Number.NaN, Infinity, 0, -1, 1.5]) {
      assert.throws(() => normalizeBeepInput([{ type: "text", text: "hello" }], { [name]: value }), /positive integer/i);
    }
  }

  assert.deepEqual(normalizeBeepInput([{ type: "text", text: "hello" }], { maxParts: 1 }), [{ type: "text", text: "hello" }]);
  assert.deepEqual(
    normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }], {
      maxInlineImageBytes: 4,
      maxTotalInlineImageBytes: 4,
    }),
    [{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }],
  );
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==" }], { maxInlineImageBytes: 3 }),
    /exceeds 3 bytes/i,
  );
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "AAB=" }], { maxInlineImageBytes: 1 }),
    /exceeds 1 bytes/i,
  );
});

test("rejects image parts with ambiguous or missing sources", () => {
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmFrZQ==", url: "https://example.com/screen.png" }]),
    /exactly one/i,
  );
  assert.throws(() => normalizeBeepInput([{ type: "image", mimeType: "image/png" }]), /exactly one/i);
});

test("rejects over-padded base64 image data", () => {
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "AAAA====" }]),
    /valid base64/i,
  );
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmFrZQ====" }]),
    /valid base64/i,
  );
});

test("accepts valid unpadded base64 image data", () => {
  assert.deepEqual(normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmFrZQ" }]), [
    { type: "image", mimeType: "image/png", data: "ZmFrZQ" },
  ]);
});

test("rejects whitespace-containing base64 image data", () => {
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmF rZQ==" }]),
    /valid base64/i,
  );
  assert.throws(
    () => normalizeBeepInput([{ type: "image", mimeType: "image/png", data: "ZmFr\nZQ==" }]),
    /valid base64/i,
  );
});

test("summarizes and redacts image bytes for public records", () => {
  const input = normalizeBeepInput([
    { type: "text", text: "Inspect this screenshot carefully because the toolbar changed." },
    { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
    { type: "image", url: "https://example.com/screen.webp" },
  ]);

  assert.deepEqual(summarizeBeepInput(input), {
    partCount: 3,
    textPartCount: 1,
    imagePartCount: 2,
    localImagePartCount: 0,
    totalInlineImageBytes: 4,
    textPreview: "Inspect this screenshot carefully because the toolbar changed.",
    imageParts: [
      { index: 1, source: "inline", mimeType: "image/png", byteLength: 4, detail: "high" },
      { index: 2, source: "url", url: "https://example.com/screen.webp", detail: "auto" },
    ],
  });

  assert.deepEqual(redactBeepInput(input), [
    { type: "text", text: "Inspect this screenshot carefully because the toolbar changed." },
    { type: "image", mimeType: "image/png", byteLength: 4, detail: "high", data: "[redacted]" },
    { type: "image", url: "https://example.com/screen.webp", detail: "auto" },
  ]);

  assert.equal(labelBeepInput(input), "Inspect this screenshot carefully because the toolbar changed. (2 images)");
});
