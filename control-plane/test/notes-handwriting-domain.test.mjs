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
  assert.equal(prompt.promptVersion, "v2");
  assert.match(prompt.referenceText, /At the beginning of a quiet Monday meeting/u);
  assert.match(prompt.referenceText, /invoice #6190/u);
  assert.match(prompt.referenceText, /q, x, z, j, k, v, y, and w/u);
  assert.ok(prompt.referenceText.trim().split(/\s+/u).length > 350);
  assert.deepEqual(prompt.coverage.digits, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.ok(prompt.coverage.ambiguousPairs.includes("m/n/u/w"));
  assert.ok(prompt.coverage.domainTerms.includes("meeting"));
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
  const image = {
    workspacePath: "notes-captures/hw_sample_1.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    originalName: "IMG_1001.HEIC",
    originalMimeType: "image/heic",
    originalSizeBytes: 2345,
    convertedFrom: "image/heic",
  };
  const sample = createHandwritingSample({
    id: "hw_sample_1",
    profileId: DEFAULT_HANDWRITING_PROFILE_ID,
    prompt,
    sourceArtifactId: "src_hw_1",
    image,
    createdAt: NOW,
  });

  assert.equal(sample.promptId, DEFAULT_HANDWRITING_PROMPT_ID);
  assert.equal(sample.referenceText, prompt.referenceText);
  assert.deepEqual(sample.coverage, prompt.coverage);
  assert.equal(sample.active, true);
  assert.notEqual(sample.image, image);
  assert.equal(sample.image.mimeType, "image/png");
  assert.equal(sample.image.originalMimeType, "image/heic");
});

test("handwriting sample requires image workspace path and mime type", () => {
  const prompt = createDefaultHandwritingPrompt({ createdAt: NOW });
  const base = {
    id: "hw_sample_invalid_image",
    profileId: DEFAULT_HANDWRITING_PROFILE_ID,
    prompt,
    sourceArtifactId: "src_hw_invalid_image",
    createdAt: NOW,
  };

  assert.throws(
    () =>
      createHandwritingSample({
        ...base,
        image: { workspacePath: "", mimeType: "image/png" },
      }),
    /sample image workspacePath is required/u,
  );
  assert.throws(
    () =>
      createHandwritingSample({
        ...base,
        image: { workspacePath: "   ", mimeType: "image/png" },
      }),
    /sample image workspacePath is required/u,
  );
  assert.throws(
    () =>
      createHandwritingSample({
        ...base,
        image: { workspacePath: "notes-captures/hw_sample.png" },
      }),
    /sample image mimeType is required/u,
  );
  assert.throws(
    () =>
      createHandwritingSample({
        ...base,
        image: { workspacePath: "notes-captures/hw_sample.png", mimeType: "   " },
      }),
    /sample image mimeType is required/u,
  );
});

test("toggleHandwritingSampleActive updates sample and profile active ids", () => {
  const profile = createDefaultHandwritingProfile({ createdAt: NOW });
  const sample = { id: "hw_sample_1", active: true, updatedAt: NOW };

  const inactive = toggleHandwritingSampleActive({
    profile,
    sample,
    active: false,
    updatedAt: "2026-06-15T17:01:00.000Z",
  });
  assert.equal(inactive.sample.active, false);
  assert.deepEqual(inactive.profile.activeSampleIds, []);

  const active = toggleHandwritingSampleActive({
    profile: inactive.profile,
    sample: inactive.sample,
    active: true,
    updatedAt: "2026-06-15T17:02:00.000Z",
  });
  assert.equal(active.sample.active, true);
  assert.deepEqual(active.profile.activeSampleIds, ["hw_sample_1"]);
});

test("toggleHandwritingSampleActive requires a boolean active value", () => {
  const profile = createDefaultHandwritingProfile({ createdAt: NOW });
  const sample = { id: "hw_sample_1", active: true, updatedAt: NOW };

  assert.throws(
    () =>
      toggleHandwritingSampleActive({
        profile,
        sample,
        active: "false",
        updatedAt: "2026-06-15T17:01:00.000Z",
      }),
    /active must be a boolean/u,
  );
  assert.throws(
    () =>
      toggleHandwritingSampleActive({
        profile,
        sample,
        updatedAt: "2026-06-15T17:01:00.000Z",
      }),
    /active must be a boolean/u,
  );
});

test("buildHandwritingContext selects newest active samples", () => {
  const profile = {
    ...createDefaultHandwritingProfile({ createdAt: NOW }),
    activeSampleIds: ["sample_old", "sample_inactive", "sample_new", "sample_mid"],
    lexicon: ["Sam", "HAPC"],
  };
  const samples = {
    sample_old: {
      id: "sample_old",
      active: true,
      updatedAt: "2026-06-15T17:00:00.000Z",
      referenceText: "old",
      image: { workspacePath: "notes-captures/old.png", mimeType: "image/png" },
      coverage: { domainTerms: ["old"] },
    },
    sample_inactive: {
      id: "sample_inactive",
      active: false,
      updatedAt: "2026-06-15T17:03:00.000Z",
      referenceText: "inactive",
      image: { workspacePath: "notes-captures/inactive.png", mimeType: "image/png" },
      coverage: { domainTerms: ["inactive"] },
    },
    sample_new: {
      id: "sample_new",
      active: true,
      updatedAt: "2026-06-15T17:04:00.000Z",
      referenceText: "new",
      image: { workspacePath: "notes-captures/new.png", mimeType: "image/png", detail: "auto" },
      coverage: { domainTerms: ["new"] },
    },
    sample_mid: {
      id: "sample_mid",
      active: true,
      updatedAt: "2026-06-15T17:02:00.000Z",
      referenceText: "mid",
      image: { workspacePath: "notes-captures/mid.png", mimeType: "image/png" },
      coverage: { domainTerms: ["mid"] },
    },
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

test("normalizeHandwritingStageMetadata treats null as absent metadata", () => {
  assert.equal(normalizeHandwritingStageMetadata(undefined), null);
  assert.equal(normalizeHandwritingStageMetadata(null), null);
});
