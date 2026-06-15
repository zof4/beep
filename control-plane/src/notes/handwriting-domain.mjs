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
    .sort((left, right) =>
      String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")),
    )
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
