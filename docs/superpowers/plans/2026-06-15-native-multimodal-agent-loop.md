# Native Multimodal Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Beep carry structured text and image input from operator HTTP requests through the long-running Pi/Codex-backed agent loop without flattening images into text or using Pi RPC as the steady-state boundary.

**Architecture:** Add one shared native input contract used by control-plane and runtime. Extend vendored Pi so structured image content carries `data`, `url`, `localImage`, and `detail` to the OpenAI Responses provider boundary. Replace Beep's spawned JSONL Pi RPC session with an in-process `PiNativeSession` that uses vendored Pi SDK APIs directly.

**Tech Stack:** Node.js ESM, `node:test` for Beep tests, Vitest for vendored Pi tests, vendored Pi TypeScript packages, OpenAI Responses image content (`input_text`, `input_image`).

---

## File Structure

- Create `shared/native-input.mjs`
  - Canonical Beep input validation, normalization, public redaction, and display summaries.
  - Exported functions: `normalizeBeepInput`, `summarizeBeepInput`, `redactBeepInput`, `labelBeepInput`.

- Create `test/native-input.test.mjs`
  - Node unit tests for the shared input contract.

- Modify `docker/runtime.Dockerfile`
  - Copy `shared/` into `/shared/` so `/runtime/src/*.mjs` can import `../../shared/native-input.mjs` both locally and inside the runtime image.

- Modify `vendor/pi/packages/ai/src/types.ts`
  - Add image detail and image source variants to Pi's first-class content model.

- Modify `vendor/pi/packages/ai/src/providers/openai-responses-shared.ts`
  - Serialize structured image content to Responses `input_image` at the provider boundary.

- Create `vendor/pi/packages/ai/test/openai-responses-native-images.test.ts`
  - Vitest coverage for base64, URL, local-image, and `detail` serialization.

- Modify `vendor/pi/packages/coding-agent/src/core/agent-session.ts`
  - Let `prompt`, `steer`, `followUp`, and streaming queue paths accept native content arrays directly.
  - Keep Pi CLI callers able to pass strings, but Beep will only call the content-array path.

- Modify `vendor/pi/packages/coding-agent/test/suite/agent-session-prompt.test.ts`
  - Add native content-array prompt tests.

- Modify `vendor/pi/packages/coding-agent/test/suite/agent-session-queue.test.ts`
  - Add native content-array steer and follow-up queue tests.

- Create `runtime/src/pi-native-session.mjs`
  - In-process Beep wrapper around vendored Pi SDK.
  - Owns event JSONL, status/summary files, Pi SDK loading, credential injection, prompt completion waiting, session stop, and LCM/Hindsight hooks already present on the old session class.

- Modify `runtime/src/beep-runtime-api.mjs`
  - Import `PiNativeSession`.
  - Remove `node:child_process` spawn path and `PiRpcSession`.
  - Make `/agent/submit`, `/agent/steer`, `/agent/follow-up`, `/sessions/:id/prompt`, `/sessions/:id/steer`, `/sessions/:id/follow-up`, and `/runs` require native `input`.
  - Update capabilities from `transport: "pi-rpc"` to `transport: "pi-native"`.

- Modify `test/runtime-integration-static.test.mjs`
  - Static regression checks for native transport, no Pi RPC class, native input route usage, and no `message + images` route body.

- Modify `control-plane/src/server.mjs`
  - Make `POST /api/requests` require native `input`, persist native input internally, forward native input unchanged to `/agent/submit`.

- Modify `control-plane/src/request-routes.mjs`
  - Return `inputSummary` and redacted input metadata in public responses; do not expose raw base64 image data.

- Modify `control-plane/src/state-store.mjs`
  - Stop defaulting agent requests to `message`; keep canonical `input` and `inputSummary`.

- Modify `control-plane/test/request-routes.test.mjs`
  - Update request route assertions for `inputSummary` instead of `message`.
  - Add POST forwarding and redaction coverage.

- Modify `control-plane/test/state-store.test.mjs`
  - Update reserved-field test to assert `input` and `inputSummary` are preserved while caller-supplied reserved fields are ignored.

---

### Task 1: Shared Native Input Contract

**Files:**
- Create: `shared/native-input.mjs`
- Create: `test/native-input.test.mjs`
- Modify: `docker/runtime.Dockerfile`

- [ ] **Step 1: Write the failing native input tests**

Create `test/native-input.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      { type: "localImage", path: screenshotPath, detail: "original" },
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
```

- [ ] **Step 2: Run the shared input test and verify it fails**

Run:

```bash
node --test test/native-input.test.mjs
```

Expected: FAIL with `Cannot find module .../shared/native-input.mjs`.

- [ ] **Step 3: Implement the shared native input module**

Create `shared/native-input.mjs`:

```js
import { existsSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

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

function normalizeDetail(value, index) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !IMAGE_DETAIL_VALUES.has(value)) {
    throw new Error(`input[${index}].detail must be one of low, high, original, or auto.`);
  }
  return value;
}

function assertBase64(value, index) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/\s+/gu, "").replace(/=+$/u, "")) {
    throw new Error(`input[${index}].data must be valid base64 image data.`);
  }
  return decoded.length;
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

function normalizeLocalImagePath(value, index, workspaceRoot) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input[${index}].path must be a non-empty workspace path.`);
  }
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim() === "") {
    return value;
  }
  const root = resolve(workspaceRoot);
  const path = resolve(value);
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/u.test(rel)) {
    throw new Error(`input[${index}].path must stay inside the active workspace.`);
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`input[${index}].path must point to an existing workspace file.`);
  }
  return path;
}

export function normalizeBeepInput(rawInput, options = {}) {
  const maxParts = Number(options.maxParts || DEFAULT_MAX_PARTS);
  const maxInlineImageBytes = Number(options.maxInlineImageBytes || DEFAULT_MAX_INLINE_IMAGE_BYTES);
  const maxTotalInlineImageBytes = Number(options.maxTotalInlineImageBytes || DEFAULT_MAX_TOTAL_INLINE_IMAGE_BYTES);
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
    if (part.type === "image" && "data" in part) {
      if (!IMAGE_MIME_TYPES.has(part.mimeType)) {
        throw new Error(`input[${index}].mimeType must be image/png, image/jpeg, image/webp, or image/gif.`);
      }
      const byteLength = assertBase64(part.data, index);
      if (byteLength > maxInlineImageBytes) {
        throw new Error(`input[${index}] inline image exceeds ${maxInlineImageBytes} bytes.`);
      }
      totalInlineBytes += byteLength;
      if (totalInlineBytes > maxTotalInlineImageBytes) {
        throw new Error(`input inline images exceed ${maxTotalInlineImageBytes} bytes total.`);
      }
      const detail = normalizeDetail(part.detail, index);
      return { type: "image", mimeType: part.mimeType, data: part.data.replace(/\s+/gu, ""), ...(detail ? { detail } : {}) };
    }
    if (part.type === "image" && "url" in part) {
      const detail = normalizeDetail(part.detail, index);
      return { type: "image", url: assertHttpsUrl(part.url, index), ...(detail ? { detail } : {}) };
    }
    if (part.type === "localImage") {
      const detail = normalizeDetail(part.detail, index);
      return { type: "localImage", path: normalizeLocalImagePath(part.path, index, options.workspaceRoot), ...(detail ? { detail } : {}) };
    }
    throw new Error(`input[${index}] must be text, image, or localImage.`);
  });
}

export function summarizeBeepInput(input) {
  const normalized = normalizeBeepInput(input);
  const textParts = normalized.filter((part) => part.type === "text");
  const imageParts = [];
  let totalInlineImageBytes = 0;
  normalized.forEach((part, index) => {
    if (part.type === "image" && "data" in part) {
      const byteLength = Buffer.from(part.data, "base64").length;
      totalInlineImageBytes += byteLength;
      imageParts.push({ index, source: "inline", mimeType: part.mimeType, byteLength, detail: part.detail || "auto" });
    } else if (part.type === "image" && "url" in part) {
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
  return input.map((part) => {
    if (part.type === "image" && "data" in part) {
      return {
        type: "image",
        mimeType: part.mimeType,
        byteLength: Buffer.from(part.data, "base64").length,
        detail: part.detail || "auto",
        data: "[redacted]",
      };
    }
    if (part.type === "image" && "url" in part) {
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
```

- [ ] **Step 4: Copy shared code into the runtime image**

Modify `docker/runtime.Dockerfile` so the runtime container contains `/shared/native-input.mjs`:

```dockerfile
WORKDIR /runtime

COPY shared/ /shared/
COPY runtime/ /runtime/
```

- [ ] **Step 5: Run the shared input test and verify it passes**

Run:

```bash
node --test test/native-input.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add shared/native-input.mjs test/native-input.test.mjs docker/runtime.Dockerfile
git commit -m "feat: add native multimodal input contract"
```

---

### Task 2: Vendored Pi Responses Image Serialization

**Files:**
- Modify: `vendor/pi/packages/ai/src/types.ts`
- Modify: `vendor/pi/packages/ai/src/providers/openai-responses-shared.ts`
- Create: `vendor/pi/packages/ai/test/openai-responses-native-images.test.ts`

- [ ] **Step 1: Write failing provider serialization tests**

Create `vendor/pi/packages/ai/test/openai-responses-native-images.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../src/index.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";

const model: Model<"openai-responses"> = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

function userContentFrom(context: Context) {
	const input = convertResponsesMessages(model, context, new Set(["openai"]));
	const user = input.find((item) => "role" in item && item.role === "user");
	if (!user || !("content" in user) || !Array.isArray(user.content)) {
		throw new Error("Expected converted user message content array");
	}
	return user.content;
}

describe("Responses native image content", () => {
	it("serializes inline image data with caller-provided detail", () => {
		const content = userContentFrom({
			systemPrompt: "",
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png", detail: "high" },
					],
					timestamp: 1,
				},
			],
		});

		expect(content).toEqual([
			{ type: "input_text", text: "inspect" },
			{ type: "input_image", detail: "high", image_url: "data:image/png;base64,ZmFrZQ==" },
		]);
	});

	it("serializes remote image URLs without converting them to data URLs", () => {
		const content = userContentFrom({
			systemPrompt: "",
			tools: [],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect" },
						{ type: "image", url: "https://example.com/screen.webp", detail: "low" },
					],
					timestamp: 1,
				},
			],
		});

		expect(content).toEqual([
			{ type: "input_text", text: "inspect" },
			{ type: "input_image", detail: "low", image_url: "https://example.com/screen.webp" },
		]);
	});

	it("serializes local images at the provider boundary", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-native-image-"));
		try {
			const imagePath = join(dir, "screen.png");
			writeFileSync(imagePath, Buffer.from("local image"));

			const content = userContentFrom({
				systemPrompt: "",
				tools: [],
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "inspect" },
							{ type: "localImage", path: imagePath, detail: "original" },
						],
						timestamp: 1,
					},
				],
			});

			expect(content).toEqual([
				{ type: "input_text", text: "inspect" },
				{ type: "input_image", detail: "original", image_url: "data:image/png;base64,bG9jYWwgaW1hZ2U=" },
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
```

- [ ] **Step 2: Run the Pi AI test and verify it fails**

Run:

```bash
cd vendor/pi/packages/ai && npm test -- openai-responses-native-images.test.ts
```

Expected: FAIL because `ImageContent` does not accept URL/local image sources and provider conversion hardcodes inline `data`.

- [ ] **Step 3: Extend Pi image content types**

In `vendor/pi/packages/ai/src/types.ts`, replace the current image content definition with:

```ts
export type ImageDetail = "low" | "high" | "original" | "auto";

export interface InlineImageContent {
	type: "image";
	data: string;
	mimeType: string;
	detail?: ImageDetail;
}

export interface RemoteImageContent {
	type: "image";
	url: string;
	detail?: ImageDetail;
}

export interface LocalImageContent {
	type: "localImage";
	path: string;
	detail?: ImageDetail;
}

export type ImageContent = InlineImageContent | RemoteImageContent | LocalImageContent;
```

- [ ] **Step 4: Serialize images only at the Responses provider boundary**

In `vendor/pi/packages/ai/src/providers/openai-responses-shared.ts`, add these imports and helper functions near the message conversion utilities:

```ts
import { extname } from "node:path";
import { readFileSync } from "node:fs";
```

```ts
function mimeTypeForLocalImage(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	throw new Error(`Unsupported local image type: ${path}`);
}

function responseInputImageFromContent(item: ImageContent): ResponseInputImage {
	const detail = item.detail ?? "auto";
	if (item.type === "localImage") {
		const mimeType = mimeTypeForLocalImage(item.path);
		const data = readFileSync(item.path).toString("base64");
		return {
			type: "input_image",
			detail,
			image_url: `data:${mimeType};base64,${data}`,
		} satisfies ResponseInputImage;
	}
	if ("url" in item) {
		return {
			type: "input_image",
			detail,
			image_url: item.url,
		} satisfies ResponseInputImage;
	}
	return {
		type: "input_image",
		detail,
		image_url: `data:${item.mimeType};base64,${item.data}`,
	} satisfies ResponseInputImage;
}
```

Replace both user-message and tool-result image serialization blocks with:

```ts
return responseInputImageFromContent(item);
```

and:

```ts
contentParts.push(responseInputImageFromContent(block));
```

- [ ] **Step 5: Run the Pi AI test and verify it passes**

Run:

```bash
cd vendor/pi/packages/ai && npm test -- openai-responses-native-images.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add vendor/pi/packages/ai/src/types.ts vendor/pi/packages/ai/src/providers/openai-responses-shared.ts vendor/pi/packages/ai/test/openai-responses-native-images.test.ts
git commit -m "feat(pi): serialize native image inputs"
```

---

### Task 3: Vendored Pi Native Content Session API

**Files:**
- Modify: `vendor/pi/packages/coding-agent/src/core/agent-session.ts`
- Modify: `vendor/pi/packages/coding-agent/test/suite/agent-session-prompt.test.ts`
- Modify: `vendor/pi/packages/coding-agent/test/suite/agent-session-queue.test.ts`

- [ ] **Step 1: Write failing prompt content-array test**

Append this test to `vendor/pi/packages/coding-agent/test/suite/agent-session-prompt.test.ts`:

```ts
	it("accepts native content arrays without splitting text and images", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let userContent: unknown;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				userContent = user?.role === "user" ? user.content : undefined;
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt([
			{ type: "text", text: "inspect" },
			{ type: "image", url: "https://example.com/screen.png", detail: "high" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png", detail: "low" },
		]);

		expect(userContent).toEqual([
			{ type: "text", text: "inspect" },
			{ type: "image", url: "https://example.com/screen.png", detail: "high" },
			{ type: "image", data: "ZmFrZQ==", mimeType: "image/png", detail: "low" },
		]);
	});
```

- [ ] **Step 2: Write failing queue content-array tests**

Append these tests to `vendor/pi/packages/coding-agent/test/suite/agent-session-queue.test.ts`:

```ts
	it("queues native image steering content without flattening it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			fauxAssistantMessage("first", { delayMs: 20 }),
			(context) => {
				const userMessages = context.messages.filter((message) => message.role === "user");
				const queued = userMessages.at(-1);
				sawImage =
					queued?.role === "user" &&
					Array.isArray(queued.content) &&
					queued.content.some((part) => part.type === "image" && "url" in part && part.url === "https://example.com/steer.png");
				return fauxAssistantMessage("second");
			},
		]);

		const running = harness.session.prompt("start");
		await harness.session.steer([
			{ type: "text", text: "steer with image" },
			{ type: "image", url: "https://example.com/steer.png", detail: "high" },
		]);
		await running;

		expect(sawImage).toBe(true);
	});

	it("queues native image follow-up content without flattening it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			fauxAssistantMessage("first", { delayMs: 20 }),
			(context) => {
				const userMessages = context.messages.filter((message) => message.role === "user");
				const queued = userMessages.at(-1);
				sawImage =
					queued?.role === "user" &&
					Array.isArray(queued.content) &&
					queued.content.some((part) => part.type === "image" && "url" in part && part.url === "https://example.com/follow.png");
				return fauxAssistantMessage("second");
			},
		]);

		const running = harness.session.prompt("start");
		await harness.session.followUp([
			{ type: "text", text: "follow with image" },
			{ type: "image", url: "https://example.com/follow.png", detail: "high" },
		]);
		await running;

		expect(sawImage).toBe(true);
	});
```

- [ ] **Step 3: Run the Pi coding-agent tests and verify they fail**

Run:

```bash
cd vendor/pi/packages/coding-agent && npm test -- test/suite/agent-session-prompt.test.ts test/suite/agent-session-queue.test.ts
```

Expected: FAIL with TypeScript/runtime errors because `prompt`, `steer`, and `followUp` accept only strings.

- [ ] **Step 4: Add native content helpers to `AgentSession`**

In `vendor/pi/packages/coding-agent/src/core/agent-session.ts`, add these types near `PromptOptions`:

```ts
export type NativeUserContent = string | (TextContent | ImageContent)[];
```

Add these private helpers inside `AgentSession` before the prompting methods:

```ts
	private _contentText(content: NativeUserContent): string {
		if (typeof content === "string") return content;
		return content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}

	private _contentLabel(content: NativeUserContent): string {
		const text = this._contentText(content).replace(/\s+/g, " ").trim();
		const imageCount =
			typeof content === "string" ? 0 : content.filter((part) => part.type === "image" || part.type === "localImage").length;
		if (text && imageCount > 0) return `${text} (${imageCount} ${imageCount === 1 ? "image" : "images"})`;
		if (text) return text;
		return `${imageCount} ${imageCount === 1 ? "image" : "images"}`;
	}

	private _contentArray(content: NativeUserContent): (TextContent | ImageContent)[] {
		if (typeof content === "string") return [{ type: "text", text: content }];
		return content;
	}

	private _contentWithExpandedText(content: NativeUserContent, expandedText: string): (TextContent | ImageContent)[] {
		if (typeof content === "string") return [{ type: "text", text: expandedText }];
		let replaced = false;
		const next = content.map((part) => {
			if (part.type === "text" && !replaced) {
				replaced = true;
				return { type: "text" as const, text: expandedText };
			}
			return part;
		});
		return replaced ? next : [{ type: "text", text: expandedText }, ...next];
	}
```

- [ ] **Step 5: Change prompt and queue methods to accept native content**

Change method signatures:

```ts
async prompt(content: NativeUserContent, options?: PromptOptions): Promise<void>
async steer(content: NativeUserContent): Promise<void>
async followUp(content: NativeUserContent): Promise<void>
private async _queueSteer(content: (TextContent | ImageContent)[]): Promise<void>
private async _queueFollowUp(content: (TextContent | ImageContent)[]): Promise<void>
```

Inside `prompt`, replace text-only setup with:

```ts
const rawText = this._contentText(content);
if (expandPromptTemplates && rawText.startsWith("/")) {
	const handled = await this._tryExecuteExtensionCommand(rawText);
	if (handled) {
		preflightResult?.(true);
		return;
	}
}

let currentContent = this._contentArray(content);
let currentText = this._contentText(currentContent);
let currentImages = currentContent.filter((part): part is ImageContent => part.type === "image" || part.type === "localImage");
```

After input extension handling and prompt expansion, build the user message with:

```ts
const userContent = this._contentWithExpandedText(currentContent, expandedText);
messages.push({
	role: "user",
	content: userContent,
	timestamp: Date.now(),
});
```

When streaming, call:

```ts
const queuedContent = this._contentWithExpandedText(currentContent, expandedText);
if (options.streamingBehavior === "followUp") {
	await this._queueFollowUp(queuedContent);
} else {
	await this._queueSteer(queuedContent);
}
```

Update `steer` and `followUp` to compute text only for slash-command and template expansion, then queue native content:

```ts
async steer(content: NativeUserContent): Promise<void> {
	const text = this._contentText(content);
	if (text.startsWith("/")) {
		this._throwIfExtensionCommand(text);
	}
	let expandedText = this._expandSkillCommand(text);
	expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
	await this._queueSteer(this._contentWithExpandedText(content, expandedText));
}
```

Use the same shape for `followUp`.

Update `_queueSteer`:

```ts
private async _queueSteer(content: (TextContent | ImageContent)[]): Promise<void> {
	this._steeringMessages.push(this._contentLabel(content));
	this._emitQueueUpdate();
	this.agent.steer({
		role: "user",
		content,
		timestamp: Date.now(),
	});
}
```

Update `_queueFollowUp` the same way, using `_followUpMessages`.

Update `sendUserMessage` so it no longer splits content into `text + images`:

```ts
await this.prompt(content, {
	expandPromptTemplates: false,
	streamingBehavior: options?.deliverAs,
	source: "extension",
});
```

- [ ] **Step 6: Run the Pi coding-agent tests and verify they pass**

Run:

```bash
cd vendor/pi/packages/coding-agent && npm test -- test/suite/agent-session-prompt.test.ts test/suite/agent-session-queue.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add vendor/pi/packages/coding-agent/src/core/agent-session.ts vendor/pi/packages/coding-agent/test/suite/agent-session-prompt.test.ts vendor/pi/packages/coding-agent/test/suite/agent-session-queue.test.ts
git commit -m "feat(pi): accept native multimodal session content"
```

---

### Task 4: Native Pi Session Runtime Wrapper

**Files:**
- Create: `runtime/src/pi-native-session.mjs`
- Modify: `runtime/src/beep-runtime-api.mjs`
- Modify: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Write failing static runtime tests**

Append to `test/runtime-integration-static.test.mjs`:

```js
test("runtime uses native Pi sessions instead of Pi RPC", () => {
  assert.match(apiSource, /import \{ PiNativeSession \} from "\.\/pi-native-session\.mjs"/);
  assert.match(apiSource, /transport:\s*"pi-native"/);
  assert.doesNotMatch(apiSource, /class PiRpcSession/);
  assert.doesNotMatch(apiSource, /--mode",\s*"rpc"/);
  assert.doesNotMatch(apiSource, /type:\s*"prompt",\s*message/);
});

test("runtime routes require native input instead of message prompt shims", () => {
  assert.match(apiSource, /normalizeBeepInput\(body\.input/);
  assert.match(apiSource, /enqueuePrompt\(\{\s*input:/);
  assert.match(apiSource, /session\.prompt\(request\.input/);
  assert.doesNotMatch(apiSource, /body\.message\s*\|\|\s*body\.prompt/);
});
```

- [ ] **Step 2: Run the static runtime test and verify it fails**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL because `PiRpcSession` and `message || prompt` are still present.

- [ ] **Step 3: Create `PiNativeSession` with native Pi SDK loading**

Create `runtime/src/pi-native-session.mjs` with this skeleton and move the old session file/status/event responsibilities into it:

```js
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJsonFile(path, value, mode = 0o600) {
  ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmpPath, path);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.type === "thinking") return part.thinking ? `[thinking] ${part.thinking}` : "[thinking]";
      if (part.type === "toolCall") return `[tool:${part.name || "unknown"}] ${JSON.stringify(part.arguments ?? {})}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeEvents(events) {
  const byType = {};
  let finalAssistantText = null;
  let lastUsage = null;
  for (const event of events) {
    const type = event?.type || "unknown";
    byType[type] = (byType[type] || 0) + 1;
    const message = event?.message;
    if ((type === "message_end" || type === "turn_end") && message?.role === "assistant") {
      finalAssistantText = textFromContent(message.content) || finalAssistantText;
      if (message.usage) lastUsage = message.usage;
    }
  }
  return { total: events.length, byType, finalAssistantText, lastUsage };
}

function parseJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse_error", line: index + 1, message: error instanceof Error ? error.message : String(error), raw: line };
      }
    });
}

async function loadPiSdk(piRoot) {
  const codingAgentUrl = pathToFileURL(join(piRoot, "packages/coding-agent/dist/index.js")).href;
  const aiUrl = pathToFileURL(join(piRoot, "packages/ai/dist/index.js")).href;
  const codingAgent = await import(codingAgentUrl);
  const ai = await import(aiUrl);
  return { codingAgent, ai };
}

export class PiNativeSession {
  constructor(options) {
    this.id = options.id;
    this.model = options.model;
    this.thinking = options.thinking;
    this.rootDir = options.rootDir;
    this.workspace = options.workspace;
    this.sessionDir = options.sessionDir;
    this.piRoot = options.piRoot;
    this.resolveAccessToken = options.resolveAccessToken;
    this.writeSummaryExtra = options.writeSummaryExtra || (() => ({}));
    this.eventsPath = join(this.rootDir, "events.jsonl");
    this.statusPath = join(this.rootDir, "status.json");
    this.summaryPath = join(this.rootDir, "summary.json");
    this.createdAt = nowIso();
    this.updatedAt = this.createdAt;
    this.phase = "starting";
    this.closed = false;
    this.lastError = null;
    this.lastAssistantText = null;
    this.agentEndCount = 0;
    this.agentEndWaiters = [];
  }

  static async start(options) {
    const session = new PiNativeSession(options);
    await session.open();
    return session;
  }

  async open() {
    ensureDir(this.rootDir);
    ensureDir(this.workspace);
    ensureDir(this.sessionDir);
    this.eventsStream = createWriteStream(this.eventsPath, { flags: "a" });
    const accessToken = await this.resolveAccessToken();
    const { codingAgent, ai } = await loadPiSdk(this.piRoot);
    const authStorage = codingAgent.AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("openai-codex", accessToken);
    const modelRegistry = codingAgent.ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("openai-codex", this.model) || ai.getModel("openai-codex", this.model);
    const result = await codingAgent.createAgentSession({
      cwd: this.workspace,
      agentDir: join(this.rootDir, "pi-agent"),
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: this.thinking,
      sessionManager: codingAgent.SessionManager.create(this.workspace, this.sessionDir),
    });
    this.piSession = result.session;
    this.unsubscribe = this.piSession.subscribe((event) => this.handleEvent(event));
    this.phase = "idle";
    this.updatedAt = nowIso();
    this.writeStatus();
  }

  handleEvent(event) {
    this.eventsStream.write(`${JSON.stringify(event)}\n`);
    if (event.type === "agent_start") this.phase = "agent_running";
    if (event.type === "turn_start") this.phase = "turn_running";
    if (event.type === "turn_end") this.phase = "turn_complete";
    if (event.type === "agent_end") {
      this.agentEndCount += 1;
      this.phase = "idle";
      this.resolveAgentEndWaiters();
      this.writeSummary();
    }
    if ((event.type === "message_end" || event.type === "turn_end") && event.message?.role === "assistant") {
      this.lastAssistantText = textFromContent(event.message.content) || this.lastAssistantText;
    }
    this.updatedAt = nowIso();
    this.writeStatus();
  }

  async prompt(input, options = {}) {
    const waitForCompletion = Boolean(options.waitForCompletion);
    const beforeAgentEndCount = this.agentEndCount;
    await this.piSession.prompt(input, {
      expandPromptTemplates: options.expandPromptTemplates,
      streamingBehavior: options.streamingBehavior,
      source: "interactive",
    });
    if (waitForCompletion) {
      await this.waitForAgentEndAfter(beforeAgentEndCount, options.timeoutMs);
    }
    return {
      response: { success: true },
      completed: waitForCompletion ? this.agentEndCount > beforeAgentEndCount || this.closed : null,
      finalText: this.lastAssistantText,
      summary: this.writeSummary(),
    };
  }

  async steer(input) {
    await this.piSession.steer(input);
    return { success: true };
  }

  async followUp(input) {
    await this.piSession.followUp(input);
    return { success: true };
  }

  async abort() {
    this.piSession.agent.abort();
    return { success: true };
  }

  waitForAgentEndAfter(agentEndCount, timeoutMs = 600000) {
    if (this.agentEndCount > agentEndCount || this.closed) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.agentEndWaiters = this.agentEndWaiters.filter((waiter) => waiter.resolve !== resolvePromise);
        rejectPromise(new Error(`Timed out waiting for Pi agent completion in session ${this.id}.`));
      }, timeoutMs);
      this.agentEndWaiters.push({
        after: agentEndCount,
        resolve: () => {
          clearTimeout(timeout);
          resolvePromise();
        },
      });
    });
  }

  resolveAgentEndWaiters() {
    const remaining = [];
    for (const waiter of this.agentEndWaiters) {
      if (this.closed || this.agentEndCount > waiter.after) waiter.resolve();
      else remaining.push(waiter);
    }
    this.agentEndWaiters = remaining;
  }

  status() {
    return {
      id: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      phase: this.phase,
      closed: this.closed,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      workspace: this.workspace,
      rootDir: this.rootDir,
      sessionDir: this.sessionDir,
      eventsPath: this.eventsPath,
      summaryPath: this.summaryPath,
      agentEndCount: this.agentEndCount,
      lastAssistantText: this.lastAssistantText,
      lastError: this.lastError,
    };
  }

  writeStatus() {
    writeJsonFile(this.statusPath, this.status());
  }

  writeSummary(extra = {}) {
    const events = parseJsonl(this.eventsPath);
    const summary = {
      ok: !this.lastError,
      sessionId: this.id,
      provider: "openai-codex",
      model: this.model,
      thinking: this.thinking,
      phase: this.phase,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      workspace: { path: this.workspace },
      events: { path: this.eventsPath, ...summarizeEvents(events) },
      lastAssistantText: this.lastAssistantText,
      ...this.writeSummaryExtra(),
      ...extra,
    };
    writeJsonFile(this.summaryPath, summary);
    return summary;
  }

  async stop() {
    this.closed = true;
    this.phase = "closed";
    this.unsubscribe?.();
    this.piSession?.dispose();
    this.eventsStream?.end();
    this.writeSummary();
    this.writeStatus();
    this.resolveAgentEndWaiters();
    return this.status();
  }
}
```

During implementation, move the existing `recordLcm`, `resolvePiSessionFile`, `recordHindsightMemory`, `recordLcmContextInjection`, and summary fields from `PiRpcSession` into this class instead of leaving them in `beep-runtime-api.mjs`.

- [ ] **Step 4: Wire `beep-runtime-api.mjs` to `PiNativeSession`**

Modify imports:

```js
import { PiNativeSession } from "./pi-native-session.mjs";
import { labelBeepInput, normalizeBeepInput, redactBeepInput, summarizeBeepInput } from "../../shared/native-input.mjs";
```

Remove:

```js
import { spawn } from "node:child_process";
```

Replace `PiRpcSession.start(...)` calls with:

```js
PiNativeSession.start({
  id,
  model,
  thinking,
  rootDir,
  workspace,
  sessionDir,
  piRoot: PI_ROOT,
  resolveAccessToken: () =>
    resolveCodexAccessToken(CODEX_HOME, {
      provider: "openai-codex",
      model,
      runtimeSessionId: id,
    }),
})
```

Update capabilities:

```js
runner: {
  harness: "pi",
  transport: "pi-native",
  provider: "openai-codex",
  auth: "chatgpt-codex-oauth",
  codexEndpoint: "https://chatgpt.com/backend-api/codex/responses",
},
```

Remove the `piRpcCommands` capability list. Replace it with:

```js
nativeInput: {
  parts: ["text", "image", "localImage"],
  imageSources: ["base64", "https-url", "workspace-local"],
  detail: ["low", "high", "original", "auto"],
},
```

- [ ] **Step 5: Run the static runtime test and verify it passes**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add runtime/src/pi-native-session.mjs runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
git commit -m "feat(runtime): use native in-process Pi sessions"
```

---

### Task 5: Runtime Native Input Routes

**Files:**
- Modify: `runtime/src/beep-runtime-api.mjs`
- Modify: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Write failing route contract static tests**

Append to `test/runtime-integration-static.test.mjs`:

```js
test("agent supervisor stores native input and redacted summaries", () => {
  assert.match(apiSource, /input:\s*normalizeBeepInput\(body\.input/);
  assert.match(apiSource, /inputSummary:\s*summarizeBeepInput\(input\)/);
  assert.match(apiSource, /redactedInput:\s*redactBeepInput\(request\.input\)/);
  assert.match(apiSource, /labelBeepInput\(request\.input\)/);
  assert.doesNotMatch(apiSource, /message:\s*request\.message/);
});

test("steer and follow-up use the same native input contract as submit", () => {
  assert.match(apiSource, /action === "steer"[\s\S]*normalizeBeepInput\(body\.input/);
  assert.match(apiSource, /agentSupervisor\.steer\(input\)/);
  assert.match(apiSource, /action === "follow-up"[\s\S]*normalizeBeepInput\(body\.input/);
  assert.match(apiSource, /agentSupervisor\.followUp\(input\)/);
});
```

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL because runtime still stores `message` on requests and steer/follow-up still read `body.message || body.prompt`.

- [ ] **Step 3: Change `AgentSupervisor` to store native input**

In `runtime/src/beep-runtime-api.mjs`, change `publicRequest`:

```js
publicRequest(request) {
  return {
    id: request.id,
    sequence: request.sequence,
    status: request.status,
    createdAt: request.createdAt,
    startedAt: request.startedAt || null,
    completedAt: request.completedAt || null,
    inputSummary: request.inputSummary || summarizeBeepInput(request.input || []),
    redactedInput: request.input ? redactBeepInput(request.input) : null,
    label: request.input ? labelBeepInput(request.input) : null,
    finalText: request.finalText || null,
    error: request.error || null,
    memoryError: request.memoryError || null,
    lcm: request.lcm || null,
    hindsight: request.hindsight || null,
    promptResult: request.promptResult || null,
  };
}
```

Change `enqueuePrompt`:

```js
enqueuePrompt({ input, timeoutMs, recordLcm = true, streamingBehavior = undefined } = {}) {
  const nativeInput = normalizeBeepInput(input, { workspaceRoot: WORKSPACE_DIR });
  this.state.sequence += 1;
  const request = {
    id: newRequestId("agent_req"),
    sequence: this.state.sequence,
    status: "queued",
    type: "prompt",
    input: nativeInput,
    inputSummary: summarizeBeepInput(nativeInput),
    timeoutMs: safeNumber(timeoutMs, DEFAULT_PROMPT_TIMEOUT_MS),
    recordLcm: recordLcm !== false,
    streamingBehavior,
    createdAt: nowIso(),
  };
  this.state.requests[request.id] = request;
  this.persistState();
  this.drainQueueSoon();
  return this.publicRequest(request);
}
```

Change `runRequest`:

```js
const promptResult = await session.prompt(request.input, {
  waitForCompletion: true,
  timeoutMs: request.timeoutMs,
  streamingBehavior: request.streamingBehavior,
});
```

Change supervisor steering:

```js
async steer(input) {
  const session = await this.start();
  return session.steer(input);
}

async followUp(input) {
  const session = await this.start();
  return session.followUp(input);
}
```

- [ ] **Step 4: Change runtime HTTP routes to require `input`**

In `handleAgentRoute`, change submit:

```js
if (action === "submit") {
  const input = normalizeBeepInput(body.input, { workspaceRoot: WORKSPACE_DIR });
  const request = agentSupervisor.enqueuePrompt({
    input,
    timeoutMs: body.timeoutMs,
    recordLcm: body.recordLcm,
    streamingBehavior: body.streamingBehavior,
  });
  if (body.waitForCompletion) {
    const completed = await agentSupervisor.waitForRequest(request.id, body.timeoutMs);
    jsonResponse(res, completed.status === "completed" ? 200 : 500, {
      ok: completed.status === "completed",
      request: completed,
      agent: agentSupervisor.status(),
    });
    return;
  }
  jsonResponse(res, 202, { ok: true, request, agent: agentSupervisor.status() });
  return;
}
```

Change steer and follow-up:

```js
if (action === "steer") {
  const input = normalizeBeepInput(body.input, { workspaceRoot: WORKSPACE_DIR });
  const response = await agentSupervisor.steer(input);
  jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
  return;
}

if (action === "follow-up") {
  const input = normalizeBeepInput(body.input, { workspaceRoot: WORKSPACE_DIR });
  const response = await agentSupervisor.followUp(input);
  jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
  return;
}
```

In `handleSessionRoute`, change prompt/steer/follow-up to normalize `body.input` and call `session.prompt(input)`, `session.steer(input)`, and `session.followUp(input)`.

In `handleRun`, replace prompt extraction with:

```js
const input = normalizeBeepInput(body.input, { workspaceRoot: WORKSPACE_DIR });
```

and call:

```js
promptResult = await session.prompt(input, {
  waitForCompletion: true,
  timeoutMs: body.timeoutMs,
  streamingBehavior: body.streamingBehavior,
});
```

- [ ] **Step 5: Run runtime static tests**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
git commit -m "feat(runtime): require native multimodal input"
```

---

### Task 6: Control-Plane Native Request Contract

**Files:**
- Modify: `control-plane/src/server.mjs`
- Modify: `control-plane/src/request-routes.mjs`
- Modify: `control-plane/src/state-store.mjs`
- Modify: `control-plane/test/request-routes.test.mjs`
- Modify: `control-plane/test/state-store.test.mjs`

- [ ] **Step 1: Update the POST request forwarding test to fail against the old message contract**

Replace the existing `POST request submission keeps the existing runtime forwarding behavior` test in `control-plane/test/request-routes.test.mjs` with:

```js
test("POST request submission forwards native input unchanged and persists a redacted summary", async () => {
  const { store, cleanup } = tempStore();
  try {
    let ensureRuntimeCalls = 0;
    const forwarded = [];
    const handler = handlerFor({
      store,
      runtimeManager: {
        status: async () => ({ runtimeId: "local", running: false }),
        ensureRuntime: async () => {
          ensureRuntimeCalls += 1;
          return { runtimeId: "local", running: true };
        },
        proxyToRuntime: async (path, options) => {
          forwarded.push({ path, options });
          return { ok: true, request: { id: "runtime-post-1" } };
        },
      },
    });
    const response = captureResponse();

    await handler(
      request(
        "POST",
        "/api/requests",
        { ...operatorHeaders(store), "content-type": "application/json" },
        JSON.stringify({
          input: [
            { type: "text", text: "submit me" },
            { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
          ],
        }),
      ),
      response.response,
    );

    const { statusCode, payload } = response.json();
    const persisted = store.getAgentRequest(payload.requestId);
    assert.equal(statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(ensureRuntimeCalls, 1);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].path, "/agent/submit");
    assert.deepEqual(JSON.parse(forwarded[0].options.body).input, [
      { type: "text", text: "submit me" },
      { type: "image", mimeType: "image/png", data: "ZmFrZQ==", detail: "high" },
    ]);
    assert.equal(persisted.runtimeRequestId, "runtime-post-1");
    assert.equal(persisted.input[1].data, "ZmFrZQ==");
    assert.equal(persisted.inputSummary.imageParts[0].byteLength, 4);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Update public request route assertions**

In `control-plane/test/request-routes.test.mjs`, replace expected public keys that include `message` with keys that include `inputSummary` and `redactedInput`:

```js
assert.deepEqual(Object.keys(payload.requests[0]).sort(), [
  "createdAt",
  "error",
  "inputSummary",
  "redactedInput",
  "requestId",
  "runtimeId",
  "runtimeRequestId",
  "runtimeResult",
  "schemaVersion",
  "source",
  "status",
  "updatedAt",
]);
```

Add this assertion after a record with an inline image is returned:

```js
assert.equal(payload.requests[0].redactedInput[1].data, "[redacted]");
assert.equal(payload.requests[0].input?.[1]?.data, undefined);
```

- [ ] **Step 3: Run control-plane request tests and verify they fail**

Run:

```bash
node --test control-plane/test/request-routes.test.mjs control-plane/test/state-store.test.mjs
```

Expected: FAIL because `message` is still part of public records and POST `/api/requests` still forwards `message`.

- [ ] **Step 4: Update state-store request creation**

In `control-plane/src/state-store.mjs`, change `createAgentRequest` to preserve native input:

```js
createAgentRequest(request) {
  const requestId = newId("cp_req");
  const createdAt = nowIso();
  const created = {
    ...request,
    schemaVersion: 1,
    requestId,
    runtimeId: request.runtimeId || null,
    input: Array.isArray(request.input) ? request.input : [],
    inputSummary: request.inputSummary || null,
    status: "submitted",
    source: request.source || "control-plane",
    createdAt,
    updatedAt: createdAt,
  };
  this.update((state) => {
    state.agentRequests[requestId] = created;
    appendAuditEvent(state, {
      kind: "agent_request_created",
      requestId,
      runtimeId: created.runtimeId,
      status: created.status,
      inputSummary: created.inputSummary,
    });
  });
  return created;
}
```

- [ ] **Step 5: Update control-plane POST `/api/requests`**

In `control-plane/src/server.mjs`, add:

```js
import { normalizeBeepInput, summarizeBeepInput } from "../../shared/native-input.mjs";
```

Replace the POST body handling with:

```js
const body = await readJsonBody(request);
const input = normalizeBeepInput(body.input);
const inputSummary = summarizeBeepInput(input);
await runtimeManager.ensureRuntime();
const controlPlaneRequest = store.createAgentRequest({
  runtimeId: RUNTIME_ID,
  input,
  inputSummary,
  status: "forwarding",
  source: "api",
});
const runtimeBody = {
  input,
  waitForCompletion: body.waitForCompletion !== false,
  timeoutMs: Number(body.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS),
};
```

- [ ] **Step 6: Redact public request records**

In `control-plane/src/request-routes.mjs`, import:

```js
import { redactBeepInput, summarizeBeepInput } from "../../shared/native-input.mjs";
```

Change `PUBLIC_REQUEST_FIELDS`:

```js
const PUBLIC_REQUEST_FIELDS = [
  "schemaVersion",
  "requestId",
  "runtimeId",
  "runtimeRequestId",
  "inputSummary",
  "redactedInput",
  "status",
  "source",
  "error",
  "runtimeResult",
  "createdAt",
  "updatedAt",
];
```

Change `publicRequest`:

```js
function publicRequest(record) {
  const response = {};
  for (const field of PUBLIC_REQUEST_FIELDS) {
    if (field === "runtimeResult") {
      response[field] = publicRuntimeResult(record[field]);
    } else if (field === "inputSummary") {
      response[field] = record.inputSummary || summarizeBeepInput(record.input || []);
    } else if (field === "redactedInput") {
      response[field] = Array.isArray(record.input) ? redactBeepInput(record.input) : [];
    } else {
      response[field] = record[field] ?? null;
    }
  }
  return response;
}
```

- [ ] **Step 7: Run control-plane tests**

Run:

```bash
node --test control-plane/test/request-routes.test.mjs control-plane/test/state-store.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add control-plane/src/server.mjs control-plane/src/request-routes.mjs control-plane/src/state-store.mjs control-plane/test/request-routes.test.mjs control-plane/test/state-store.test.mjs
git commit -m "feat(control-plane): accept native multimodal requests"
```

---

### Task 7: Cross-Layer Verification

**Files:**
- Modify only if verification exposes a defect in files changed by Tasks 1-6.

- [ ] **Step 1: Run focused Beep tests**

Run:

```bash
npm run test:control-plane
```

Expected: PASS.

Run:

```bash
npm run test:runtime-static
```

Expected: PASS.

Run:

```bash
node --test test/native-input.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run focused Pi tests**

Run:

```bash
cd vendor/pi/packages/ai && npm test -- openai-responses-native-images.test.ts
```

Expected: PASS.

Run:

```bash
cd vendor/pi/packages/coding-agent && npm test -- test/suite/agent-session-prompt.test.ts test/suite/agent-session-queue.test.ts
```

Expected: PASS.

- [ ] **Step 3: Rebuild runtime image syntax path**

Run:

```bash
docker compose -f docker/compose.runtime-dev.yml build beep-host-loop
```

Expected: image build completes; Pi packages compile after the vendored TypeScript changes; `/shared/native-input.mjs` is present in the image.

- [ ] **Step 4: Optional credential-gated smoke**

Run this only when the runtime has a valid Codex credential:

```bash
docker compose -f docker/compose.runtime-dev.yml --profile api up -d beep-host-loop
```

Expected: runtime health endpoint returns `ok: true`.

Send a tiny inline image request:

```bash
curl -fsS http://127.0.0.1:8787/agent/submit \
  -H "Authorization: Bearer $BEEP_RUNTIME_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":[{"type":"text","text":"What color is the square?"},{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=","detail":"low"}],"waitForCompletion":true,"timeoutMs":120000}'
```

Expected: response has `ok: true`; request detail shows `inputSummary.imageParts[0].detail === "low"`; runtime events contain a user message with an image content part.

- [ ] **Step 5: Commit verification fixes if any files changed**

If verification required fixes, run:

```bash
git add <changed-files>
git commit -m "fix: stabilize native multimodal runtime verification"
```

If verification did not require fixes, do not create an empty commit.

---

## Completion Criteria

- `POST /api/requests`, `/agent/submit`, `/agent/steer`, `/agent/follow-up`, `/sessions/:id/prompt`, `/sessions/:id/steer`, `/sessions/:id/follow-up`, and `/runs` use native `input`.
- No Beep route constructs a `message + images` payload.
- Beep runtime uses `PiNativeSession`, not Pi RPC.
- Vendored Pi high-level session APIs can accept content arrays directly.
- Pi Responses provider emits `input_image` with the original caller `detail`.
- Inline image bytes are not returned in public control-plane request listings or details.
- LCM and Hindsight request lifecycle still runs after successful agent turns.
- Focused Beep and Pi tests pass.
