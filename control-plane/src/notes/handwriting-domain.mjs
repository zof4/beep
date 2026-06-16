export const DEFAULT_HANDWRITING_PROFILE_ID = "profile_default";
export const DEFAULT_HANDWRITING_PROMPT_ID = "hw_prompt_v2";

const DEFAULT_PROMPT_VERSION = "v2";

const DEFAULT_COVERAGE = Object.freeze({
  letters: Object.freeze(["a-z", "A-Z"]),
  digits: Object.freeze(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]),
  punctuation: Object.freeze(["-", "/", "(", ")", ":", "?", "->", "&", ".", ",", ";", '"', "#"]),
  ambiguousPairs: Object.freeze(["m/n/u/w", "r/v/x", "s/5", "z/2", "b/8", "o/a", "e/c", "t/f", "g/y", "1/l/I", "0/O"]),
  domainTerms: Object.freeze([
    "meeting",
    "client interview",
    "shipping delay",
    "condition",
    "action",
    "archive",
    "invoice",
    "research",
    "review",
    "notes",
    "checklist",
    "reminder",
  ]),
});

const DEFAULT_REFERENCE_TEXT = [
  "At the beginning of a quiet Monday meeting, Helen Chen opened the notebook and wrote the reason for the change in plain language. The project was not finished, but the team agreed that the next action was clear: review the evidence, compare the old record with the new one, and return before noon with a short decision. Ben, Marta, and Julian each added a line about the client interview, the shipping delay, and the condition of the shared folder. They wanted the note to be useful later, not perfect, so every sentence had to say who did what, when it happened, and why it mattered.",
  "",
  "In the afternoon, the same page became a checklist. Call Alex at 10:30. Send 25 labels, 8 blue pens, 4 black clips, and 12 envelopes to Room 507. Move option A/B into the archive; mark Q4 review as urgent; cancel invoice #6190 only after Jane signs. The quick draft included arrows, commas, slashes, parentheses, and a quote: \"Please revise the final section before Friday.\" No one liked the messy table, yet the numbers were important: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9. Several marks were easy to confuse, especially l, I, 1, O, 0, S, 5, Z, 2, B, 8, m, n, u, v, w, r, and x.",
  "",
  "To make the sample broader, the group wrote a second note about ordinary work. The weather changed while the train moved north, and the station manager mentioned three missing cartons near the loading gate. A yellow jacket, five square boxes, and one gray zipper bag were placed beside the window. Quinn asked Xavier to organize the wax labels, zip the files, judge the fuzzy copy, and verify whether Zoe had the exact key. The sentence was odd, but it helped the page contain q, x, z, j, k, v, y, and w without turning the whole sample into nonsense.",
  "",
  "At the end, Helen copied a final reminder for herself. When handwriting is hard to read, look for patterns across repeated words: the, and, that, with, from, here, there, condition, action, meeting, review, writing, letter, number, answer, result, important, different, continued, and beginning. Compare tall letters with short ones, round letters with narrow ones, open loops with closed loops, and connected strokes with separated strokes. If a word is uncertain, keep the original image nearby and make the best reading only after checking the whole line.",
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
  const image = structuredClone(plainObject(input.image, "image"));
  text(image.workspacePath, "sample image workspacePath");
  text(image.mimeType, "sample image mimeType");
  const createdAt = input.createdAt || nowIso();
  return {
    id: text(input.id, "handwriting sample id"),
    profileId: text(input.profileId || DEFAULT_HANDWRITING_PROFILE_ID, "handwriting profile id"),
    promptId: text(input.promptId || prompt.id, "handwriting prompt id"),
    sourceArtifactId: text(input.sourceArtifactId, "source artifact id"),
    image,
    referenceText: text(input.referenceText || prompt.referenceText, "reference text"),
    coverage: cloneCoverage(input.coverage || prompt.coverage),
    active: input.active !== false,
    createdAt,
    updatedAt: input.updatedAt || createdAt,
  };
}

export function toggleHandwritingSampleActive({ profile, sample, active, updatedAt = nowIso() }) {
  if (typeof active !== "boolean") throw new Error("active must be a boolean");
  const nextSample = { ...plainObject(sample, "sample"), active, updatedAt };
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
        detail: "original",
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
  if (value === undefined || value === null) return null;
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
