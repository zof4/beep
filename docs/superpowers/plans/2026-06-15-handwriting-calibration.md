# Handwriting Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Notes testing-demo handwriting calibration flow where Beep provides a copy text page, stores the user's handwritten image with the exact reference text, and uses those native image samples when reading future handwritten captures.

**Architecture:** Keep handwriting calibration inside the existing Notes control-plane boundary. Add focused handwriting domain/store helpers, reuse the existing workspace-backed image capture mechanics, and enrich only the `readableRendition` stage with retrieved calibration samples. Calibration images and target images must remain `localImage` parts until the Pi/OpenAI provider boundary.

**Tech Stack:** Node.js ES modules, `node:test`, existing `StateStore`/Notes workspace store, existing multipart parsing and `sips`-based HEIC conversion, plain `/notes` HTML/CSS/JavaScript demo UI, Beep runtime `localImage` input parts.

---

## Scope Check

The approved spec is one integrated Notes-demo slice: calibration text generation, handwritten sample storage, image conversion policy, `readableRendition` context enrichment, uncertainty metadata, and demo UI. It should be implemented as one feature because no single part proves user value until a sample can be saved and used in a transcription run.

Do not add a model-training system, embeddings retrieval, cross-user profile sync, or post-transcription correction memory. Do not broaden this into general Beep identity/profile work.

## File Structure

- Create `control-plane/src/notes/handwriting-domain.mjs`: pure domain helpers for the default calibration prompt, handwriting profile/sample normalization, active sample toggling, and handwriting context selection.
- Create `control-plane/test/notes-handwriting-domain.test.mjs`: domain tests for prompt stability, profile/sample creation, active sample selection, and run metadata validation.
- Modify `control-plane/src/notes/workspace-store.mjs`: persist `handwritingProfiles`, `handwritingPrompts`, `handwritingSamples`, `handwritingSampleOrder`, and `handwritingPromptOrder` under `state.notesBackbone`.
- Modify `control-plane/test/notes-workspace-store.test.mjs`: persistence tests for default profile/prompt seeding, sample creation, prompt linkage, active sample toggling, and workspace clone safety.
- Create `control-plane/src/notes/image-media.mjs`: extracted image upload/conversion helpers shared by ordinary captures and handwriting sample uploads; supports target conversion mode `jpeg` or `png`.
- Modify `control-plane/src/notes/routes.mjs`: use `image-media.mjs`, add handwriting API endpoints, include handwriting context in capture processing, and preserve existing capture behavior.
- Modify `control-plane/test/notes-routes.test.mjs`: route tests for default prompt, profile projection, sample upload, HEIC-to-PNG conversion, sample toggle, and calibrated `localImage` forwarding.
- Modify `control-plane/src/notes/beep-gateway.mjs`: accept `context.handwriting`, add calibration instructions/input parts during `readableRendition`, and validate `handwriting.uncertainSpans` output metadata.
- Modify `control-plane/test/notes-beep-gateway.test.mjs`: gateway tests for calibration image ordering, calibration reference text, and handwriting metadata validation.
- Modify `control-plane/src/notes/pipeline-engine.mjs`: preserve optional `outputs.handwriting` metadata across stage merges.
- Modify `control-plane/test/notes-pipeline-engine.test.mjs`: test handwriting metadata accumulation without mixing it into derived artifacts.
- Modify `control-plane/src/notes/demo-web.mjs`: add the demo calibration panel, default prompt loading, sample upload, saved sample list, activation toggle, `Use handwriting calibration`, and uncertainty display.
- Modify `control-plane/test/notes-demo-web.test.mjs`: static UI tests for calibration controls, HEIC accept list, FormData use, and no `FileReader`/`dataUrl` regression.
- Modify `package.json`: include `control-plane/test/notes-handwriting-domain.test.mjs` in `test:notes-backbone-static`.
- Optional after implementation: run a live proof against `/notes` with `/Users/ash/Downloads/IMG_5308.HEIC`.

## API Shape

All `/api/notes/handwriting/...` routes require the same operator auth as existing `/api/notes/...` routes.

- `GET /api/notes/handwriting/profile`: returns the default handwriting profile plus prompt/sample projection.
- `GET /api/notes/handwriting/prompts/default`: returns the stable V1 calibration prompt and coverage metadata.
- `POST /api/notes/handwriting/samples`: accepts multipart image upload plus `profileId`, `promptId`, and `referenceText`; writes a workspace-backed supported image; creates a source artifact; creates and activates a handwriting sample.
- `POST /api/notes/handwriting/samples/:sampleId/toggle`: toggles `active` and updates the profile `activeSampleIds`.

## Task 1: Handwriting Domain

**Files:**
- Create: `control-plane/src/notes/handwriting-domain.mjs`
- Create: `control-plane/test/notes-handwriting-domain.test.mjs`

- [ ] **Step 1: Write failing domain tests**

Create `control-plane/test/notes-handwriting-domain.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
  buildHandwritingContext,
  createDefaultHandwritingProfile,
  createDefaultHandwritingPrompt,
  createHandwritingSample,
  normalizeHandwritingStageMetadata,
  toggleHandwritingSampleActive,
} from "../src/notes/handwriting-domain.mjs";

const NOW = "2026-06-15T17:00:00.000Z";

test("default handwriting prompt is stable and covers ambiguous glyphs", () => {
  const prompt = createDefaultHandwritingPrompt({ createdAt: NOW });

  assert.equal(prompt.id, DEFAULT_HANDWRITING_PROMPT_ID);
  assert.equal(prompt.promptVersion, "v1");
  assert.match(prompt.referenceText, /Monday Jan 5 at 10:30 AM/u);
  assert.match(prompt.referenceText, /minimum unusual universe/u);
  assert.match(prompt.referenceText, /Call Sam/u);
  assert.deepEqual(prompt.coverage.digits, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.ok(prompt.coverage.ambiguousPairs.includes("m/n/u/w"));
  assert.ok(prompt.coverage.domainTerms.includes("laundry"));
});

test("default handwriting profile starts with no active samples", () => {
  const profile = createDefaultHandwritingProfile({ createdAt: NOW });

  assert.equal(profile.id, DEFAULT_HANDWRITING_PROFILE_ID);
  assert.deepEqual(profile.activeSampleIds, []);
  assert.deepEqual(profile.lexicon, []);
  assert.equal(profile.createdAt, NOW);
  assert.equal(profile.updatedAt, NOW);
});

test("handwriting sample copies prompt reference text and image metadata", () => {
  const prompt = createDefaultHandwritingPrompt({ createdAt: NOW });
  const sample = createHandwritingSample({
    id: "hw_sample_1",
    profileId: DEFAULT_HANDWRITING_PROFILE_ID,
    prompt,
    sourceArtifactId: "src_hw_1",
    image: {
      workspacePath: "notes-captures/hw_sample_1.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      originalName: "IMG_1001.HEIC",
      originalMimeType: "image/heic",
      originalSizeBytes: 2345,
      convertedFrom: "image/heic",
    },
    createdAt: NOW,
  });

  assert.equal(sample.promptId, DEFAULT_HANDWRITING_PROMPT_ID);
  assert.equal(sample.referenceText, prompt.referenceText);
  assert.deepEqual(sample.coverage, prompt.coverage);
  assert.equal(sample.active, true);
  assert.equal(sample.image.mimeType, "image/png");
});

test("toggleHandwritingSampleActive updates sample and profile active ids", () => {
  const profile = createDefaultHandwritingProfile({ createdAt: NOW });
  const sample = { id: "hw_sample_1", active: true, updatedAt: NOW };

  const inactive = toggleHandwritingSampleActive({ profile, sample, active: false, updatedAt: "2026-06-15T17:01:00.000Z" });
  assert.equal(inactive.sample.active, false);
  assert.deepEqual(inactive.profile.activeSampleIds, []);

  const active = toggleHandwritingSampleActive({ profile: inactive.profile, sample: inactive.sample, active: true, updatedAt: "2026-06-15T17:02:00.000Z" });
  assert.equal(active.sample.active, true);
  assert.deepEqual(active.profile.activeSampleIds, ["hw_sample_1"]);
});

test("buildHandwritingContext selects newest active samples", () => {
  const profile = {
    ...createDefaultHandwritingProfile({ createdAt: NOW }),
    activeSampleIds: ["sample_old", "sample_inactive", "sample_new", "sample_mid"],
    lexicon: ["Sam", "HAPC"],
  };
  const samples = {
    sample_old: { id: "sample_old", active: true, updatedAt: "2026-06-15T17:00:00.000Z", referenceText: "old", image: { workspacePath: "notes-captures/old.png", mimeType: "image/png" }, coverage: { domainTerms: ["old"] } },
    sample_inactive: { id: "sample_inactive", active: false, updatedAt: "2026-06-15T17:03:00.000Z", referenceText: "inactive", image: { workspacePath: "notes-captures/inactive.png", mimeType: "image/png" }, coverage: { domainTerms: ["inactive"] } },
    sample_new: { id: "sample_new", active: true, updatedAt: "2026-06-15T17:04:00.000Z", referenceText: "new", image: { workspacePath: "notes-captures/new.png", mimeType: "image/png" }, coverage: { domainTerms: ["new"] } },
    sample_mid: { id: "sample_mid", active: true, updatedAt: "2026-06-15T17:02:00.000Z", referenceText: "mid", image: { workspacePath: "notes-captures/mid.png", mimeType: "image/png" }, coverage: { domainTerms: ["mid"] } },
  };

  const context = buildHandwritingContext({ enabled: true, profile, samples, maxSamples: 2 });

  assert.equal(context.enabled, true);
  assert.deepEqual(context.lexicon, ["Sam", "HAPC"]);
  assert.deepEqual(context.samples.map((sample) => sample.id), ["sample_new", "sample_mid"]);
  assert.deepEqual(context.samples[0].imagePart, { type: "localImage", path: "notes-captures/new.png", detail: "original" });
});

test("buildHandwritingContext disables itself when no active samples exist", () => {
  const profile = createDefaultHandwritingProfile({ createdAt: NOW });
  const context = buildHandwritingContext({ enabled: true, profile, samples: {} });

  assert.equal(context.enabled, false);
  assert.deepEqual(context.samples, []);
});

test("normalizeHandwritingStageMetadata keeps uncertainty metadata structured", () => {
  const metadata = normalizeHandwritingStageMetadata({
    sampleIdsUsed: ["sample_1", "sample_2"],
    uncertainSpans: [
      { text: "Power pants", alternatives: ["Power plans", "Power points"], reason: "ambiguous second word" },
      { text: "HAPC", alternatives: "H APC", reason: 123 },
    ],
  });

  assert.deepEqual(metadata.sampleIdsUsed, ["sample_1", "sample_2"]);
  assert.deepEqual(metadata.uncertainSpans, [
    { text: "Power pants", alternatives: ["Power plans", "Power points"], reason: "ambiguous second word" },
    { text: "HAPC", alternatives: ["H APC"], reason: "123" },
  ]);
});
```

- [ ] **Step 2: Run the failing domain tests**

Run:

```bash
node --test control-plane/test/notes-handwriting-domain.test.mjs
```

Expected: FAIL with `Cannot find module ... handwriting-domain.mjs`.

- [ ] **Step 3: Implement the handwriting domain module**

Create `control-plane/src/notes/handwriting-domain.mjs`:

```js
export const DEFAULT_HANDWRITING_PROFILE_ID = "profile_default";
export const DEFAULT_HANDWRITING_PROMPT_ID = "hw_prompt_v1";

const DEFAULT_PROMPT_VERSION = "v1";

const DEFAULT_COVERAGE = Object.freeze({
  letters: Object.freeze(["a-z", "A-Z"]),
  digits: Object.freeze(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]),
  punctuation: Object.freeze(["-", "/", "(", ")", ":", "?", "->", "&", "."]),
  ambiguousPairs: Object.freeze(["m/n/u/w", "r/v", "s/5", "o/a", "e/c", "t/f", "g/y", "1/l/I", "0/O"]),
  domainTerms: Object.freeze([
    "Monday",
    "January",
    "laundry",
    "appointment",
    "email",
    "research",
    "follow up",
    "call",
    "buy",
    "return",
    "fix",
  ]),
});

const DEFAULT_REFERENCE_TEXT = [
  "Monday Jan 5 at 10:30 AM - Call Sam about the research plan.",
  "Buy 2 blue pens, 5 index cards, and 10 envelopes.",
  "minimum unusual universe: m n u w, r v, s 5, o a, e c, t f, g y.",
  "Laundry / email / appointment / follow up / return shoes.",
  "Fix HAPC study notes -> compare option A & option B.",
  "I will write clear lists, dense notes, dates, names, and short fragments.",
].join("\n");

function nowIso() {
  return new Date().toISOString();
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function text(value, label) {
  const output = String(value ?? "").trim();
  if (!output) throw new Error(`${label} is required`);
  return output;
}

function optionalText(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function uniquePrimitiveIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function cloneCoverage(coverage = DEFAULT_COVERAGE) {
  const input = plainObject(coverage, "coverage");
  return {
    letters: uniquePrimitiveIds(input.letters),
    digits: uniquePrimitiveIds(input.digits),
    punctuation: uniquePrimitiveIds(input.punctuation),
    ambiguousPairs: uniquePrimitiveIds(input.ambiguousPairs),
    domainTerms: uniquePrimitiveIds(input.domainTerms),
  };
}

export function createDefaultHandwritingPrompt({ createdAt = nowIso() } = {}) {
  return {
    id: DEFAULT_HANDWRITING_PROMPT_ID,
    label: "Default handwriting calibration page",
    promptVersion: DEFAULT_PROMPT_VERSION,
    referenceText: DEFAULT_REFERENCE_TEXT,
    coverage: cloneCoverage(DEFAULT_COVERAGE),
    createdAt,
  };
}

export function createDefaultHandwritingProfile({ createdAt = nowIso() } = {}) {
  return {
    id: DEFAULT_HANDWRITING_PROFILE_ID,
    label: "Default handwriting profile",
    activeSampleIds: [],
    lexicon: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createHandwritingSample(input) {
  const prompt = plainObject(input.prompt, "prompt");
  const image = plainObject(input.image, "image");
  const createdAt = input.createdAt || nowIso();
  return {
    id: text(input.id, "handwriting sample id"),
    profileId: text(input.profileId || DEFAULT_HANDWRITING_PROFILE_ID, "handwriting profile id"),
    promptId: text(input.promptId || prompt.id, "handwriting prompt id"),
    sourceArtifactId: text(input.sourceArtifactId, "source artifact id"),
    image: structuredClone(image),
    referenceText: text(input.referenceText || prompt.referenceText, "reference text"),
    coverage: cloneCoverage(input.coverage || prompt.coverage),
    active: input.active !== false,
    createdAt,
    updatedAt: input.updatedAt || createdAt,
  };
}

export function toggleHandwritingSampleActive({ profile, sample, active, updatedAt = nowIso() }) {
  const nextSample = { ...plainObject(sample, "sample"), active: Boolean(active), updatedAt };
  const sampleId = text(nextSample.id, "handwriting sample id");
  const profileInput = plainObject(profile, "profile");
  const activeIds = uniquePrimitiveIds(profileInput.activeSampleIds).filter((id) => id !== sampleId);
  if (nextSample.active) activeIds.push(sampleId);
  return {
    profile: {
      ...profileInput,
      activeSampleIds: activeIds,
      updatedAt,
    },
    sample: nextSample,
  };
}

export function buildHandwritingContext({ enabled = false, profile, samples = {}, maxSamples = 3 } = {}) {
  if (!enabled || !profile) return { enabled: false, profileId: null, samples: [], lexicon: [] };
  const profileInput = plainObject(profile, "profile");
  const selected = uniquePrimitiveIds(profileInput.activeSampleIds)
    .map((id) => samples[id])
    .filter((sample) => sample && sample.active !== false)
    .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))
    .slice(0, maxSamples)
    .map((sample) => ({
      id: sample.id,
      promptId: sample.promptId,
      referenceText: sample.referenceText,
      coverage: cloneCoverage(sample.coverage),
      imagePart: {
        type: "localImage",
        path: text(sample.image?.workspacePath, "sample image workspacePath"),
        detail: sample.image?.detail || "original",
      },
    }));
  return {
    enabled: selected.length > 0,
    profileId: profileInput.id || DEFAULT_HANDWRITING_PROFILE_ID,
    samples: selected,
    lexicon: uniquePrimitiveIds(profileInput.lexicon),
  };
}

export function normalizeHandwritingStageMetadata(value) {
  if (value === undefined) return null;
  const input = plainObject(value, "handwriting");
  return {
    sampleIdsUsed: uniquePrimitiveIds(input.sampleIdsUsed),
    uncertainSpans: Array.isArray(input.uncertainSpans)
      ? input.uncertainSpans
          .filter((span) => span && typeof span === "object")
          .map((span) => ({
            text: text(span.text, "uncertain span text"),
            alternatives: uniquePrimitiveIds(Array.isArray(span.alternatives) ? span.alternatives : [span.alternatives]),
            reason: optionalText(span.reason),
          }))
      : [],
  };
}
```

- [ ] **Step 4: Run the domain tests**

Run:

```bash
node --test control-plane/test/notes-handwriting-domain.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/handwriting-domain.mjs control-plane/test/notes-handwriting-domain.test.mjs
git commit -m "Add handwriting calibration domain"
```

## Task 2: Workspace Store Persistence

**Files:**
- Modify: `control-plane/src/notes/workspace-store.mjs`
- Modify: `control-plane/test/notes-workspace-store.test.mjs`

- [ ] **Step 1: Write failing workspace-store tests**

Append these tests to `control-plane/test/notes-workspace-store.test.mjs`:

```js
import {
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
  createDefaultHandwritingPrompt,
} from "../src/notes/handwriting-domain.mjs";

test("workspace store seeds default handwriting profile and prompt", () => {
  const store = createStore();
  const notesStore = new NotesWorkspaceStore({ store, now: () => NOW });

  const workspace = notesStore.readWorkspace();

  assert.equal(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].id, DEFAULT_HANDWRITING_PROFILE_ID);
  assert.equal(workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID].id, DEFAULT_HANDWRITING_PROMPT_ID);
  assert.deepEqual(workspace.handwritingSampleOrder, []);
  assert.deepEqual(workspace.handwritingPromptOrder, [DEFAULT_HANDWRITING_PROMPT_ID]);
});

test("workspace store creates handwriting samples linked to source artifacts", () => {
  const store = createStore();
  const notesStore = new NotesWorkspaceStore({ store, now: () => NOW });
  const source = notesStore.createSourceArtifact({
    id: "src_hw_sample",
    kind: "image",
    body: "handwriting calibration sample",
    media: {
      schemaVersion: 1,
      files: [
        {
          kind: "image",
          name: "sample.png",
          mimeType: "image/png",
          sizeBytes: 100,
          workspacePath: "notes-captures/sample.png",
        },
      ],
    },
  });

  const prompt = createDefaultHandwritingPrompt({ createdAt: NOW });
  const sample = notesStore.createHandwritingSample({
    id: "hw_sample_1",
    profileId: DEFAULT_HANDWRITING_PROFILE_ID,
    prompt,
    sourceArtifactId: source.id,
    image: source.media.files[0],
  });

  const workspace = notesStore.readWorkspace();
  assert.equal(sample.referenceText, prompt.referenceText);
  assert.equal(workspace.handwritingSamples.hw_sample_1.sourceArtifactId, "src_hw_sample");
  assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, ["hw_sample_1"]);
  assert.deepEqual(workspace.handwritingSampleOrder, ["hw_sample_1"]);
});

test("workspace store toggles handwriting sample active state", () => {
  const store = createStore();
  const notesStore = new NotesWorkspaceStore({ store, now: () => NOW });
  const source = notesStore.createSourceArtifact({
    id: "src_hw_sample",
    kind: "image",
    media: {
      schemaVersion: 1,
      files: [
        {
          kind: "image",
          name: "sample.png",
          mimeType: "image/png",
          sizeBytes: 100,
          workspacePath: "notes-captures/sample.png",
        },
      ],
    },
  });
  const prompt = createDefaultHandwritingPrompt({ createdAt: NOW });
  notesStore.createHandwritingSample({
    id: "hw_sample_1",
    profileId: DEFAULT_HANDWRITING_PROFILE_ID,
    prompt,
    sourceArtifactId: source.id,
    image: source.media.files[0],
  });

  notesStore.toggleHandwritingSample("hw_sample_1", { active: false });
  let workspace = notesStore.readWorkspace();
  assert.equal(workspace.handwritingSamples.hw_sample_1.active, false);
  assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);

  notesStore.toggleHandwritingSample("hw_sample_1", { active: true });
  workspace = notesStore.readWorkspace();
  assert.equal(workspace.handwritingSamples.hw_sample_1.active, true);
  assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, ["hw_sample_1"]);
});
```

If `control-plane/test/notes-workspace-store.test.mjs` already imports from `handwriting-domain.mjs`, merge the named imports rather than adding a duplicate import block.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test control-plane/test/notes-workspace-store.test.mjs
```

Expected: FAIL with missing `handwritingProfiles` or missing `createHandwritingSample`.

- [ ] **Step 3: Implement workspace store handwriting state**

Modify `control-plane/src/notes/workspace-store.mjs`:

```js
import {
  createDefaultHandwritingProfile,
  createDefaultHandwritingPrompt,
  createHandwritingSample as createHandwritingSampleDomain,
  toggleHandwritingSampleActive,
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
} from "./handwriting-domain.mjs";
```

Update constants:

```js
const NOTES_OBJECT_MAP_FIELDS = [
  "items",
  "sourceArtifacts",
  "derivedArtifacts",
  "comments",
  "proposals",
  "runs",
  "handwritingProfiles",
  "handwritingPrompts",
  "handwritingSamples",
];
const NOTES_ARRAY_FIELDS = ["itemOrder", "sourceOrder", "runOrder", "handwritingSampleOrder", "handwritingPromptOrder"];
```

Update `initialNotesState()`:

```js
function initialNotesState() {
  return {
    schemaVersion: 1,
    items: {},
    itemOrder: [],
    sourceArtifacts: {},
    sourceOrder: [],
    derivedArtifacts: {},
    comments: {},
    proposals: {},
    runs: {},
    runOrder: [],
    handwritingProfiles: {},
    handwritingPrompts: {},
    handwritingSamples: {},
    handwritingSampleOrder: [],
    handwritingPromptOrder: [],
  };
}
```

Add this helper after `ensureNotesState` prepares object/array fields:

```js
function ensureHandwritingDefaults(notes, now = nowIso) {
  if (!Object.hasOwn(notes.handwritingProfiles, DEFAULT_HANDWRITING_PROFILE_ID)) {
    notes.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID] = createDefaultHandwritingProfile({ createdAt: now() });
  }
  if (!Object.hasOwn(notes.handwritingPrompts, DEFAULT_HANDWRITING_PROMPT_ID)) {
    notes.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID] = createDefaultHandwritingPrompt({ createdAt: now() });
  }
  if (!notes.handwritingPromptOrder.includes(DEFAULT_HANDWRITING_PROMPT_ID)) {
    notes.handwritingPromptOrder.push(DEFAULT_HANDWRITING_PROMPT_ID);
  }
}
```

In `readWorkspace()` and `updateWorkspace(mutator)`, call `ensureHandwritingDefaults(notes, this.now)` before returning or mutating. Add these methods to `NotesWorkspaceStore`:

```js
getDefaultHandwritingPrompt() {
  const workspace = this.readWorkspace();
  return workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID];
}

createHandwritingSample(input) {
  const sampleId = createRecordId(input, "hw_sample", "handwriting sample id");
  const profileId = canonicalId(input.profileId || DEFAULT_HANDWRITING_PROFILE_ID, "handwriting profile id");
  const sourceArtifactId = canonicalId(input.sourceArtifactId, "source artifact id");
  return this.updateWorkspace((workspace) => {
    assertUniqueId(workspace.handwritingSamples, sampleId, "handwriting sample id");
    const profile = workspace.handwritingProfiles[profileId];
    if (!profile) throw new Error(`unknown handwriting profile: ${profileId}`);
    const prompt = input.prompt || workspace.handwritingPrompts[input.promptId || DEFAULT_HANDWRITING_PROMPT_ID];
    if (!prompt) throw new Error(`unknown handwriting prompt: ${input.promptId}`);
    if (!Object.hasOwn(workspace.sourceArtifacts, sourceArtifactId)) {
      throw new Error(`unknown source artifact: ${sourceArtifactId}`);
    }
    const sample = createHandwritingSampleDomain({
      ...input,
      id: sampleId,
      profileId,
      prompt,
      sourceArtifactId,
      createdAt: input.createdAt || this.now(),
    });
    workspace.handwritingSamples[sample.id] = sample;
    workspace.handwritingSampleOrder.push(sample.id);
    const toggled = toggleHandwritingSampleActive({ profile, sample, active: sample.active, updatedAt: sample.createdAt });
    workspace.handwritingProfiles[profileId] = toggled.profile;
    workspace.handwritingSamples[sample.id] = toggled.sample;
    return workspace.handwritingSamples[sample.id];
  });
}

toggleHandwritingSample(sampleId, { active }) {
  const id = canonicalId(sampleId, "handwriting sample id");
  return this.updateWorkspace((workspace) => {
    const sample = workspace.handwritingSamples[id];
    if (!sample) throw new Error(`unknown handwriting sample: ${id}`);
    const profile = workspace.handwritingProfiles[sample.profileId];
    if (!profile) throw new Error(`unknown handwriting profile: ${sample.profileId}`);
    const toggled = toggleHandwritingSampleActive({ profile, sample, active, updatedAt: this.now() });
    workspace.handwritingProfiles[sample.profileId] = toggled.profile;
    workspace.handwritingSamples[id] = toggled.sample;
    return toggled.sample;
  });
}
```

- [ ] **Step 4: Run workspace store tests**

Run:

```bash
node --test control-plane/test/notes-workspace-store.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/workspace-store.mjs control-plane/test/notes-workspace-store.test.mjs
git commit -m "Persist handwriting calibration samples"
```

## Task 3: Image Media Conversion Helper

**Files:**
- Create: `control-plane/src/notes/image-media.mjs`
- Create: `control-plane/test/notes-image-media.test.mjs`
- Modify: `control-plane/src/notes/routes.mjs`
- Modify: `control-plane/test/notes-routes.test.mjs`

- [ ] **Step 1: Write failing image-media tests**

Create `control-plane/test/notes-image-media.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  captureMimeTypeFromUpload,
  normalizeUploadedImageMediaFile,
} from "../src/notes/image-media.mjs";

test("captureMimeTypeFromUpload recognizes HEIC and HEIF filenames", () => {
  assert.equal(captureMimeTypeFromUpload({ filename: "IMG_1001.HEIC", headers: {}, data: Buffer.from("x") }), "image/heic");
  assert.equal(captureMimeTypeFromUpload({ filename: "IMG_1002.heif", headers: {}, data: Buffer.from("x") }), "image/heif");
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
```

- [ ] **Step 2: Run image-media tests to verify failure**

Run:

```bash
node --test control-plane/test/notes-image-media.test.mjs
```

Expected: FAIL with `Cannot find module ... image-media.mjs`.

- [ ] **Step 3: Extract image media helpers**

Create `control-plane/src/notes/image-media.mjs` by moving the image constants and helper functions from `control-plane/src/notes/routes.mjs` into this focused module. Export:

```js
export const NATIVE_NOTES_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const HEIF_IMAGE_MIME_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
export const NOTES_IMAGE_MIME_TYPES = new Set([...NATIVE_NOTES_IMAGE_MIME_TYPES, ...HEIF_IMAGE_MIME_TYPES]);
export const MAX_IMAGE_UPLOAD_BYTES = 40 * 1024 * 1024;
export const NOTES_CAPTURE_WORKSPACE_DIR = "notes-captures";
```

The module must provide these functions with the exact signatures used by tests and routes:

- `captureMimeTypeFromUpload(upload)`: lowercases `upload.headers["content-type"]`, strips any `;charset=...` suffix, falls back to the filename extension, and throws a 415-style error when the MIME type is not in `NOTES_IMAGE_MIME_TYPES`.
- `fileExtensionForMimeType(mimeType)`: returns `.png`, `.jpg`, or `.webp` for native supported images, and `.heic`/`.heif` for original source metadata only.
- `convertHeifToJpegWithSips({ mimeType, data })`: writes `data` to a temporary HEIF input file, invokes `/usr/bin/sips -s format jpeg`, reads the converted output, enforces the post-conversion size limit, removes the temporary files, and returns `{ mimeType: "image/jpeg", data }`.
- `convertHeifToPngWithSips({ mimeType, data })`: same as JPEG conversion, but invokes `/usr/bin/sips -s format png` and returns `{ mimeType: "image/png", data }`.
- `writeWorkspaceCaptureFile({ workspaceHostPath, mimeType, data })`: creates `notes-captures`, writes a random filename with the extension from `fileExtensionForMimeType`, and returns `{ workspacePath, hostPath, name, mimeType, sizeBytes }`.
- `normalizeUploadedImageMediaFile(upload, options = {})`: validates pre-conversion upload size, converts HEIF/HEIC to `options.targetFormat || "jpeg"`, writes the final supported image through `writeWorkspaceCaptureFile`, and returns the existing route media file shape plus `original` metadata when conversion occurred.

Use this conversion dispatch inside `normalizeUploadedImageMediaFile` after validating the upload MIME type:

```js
const targetFormat = options.targetFormat || "jpeg";
const convertHeif = options.convertHeif || (targetFormat === "png" ? convertHeifToPngWithSips : convertHeifToJpegWithSips);
```

Use `/usr/bin/sips` with `["-s", "format", target, inputPath, "--out", outputPath]` where `target` is `"png"` or `"jpeg"`. Keep the existing 40 MiB pre/post conversion limit and original metadata fields.

- [ ] **Step 4: Update routes to use image-media helpers**

In `control-plane/src/notes/routes.mjs`, remove the duplicated local image helper definitions that moved to `image-media.mjs`, and import:

```js
import {
  MAX_IMAGE_UPLOAD_BYTES,
  NATIVE_NOTES_IMAGE_MIME_TYPES,
  captureMimeTypeFromUpload,
  normalizeUploadedImageMediaFile,
} from "./image-media.mjs";
```

Keep existing ordinary capture behavior by calling:

```js
const file = await normalizeUploadedImageMediaFile(files[0], {
  detail,
  workspaceHostPath: options.workspaceHostPath,
  targetFormat: "jpeg",
  convertHeif: options.convertHeifToJpeg,
});
```

If tests currently inject `notesImageConverter`, preserve that injection by passing it as `convertHeif`.

- [ ] **Step 5: Run image and route tests**

Run:

```bash
node --test control-plane/test/notes-image-media.test.mjs control-plane/test/notes-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/notes/image-media.mjs control-plane/src/notes/routes.mjs control-plane/test/notes-image-media.test.mjs control-plane/test/notes-routes.test.mjs
git commit -m "Extract notes image media conversion"
```

## Task 4: Handwriting API Routes

**Files:**
- Modify: `control-plane/src/notes/routes.mjs`
- Modify: `control-plane/test/notes-routes.test.mjs`

- [ ] **Step 1: Write failing route tests**

Append tests to `control-plane/test/notes-routes.test.mjs`:

```js
test("handwriting default prompt route returns calibration text", async () => {
  const harness = createNotesRoutesHarness();
  const response = await harness.request("GET", "/api/notes/handwriting/prompts/default");

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.prompt.id, "hw_prompt_v1");
  assert.match(response.payload.prompt.referenceText, /Monday Jan 5 at 10:30 AM/u);
  assert.ok(response.payload.prompt.coverage.ambiguousPairs.includes("m/n/u/w"));
});

test("handwriting profile route returns default profile projection", async () => {
  const harness = createNotesRoutesHarness();
  const response = await harness.request("GET", "/api/notes/handwriting/profile");

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.profile.id, "profile_default");
  assert.equal(response.payload.prompt.id, "hw_prompt_v1");
  assert.deepEqual(response.payload.samples, []);
});

test("handwriting sample upload stores PNG converted calibration sample", async () => {
  const heicData = Buffer.from("fake-heic");
  const pngData = Buffer.from("converted-png");
  const harness = createNotesRoutesHarness({
    notesImageConverter: async () => ({ mimeType: "image/png", data: pngData }),
  });
  const prompt = await harness.request("GET", "/api/notes/handwriting/prompts/default");
  const boundary = "beep-notes-handwriting";
  const body = multipartBody({
    boundary,
    fields: {
      profileId: "profile_default",
      promptId: "hw_prompt_v1",
      referenceText: prompt.payload.prompt.referenceText,
    },
    file: { filename: "IMG_5308.HEIC", mimeType: "image/heic", data: heicData },
  });

  const response = await harness.request("POST", "/api/notes/handwriting/samples", {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.sample.profileId, "profile_default");
  assert.equal(response.payload.sample.promptId, "hw_prompt_v1");
  assert.equal(response.payload.sample.image.mimeType, "image/png");
  assert.equal(response.payload.sample.image.originalMimeType, "image/heic");
  assert.match(response.payload.sample.image.workspacePath, /^notes-captures\/.+\.png$/u);
  assert.equal(response.payload.source.kind, "image");

  const profile = await harness.request("GET", "/api/notes/handwriting/profile");
  assert.deepEqual(profile.payload.profile.activeSampleIds, [response.payload.sample.id]);
  assert.equal(profile.payload.samples.length, 1);
});

test("handwriting sample toggle updates active sample projection", async () => {
  const harness = createNotesRoutesHarness({
    notesImageConverter: async () => ({ mimeType: "image/png", data: Buffer.from("converted-png") }),
  });
  const prompt = await harness.request("GET", "/api/notes/handwriting/prompts/default");
  const boundary = "beep-notes-handwriting";
  const body = multipartBody({
    boundary,
    fields: {
      profileId: "profile_default",
      promptId: "hw_prompt_v1",
      referenceText: prompt.payload.prompt.referenceText,
    },
    file: { filename: "IMG_5308.HEIC", mimeType: "image/heic", data: Buffer.from("fake-heic") },
  });
  const created = await harness.request("POST", "/api/notes/handwriting/samples", {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });

  const toggled = await harness.request("POST", `/api/notes/handwriting/samples/${created.payload.sample.id}/toggle`, {
    body: { active: false },
  });

  assert.equal(toggled.statusCode, 200);
  assert.equal(toggled.payload.sample.active, false);
  assert.deepEqual(toggled.payload.profile.activeSampleIds, []);
});
```

If helper names differ in the existing test harness, adapt only the harness call sites while keeping these assertions.

- [ ] **Step 2: Run route tests to verify failure**

Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

Expected: FAIL with `404` for handwriting endpoints.

- [ ] **Step 3: Implement route handlers**

In `control-plane/src/notes/routes.mjs`, import:

```js
import {
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
} from "./handwriting-domain.mjs";
```

Add helpers:

```js
function handwritingProfileProjection(notesStore) {
  const workspace = notesStore.readWorkspace();
  const profile = workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID];
  const prompt = workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID];
  const samples = profile.activeSampleIds
    .map((id) => workspace.handwritingSamples[id])
    .filter(Boolean);
  return { profile, prompt, samples };
}
```

Add route branches before generic not-found handling:

```js
if (method === "GET" && pathname === "/api/notes/handwriting/prompts/default") {
  const prompt = notesStore.getDefaultHandwritingPrompt();
  return json(res, 200, { ok: true, prompt });
}

if (method === "GET" && pathname === "/api/notes/handwriting/profile") {
  return json(res, 200, { ok: true, ...handwritingProfileProjection(notesStore) });
}
```

Implement sample upload using the same multipart parser as captures, but call `normalizeUploadedImageMediaFile` with `targetFormat: "png"`:

```js
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
    profileId: String(fields.profileId || DEFAULT_HANDWRITING_PROFILE_ID).trim(),
    promptId: String(fields.promptId || DEFAULT_HANDWRITING_PROMPT_ID).trim(),
    referenceText,
    file,
  };
}
```

For `POST /api/notes/handwriting/samples`, create a source artifact:

```js
const input = await normalizeMultipartHandwritingSampleInput(request, {
  workspaceHostPath: config.workspaceHostPath,
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
return json(res, 200, { ok: true, source, sample, ...handwritingProfileProjection(notesStore) });
```

For sample toggle:

```js
const match = pathname.match(/^\/api\/notes\/handwriting\/samples\/([^/]+)\/toggle$/u);
if (method === "POST" && match) {
  const body = await readJsonBody(request);
  const sample = notesStore.toggleHandwritingSample(decodeURIComponent(match[1]), { active: body.active !== false });
  return json(res, 200, { ok: true, sample, ...handwritingProfileProjection(notesStore) });
}
```

- [ ] **Step 4: Run route tests**

Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/routes.mjs control-plane/test/notes-routes.test.mjs
git commit -m "Add handwriting calibration routes"
```

## Task 5: Gateway And Pipeline Handwriting Metadata

**Files:**
- Modify: `control-plane/src/notes/beep-gateway.mjs`
- Modify: `control-plane/src/notes/pipeline-engine.mjs`
- Modify: `control-plane/test/notes-beep-gateway.test.mjs`
- Modify: `control-plane/test/notes-pipeline-engine.test.mjs`

- [ ] **Step 1: Write failing gateway tests**

Append to `control-plane/test/notes-beep-gateway.test.mjs`:

```js
test("local agent gateway sends handwriting calibration samples before current image", async () => {
  const calls = [];
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async (request) => {
      calls.push(request);
      return {
        ok: true,
        finalText: JSON.stringify({
          derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam.", sourceArtifactIds: ["src_current"] }],
          handwriting: { sampleIdsUsed: ["hw_sample_1"], uncertainSpans: [] },
        }),
      };
    },
  });

  const output = await gateway.runStage("readableRendition", {
    sourceArtifactId: "src_current",
    attachments: [{ type: "localImage", path: "notes-captures/current.png", detail: "original" }],
    handwriting: {
      enabled: true,
      samples: [
        {
          id: "hw_sample_1",
          promptId: "hw_prompt_v1",
          referenceText: "Monday Jan 5 at 10:30 AM - Call Sam.",
          coverage: { ambiguousPairs: ["m/n/u/w"], domainTerms: ["call"] },
          imagePart: { type: "localImage", path: "notes-captures/sample.png", detail: "original" },
        },
      ],
      lexicon: ["Sam"],
    },
  });

  assert.equal(output.handwriting.sampleIdsUsed[0], "hw_sample_1");
  const input = calls[0].input;
  assert.equal(input.filter((part) => part.type === "localImage").length, 2);
  assert.equal(input.findIndex((part) => part.path === "notes-captures/sample.png") < input.findIndex((part) => part.path === "notes-captures/current.png"), true);
  assert.match(input.map((part) => part.text || "").join("\n"), /Calibration sample hw_sample_1 exact reference text/u);
});

test("validateStageOutput accepts handwriting uncertainty metadata", () => {
  const output = validateStageOutput({
    derivedArtifacts: [{ kind: "readableRendition", body: "Power pants", sourceArtifactIds: ["src_current"] }],
    handwriting: {
      sampleIdsUsed: ["hw_sample_1"],
      uncertainSpans: [{ text: "Power pants", alternatives: ["Power plans"], reason: "ambiguous word" }],
    },
  });

  assert.deepEqual(output.handwriting, {
    sampleIdsUsed: ["hw_sample_1"],
    uncertainSpans: [{ text: "Power pants", alternatives: ["Power plans"], reason: "ambiguous word" }],
  });
});
```

- [ ] **Step 2: Write failing pipeline metadata test**

Append to `control-plane/test/notes-pipeline-engine.test.mjs`:

```js
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
```

- [ ] **Step 3: Run gateway and pipeline tests to verify failure**

Run:

```bash
node --test control-plane/test/notes-beep-gateway.test.mjs control-plane/test/notes-pipeline-engine.test.mjs
```

Expected: FAIL because `handwriting` metadata is not preserved or calibration inputs are not added.

- [ ] **Step 4: Implement gateway handwriting support**

In `control-plane/src/notes/beep-gateway.mjs`, import:

```js
import { normalizeHandwritingStageMetadata } from "./handwriting-domain.mjs";
```

Update `validateStageOutput(raw)` return shape:

```js
return {
  comments,
  proposals,
  derivedArtifacts,
  ...(input.handwriting !== undefined ? { handwriting: normalizeHandwritingStageMetadata(input.handwriting) } : {}),
};
```

Add helpers:

```js
function handwritingInputParts(stage, context) {
  if (stage !== "readableRendition" || !context.handwriting?.enabled) return [];
  const parts = [
    {
      type: "text",
      text: [
        "Handwriting calibration is enabled.",
        "Each calibration image is a handwritten copy of the exact reference text immediately before it.",
        "Use those image/reference pairs to infer this user's letter shapes, spacing, shorthand, and ambiguous forms before reading the current capture.",
        "Return uncertain words in handwriting.uncertainSpans instead of guessing confidently.",
      ].join("\n"),
    },
  ];
  if (context.handwriting.lexicon?.length) {
    parts.push({ type: "text", text: `User handwriting lexicon: ${context.handwriting.lexicon.join(", ")}` });
  }
  for (const sample of context.handwriting.samples || []) {
    parts.push({
      type: "text",
      text: `Calibration sample ${sample.id} exact reference text:\n${sample.referenceText}`,
    });
    parts.push(structuredClone(sample.imagePart));
  }
  parts.push({ type: "text", text: "Current capture to transcribe follows." });
  return parts;
}
```

Update `nativeInputForStage`:

```js
function nativeInputForStage(stage, context) {
  return [
    { type: "text", text: stagePrompt(stage, context) },
    ...handwritingInputParts(stage, context),
    ...attachmentInputParts(context),
  ];
}
```

Update `stagePrompt` readable-rendition instruction to mention `handwriting` output:

```js
"If handwriting calibration is enabled, include handwriting.sampleIdsUsed and handwriting.uncertainSpans when useful.",
```

- [ ] **Step 5: Implement pipeline handwriting output merge**

In `control-plane/src/notes/pipeline-engine.mjs`, initialize outputs with handwriting:

```js
outputs: { derivedArtifacts: [], comments: [], proposals: [], handwriting: null },
```

Update `mergeOutputs`:

```js
return {
  derivedArtifacts: [...outputs.derivedArtifacts, ...outputArray(stageOutput, "derivedArtifacts")],
  comments: [...outputs.comments, ...outputArray(stageOutput, "comments")],
  proposals: [...outputs.proposals, ...outputArray(stageOutput, "proposals")],
  handwriting: stageOutput.handwriting === undefined ? outputs.handwriting || null : stageOutput.handwriting,
};
```

- [ ] **Step 6: Run gateway and pipeline tests**

Run:

```bash
node --test control-plane/test/notes-beep-gateway.test.mjs control-plane/test/notes-pipeline-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/notes/beep-gateway.mjs control-plane/src/notes/pipeline-engine.mjs control-plane/test/notes-beep-gateway.test.mjs control-plane/test/notes-pipeline-engine.test.mjs
git commit -m "Add handwriting calibration context to Notes pipeline"
```

## Task 6: Route Processing Uses Handwriting Context

**Files:**
- Modify: `control-plane/src/notes/routes.mjs`
- Modify: `control-plane/test/notes-routes.test.mjs`

- [ ] **Step 1: Write failing processing route test**

Append to `control-plane/test/notes-routes.test.mjs`:

```js
test("capture processing route includes active handwriting calibration samples", async () => {
  const runtimeBodies = [];
  const harness = createNotesRoutesHarness({
    notesImageConverter: async ({ name }) => ({
      mimeType: name?.includes("sample") ? "image/png" : "image/jpeg",
      data: Buffer.from(name?.includes("sample") ? "sample-png" : "capture-jpeg"),
    }),
    forwardRuntimeRequest: async (_path, request) => {
      runtimeBodies.push(request.body);
      return {
        ok: true,
        finalText: JSON.stringify({
          derivedArtifacts: [{ kind: "readableRendition", body: "Calibrated read.", sourceArtifactIds: ["src_current"] }],
          handwriting: { sampleIdsUsed: ["hw_sample_known"], uncertainSpans: [] },
        }),
      };
    },
  });
  const prompt = await harness.request("GET", "/api/notes/handwriting/prompts/default");
  const sampleBody = multipartBody({
    boundary: "sample-boundary",
    fields: {
      profileId: "profile_default",
      promptId: "hw_prompt_v1",
      referenceText: prompt.payload.prompt.referenceText,
    },
    file: { filename: "sample.HEIC", mimeType: "image/heic", data: Buffer.from("sample-heic") },
  });
  await harness.request("POST", "/api/notes/handwriting/samples", {
    headers: { "content-type": "multipart/form-data; boundary=sample-boundary" },
    body: sampleBody,
  });
  const captureBody = multipartBody({
    boundary: "capture-boundary",
    fields: { id: "src_current", kind: "image", body: "new handwriting", detail: "original" },
    file: { filename: "capture.HEIC", mimeType: "image/heic", data: Buffer.from("capture-heic") },
  });
  const capture = await harness.request("POST", "/api/notes/captures", {
    headers: { "content-type": "multipart/form-data; boundary=capture-boundary" },
    body: captureBody,
  });

  const processed = await harness.request("POST", `/api/notes/captures/${capture.payload.source.id}/process`, {
    body: { beepMode: "localAgent", reviewPolicy: "stepReview", useHandwritingCalibration: true },
  });

  assert.equal(processed.statusCode, 200);
  const firstInput = runtimeBodies[0].input;
  const localImages = firstInput.filter((part) => part.type === "localImage");
  assert.equal(localImages.length, 2);
  assert.match(firstInput.map((part) => part.text || "").join("\n"), /Calibration sample/u);
  assert.match(firstInput.map((part) => part.text || "").join("\n"), /Current capture to transcribe follows/u);
});
```

- [ ] **Step 2: Run route test to verify failure**

Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

Expected: FAIL because processing ignores `useHandwritingCalibration`.

- [ ] **Step 3: Build handwriting context in capture processing**

In `control-plane/src/notes/routes.mjs`, import:

```js
import { buildHandwritingContext } from "./handwriting-domain.mjs";
```

Add:

```js
function handwritingContextForWorkspace(workspace, enabled) {
  return buildHandwritingContext({
    enabled,
    profile: workspace.handwritingProfiles?.profile_default,
    samples: workspace.handwritingSamples || {},
  });
}
```

In the capture processing route before `runPipeline`, read the workspace and pass handwriting context:

```js
const workspace = notesStore.readWorkspace();
const handwriting = handwritingContextForWorkspace(workspace, body.useHandwritingCalibration === true);
const run = await runPipeline(existingRun, {
  gateway,
  context: {
    sourceArtifactId: source.id,
    attachments: await imageInputPartsForSource(source, { convertHeifToJpeg: notesImageConverter }),
    handwriting,
  },
});
```

If the current route creates `context` inline, merge `handwriting` into that existing object.

- [ ] **Step 4: Run route tests**

Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/routes.mjs control-plane/test/notes-routes.test.mjs
git commit -m "Use handwriting calibration during capture processing"
```

## Task 7: Demo UI Calibration Panel

**Files:**
- Modify: `control-plane/src/notes/demo-web.mjs`
- Modify: `control-plane/test/notes-demo-web.test.mjs`

- [ ] **Step 1: Write failing demo web tests**

Append to `control-plane/test/notes-demo-web.test.mjs`:

```js
test("/notes/app.js includes handwriting calibration UI without base64 image reads", async () => {
  const result = await servedAsset("/notes/app.js");

  assert.match(result.body, /handwritingCalibrationForm/u);
  assert.match(result.body, /handwritingReferenceText/u);
  assert.match(result.body, /useHandwritingCalibration/u);
  assert.match(result.body, /new FormData\(\)/u);
  assert.doesNotMatch(result.body, /FileReader/u);
  assert.doesNotMatch(result.body, /readAsDataURL/u);
  assert.doesNotMatch(result.body, /dataUrl/u);
});

test("/notes serves handwriting calibration controls", async () => {
  const result = await servedAsset("/notes");

  assert.match(result.body, /Handwriting calibration/u);
  assert.match(result.body, /id="handwritingReferenceText"/u);
  assert.match(result.body, /id="handwritingImageInput"/u);
  assert.match(result.body, /id="useHandwritingCalibration"/u);
});
```

- [ ] **Step 2: Run demo web tests to verify failure**

Run:

```bash
node --test control-plane/test/notes-demo-web.test.mjs
```

Expected: FAIL because the calibration controls are absent.

- [ ] **Step 3: Add calibration markup**

In `control-plane/src/notes/demo-web.mjs`, add a new panel inside the existing create/capture region:

```html
<section class="panel-section" aria-labelledby="handwritingCalibrationHeading">
  <h3 id="handwritingCalibrationHeading">Handwriting calibration</h3>
  <p class="muted">Copy this text by hand, then upload a photo of the page.</p>
  <pre id="handwritingPromptText" class="calibration-copy"></pre>
  <form id="handwritingCalibrationForm">
    <label for="handwritingReferenceText">Reference text</label>
    <textarea id="handwritingReferenceText" rows="6"></textarea>
    <label for="handwritingImageInput">Handwritten copy image</label>
    <input id="handwritingImageInput" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif" />
    <button type="submit">Save handwriting sample</button>
  </form>
  <label class="inline-control">
    <input id="useHandwritingCalibration" type="checkbox" checked />
    <span>Use handwriting calibration</span>
  </label>
  <div id="handwritingSamplesList" class="record-list"></div>
</section>
```

- [ ] **Step 4: Add client state and API calls**

In the app script portion of `control-plane/src/notes/demo-web.mjs`, add state fields:

```js
handwriting: {
  profile: null,
  prompt: null,
  samples: [],
}
```

Add element bindings:

```js
handwritingCalibrationForm: document.querySelector("#handwritingCalibrationForm"),
handwritingReferenceText: document.querySelector("#handwritingReferenceText"),
handwritingImageInput: document.querySelector("#handwritingImageInput"),
handwritingPromptText: document.querySelector("#handwritingPromptText"),
handwritingSamplesList: document.querySelector("#handwritingSamplesList"),
useHandwritingCalibration: document.querySelector("#useHandwritingCalibration"),
```

Add functions:

```js
async function loadHandwritingProfile() {
  const payload = await api("/api/notes/handwriting/profile");
  state.handwriting.profile = payload.profile;
  state.handwriting.prompt = payload.prompt;
  state.handwriting.samples = payload.samples || [];
  elements.handwritingPromptText.textContent = payload.prompt.referenceText;
  elements.handwritingReferenceText.value = payload.prompt.referenceText;
  renderHandwritingSamples();
}

function renderHandwritingSamples() {
  elements.handwritingSamplesList.innerHTML = "";
  if (!state.handwriting.samples.length) {
    elements.handwritingSamplesList.textContent = "No handwriting samples yet.";
    return;
  }
  for (const sample of state.handwriting.samples) {
    const row = document.createElement("div");
    row.className = "record-row";
    row.innerHTML = `<strong>${escapeHtml(sample.image.originalName || sample.image.name || sample.id)}</strong><span>${escapeHtml(sample.promptId)}</span>`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = sample.active ? "Disable" : "Enable";
    button.addEventListener("click", () => toggleHandwritingSample(sample.id, !sample.active));
    row.append(button);
    elements.handwritingSamplesList.append(row);
  }
}

async function saveHandwritingSample() {
  const file = elements.handwritingImageInput.files?.[0];
  if (!file) throw new Error("A handwritten copy image is required.");
  const referenceText = elements.handwritingReferenceText.value.trim();
  if (!referenceText) throw new Error("Reference text is required.");
  const formData = new FormData();
  formData.set("profileId", "profile_default");
  formData.set("promptId", state.handwriting.prompt?.id || "hw_prompt_v1");
  formData.set("referenceText", referenceText);
  formData.set("image", file, file.name || "handwriting-image");
  await api("/api/notes/handwriting/samples", { method: "POST", body: formData });
  elements.handwritingImageInput.value = "";
  await loadHandwritingProfile();
}

async function toggleHandwritingSample(sampleId, active) {
  await api(`/api/notes/handwriting/samples/${encodeURIComponent(sampleId)}/toggle`, {
    method: "POST",
    body: { active },
  });
  await loadHandwritingProfile();
}
```

Update `runOptions()`:

```js
function runOptions() {
  return {
    reviewPolicy: elements.reviewPolicySelect.value,
    beepMode: elements.beepModeSelect.value,
    useHandwritingCalibration: elements.useHandwritingCalibration.checked,
  };
}
```

Call `await loadHandwritingProfile()` during startup after operator auth is available and bind:

```js
bindAsync(elements.handwritingCalibrationForm, "submit", saveHandwritingSample);
```

- [ ] **Step 5: Add uncertainty display**

In the selected source/run rendering area, add a compact block that reads from the latest run for the selected source:

```js
function selectedSourceRun() {
  const runs = Object.values(state.workspace?.runs || {});
  return runs.find((run) => run.sourceArtifactId === state.selectedSourceId) || null;
}

function renderHandwritingUncertainty() {
  const run = selectedSourceRun();
  const spans = run?.outputs?.handwriting?.uncertainSpans || [];
  if (!spans.length) return "No handwriting uncertainty reported.";
  return spans.map((span) => `${span.text}: ${span.alternatives.join(", ")} (${span.reason})`).join("\n");
}
```

Render the returned text under the readable rendition section.

- [ ] **Step 6: Run demo web tests**

Run:

```bash
node --test control-plane/test/notes-demo-web.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/notes/demo-web.mjs control-plane/test/notes-demo-web.test.mjs
git commit -m "Add handwriting calibration panel to Notes demo"
```

## Task 8: Package Script And Static Verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the notes static test script**

In `package.json`, update `test:notes-backbone-static` to include the new test file:

```json
"test:notes-backbone-static": "node --test control-plane/test/notes-workspace-domain.test.mjs control-plane/test/notes-workspace-store.test.mjs control-plane/test/notes-handwriting-domain.test.mjs control-plane/test/notes-image-media.test.mjs control-plane/test/notes-pipeline-engine.test.mjs control-plane/test/notes-beep-gateway.test.mjs control-plane/test/notes-routes.test.mjs control-plane/test/notes-demo-web.test.mjs && bash -n scripts/smoke-test-beep-notes-backbone.sh"
```

- [ ] **Step 2: Run the full static notes suite**

Run:

```bash
npm run test:notes-backbone-static
```

Expected: PASS with all notes tests passing and shell syntax check passing.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Include handwriting tests in Notes static suite"
```

## Task 9: Live End-To-End Proof

**Files:**
- No required source edits.
- Evidence target: `/Users/ash/Downloads/IMG_5308.HEIC`

- [ ] **Step 1: Start or restart the local control plane**

Run with the same auth path used by the Notes demo:

```bash
BEEP_CONTROL_PLANE_PORT=18789 BEEP_CONTROL_PLANE_AUTOSTART=0 BEEP_CONTROL_PLANE_CODEX_AUTH_PATH=/Users/ash/.codex/worktrees/4869/Beep2/.beep-dev/state/codex/auth.json node control-plane/src/server.mjs
```

Expected: server listens on `http://127.0.0.1:18789`.

- [ ] **Step 2: Verify health**

Run:

```bash
curl -fsS http://127.0.0.1:18789/health
```

Expected: JSON health response with `ok: true`.

- [ ] **Step 3: Upload a handwriting calibration sample with `IMG_5308.HEIC`**

Use the operator token from the local app session:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $BEEP_OPERATOR_TOKEN" \
  -F "profileId=profile_default" \
  -F "promptId=hw_prompt_v1" \
  -F "referenceText=$(curl -fsS -H "Authorization: Bearer $BEEP_OPERATOR_TOKEN" http://127.0.0.1:18789/api/notes/handwriting/prompts/default | node -e 'let s=\"\";process.stdin.on(\"data\",c=>s+=c);process.stdin.on(\"end\",()=>process.stdout.write(JSON.parse(s).prompt.referenceText))')" \
  -F "image=@/Users/ash/Downloads/IMG_5308.HEIC;type=image/heic;filename=IMG_5308.HEIC" \
  http://127.0.0.1:18789/api/notes/handwriting/samples
```

Expected: `ok: true`, `sample.image.mimeType: "image/png"`, original HEIC metadata present, and active sample id in profile.

- [ ] **Step 4: Upload a target handwriting capture**

Run:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $BEEP_OPERATOR_TOKEN" \
  -F "kind=image" \
  -F "body=Handwriting target capture for calibration proof" \
  -F "detail=original" \
  -F "image=@/Users/ash/Downloads/IMG_5308.HEIC;type=image/heic;filename=IMG_5308.HEIC" \
  http://127.0.0.1:18789/api/notes/captures
```

Expected: `ok: true`, a new `source.id`, and converted supported image metadata.

- [ ] **Step 5: Process target capture with calibration enabled**

Run:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $BEEP_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"beepMode":"localAgent","reviewPolicy":"stepReview","useHandwritingCalibration":true}' \
  "http://127.0.0.1:18789/api/notes/captures/$SOURCE_ID/process"
```

Expected: run pauses at `formattedNote`, `readableRendition` completes, `outputs.handwriting.sampleIdsUsed` includes the calibration sample when the model returns metadata.

- [ ] **Step 6: Inspect runtime request ledger**

Run:

```bash
curl -fsS -H "Authorization: Bearer $BEEP_OPERATOR_TOKEN" "http://127.0.0.1:18789/api/agent/requests?limit=1"
```

Expected: latest request has at least two `localImage` input parts: one calibration sample and one current capture. `totalInlineImageBytes` remains `0`.

- [ ] **Step 7: Commit any live-proof script updates**

If no source files changed, do not commit. If a smoke script was updated with reusable proof commands:

```bash
git add scripts/smoke-test-beep-notes-backbone.sh
git commit -m "Add handwriting calibration smoke proof"
```

## Final Verification

- [ ] **Run static suite**

```bash
npm run test:notes-backbone-static
```

Expected: PASS.

- [ ] **Run focused route and gateway suite**

```bash
node --test control-plane/test/notes-handwriting-domain.test.mjs control-plane/test/notes-image-media.test.mjs control-plane/test/notes-beep-gateway.test.mjs control-plane/test/notes-routes.test.mjs
```

Expected: PASS.

- [ ] **Check git status**

```bash
git status --short
```

Expected: no uncommitted source/test/doc changes except intentionally ignored local runtime state.

## Self-Review Notes

- Spec coverage: Tasks cover default calibration prompt, sample upload, PNG conversion for HEIC/HEIF calibration samples, workspace profile/sample state, route APIs, pipeline context enrichment, native `localImage` forwarding, uncertainty metadata, UI controls, and live proof.
- Placeholder scan: No task relies on undefined future work, training, embeddings, or correction memory.
- Type consistency: Plan consistently uses `profile_default`, `hw_prompt_v1`, `handwritingProfiles`, `handwritingPrompts`, `handwritingSamples`, `outputs.handwriting`, `sampleIdsUsed`, and `uncertainSpans`.
