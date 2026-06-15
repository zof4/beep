# Handwriting Calibration For Beep Notes

Date: 2026-06-15

## Decision

Build V1 as a Notes testing-demo feature with data shapes that can later promote into a general Beep user handwriting profile. V1 uses multimodal calibration memory: Beep presents a deliberately constructed calibration text page, the user writes that text by hand, and the uploaded handwritten page is stored with the known reference text. Future handwriting captures retrieve those image+reference pairs and send them as native image parts alongside the new capture. V1 does not train a model.

## Goals

- Let a user generate or view a handwriting calibration text page designed to cover common glyph shapes, ambiguous letter pairs, digits, punctuation, and Notes-domain vocabulary.
- Let the user upload a handwritten copy of that calibration page.
- Store the uploaded handwriting sample with the exact generated reference text it is supposed to say.
- Use saved calibration samples when transcribing later handwritten image captures.
- Preserve the native multimodal pipe: current captures and calibration samples must flow as `localImage` parts, not as text-only summaries or inline browser base64.
- Capture uncertainty as first-class run metadata so the user can see where the model was unsure.
- Keep the feature scoped to the Notes demo until profile identity, privacy, and cross-agent lifecycle are designed.

## Non-Goals

- No fine-tuning or small neural network in V1.
- No cross-user or cloud profile sync in V1.
- No general Beep identity/profile migration in V1.
- No handwritten text segmentation or custom OCR engine in V1.
- No post-transcription correction memory in V1. Adaptation comes from known handwriting samples with known reference text.

## Current Context

The Notes demo already supports multipart image capture, HEIC/HEIF conversion, workspace-backed image storage, and `localImage` forwarding to the runtime. The current processing pipeline is:

```text
readableRendition -> formattedNote -> agentCommentary -> draftExtraction -> plannerPass
```

The current gateway sends a text prompt plus attachment image parts into the Beep runtime. The runtime and Pi preserve image content until the final OpenAI provider serializes supported images as `input_image` payloads.

HEIC/HEIF cannot be passed through directly. Vendored Codex supports JPEG, PNG, GIF, and WebP for prompt images, and unsupported formats become an error text placeholder. Beep Notes must continue accepting iPhone HEIC/HEIF uploads, and must convert them to a model-supported format before runtime submission.

## User Experience

Add a compact `Handwriting calibration` area to `/notes` in the testing environment.

Controls:

- Calibration text display with a generated page for the user to copy by hand.
- Optional custom reference text textarea for advanced testing.
- Image file input accepting PNG, JPEG, WebP, HEIC, and HEIF for the user's handwritten copy.
- Save sample button.
- Saved samples list with sample name, prompt version, created time, source format, converted format, and an active/inactive toggle.
- Processing option: `Use handwriting calibration`.

The calibration panel is not a marketing/onboarding page. It lives inside the existing Notes workspace UI as a utility area for testing.

## Data Model

Extend the Notes workspace state with handwriting-specific maps and order arrays:

```js
{
  handwritingProfiles: {},
  handwritingPrompts: {},
  handwritingSamples: {},
  handwritingSampleOrder: [],
  handwritingPromptOrder: []
}
```

Create a default profile automatically:

```js
{
  id: "profile_default",
  label: "Default handwriting profile",
  activeSampleIds: [],
  lexicon: [],
  createdAt,
  updatedAt
}
```

Handwriting prompt:

```js
{
  id,
  label,
  promptVersion,
  referenceText,
  coverage: {
    letters: [],
    digits: [],
    punctuation: [],
    ambiguousPairs: [],
    domainTerms: []
  },
  createdAt
}
```

Handwriting sample:

```js
{
  id,
  profileId,
  promptId,
  sourceArtifactId,
  image: {
    workspacePath,
    mimeType,
    sizeBytes,
    originalName,
    originalMimeType,
    originalSizeBytes,
    convertedFrom
  },
  referenceText,
  coverage,
  active: true,
  createdAt,
  updatedAt
}
```

The sample `referenceText` is copied from the prompt when the sample is saved. This makes each sample self-contained even if the calibration prompt generator changes later.

## Calibration Text Design

The default calibration text is generated from a fixed V1 template rather than invented ad hoc each time. It is designed to expose handwriting shapes the model needs to compare later:

- Lowercase and uppercase alphabets in natural words, not only alphabet rows.
- Digits `0-9`, common dates, times, quantities, and list numbering.
- Punctuation used in notes: dashes, slashes, parentheses, colons, question marks, arrows, ampersands, and bullets.
- Ambiguous glyph neighborhoods: `m/n/u/w`, `r/v`, `s/5`, `o/a`, `e/c`, `t/f`, `g/y`, `1/l/I`, `0/O`, and similar pairs.
- Common Notes-domain words: weekdays, months, errands, calls, reminders, research, laundry, appointment, email, buy, return, fix, follow up.
- Short list lines, dense sentence lines, and mixed fragments that look like real notes.

The generator records coverage metadata with each prompt so later retrieval can prefer samples that cover the kind of text being transcribed.

## Image Conversion Policy

Calibration samples are handwriting reference material, so preserve strokes over file size:

- HEIC/HEIF calibration uploads convert to PNG by default.
- Non-HEIC supported uploads are stored as their original supported format.
- Future handwriting captures use PNG when the capture is explicitly marked as handwriting; ordinary image captures keep the existing conversion policy.
- Store original format metadata for all conversions.
- Never send HEIC/HEIF to the runtime.

The converter interface accepts a target mode so ordinary Notes captures can keep their existing behavior while handwriting calibration can request PNG.

## API Surface

Add Notes-demo endpoints:

```text
GET  /api/notes/handwriting/profile
GET  /api/notes/handwriting/prompts/default
POST /api/notes/handwriting/samples
POST /api/notes/handwriting/samples/:id/toggle
```

`POST /api/notes/handwriting/samples` uses multipart form data:

```text
profileId=profile_default
promptId=hw_prompt_v1
referenceText=...
image=<file>
```

It writes a workspace image file, creates a source artifact for provenance, creates a handwriting sample linked to that source artifact and prompt, and activates the sample on the profile.

## Pipeline Integration

Keep the existing `processNote` stages, but enrich `readableRendition` context when handwriting calibration is enabled.

Before running `readableRendition`, build a handwriting context:

```js
{
  profileId,
  enabled,
  samples: [
    {
      id,
      promptId,
      referenceText,
      coverage,
      imagePart: { type: "localImage", path, detail }
    }
  ],
  lexicon: []
}
```

The gateway input order is:

```text
text: stage prompt
text: handwriting calibration instructions
text: calibration sample 1 exact reference text
localImage: calibration sample 1
...
text: current capture instruction
localImage: current capture
```

This keeps calibration images native. The model can visually compare handwriting forms instead of relying only on a textual style guide.

## Stage Output

Extend stage output validation to allow a `handwriting` object for transcription metadata:

```js
{
  derivedArtifacts: [
    {
      kind: "readableRendition",
      body,
      sourceArtifactIds
    }
  ],
  handwriting: {
    sampleIdsUsed: [],
    uncertainSpans: [
      {
        text,
        alternatives: [],
        reason
      }
    ]
  }
}
```

The `handwriting` object is metadata, not a user-facing note body. Persist it on the run output as `outputs.handwriting` so uncertainty metadata does not get mixed into note text.

## Calibration Sample Flow

The V1 onboarding path is:

1. The UI displays the default calibration text page.
2. The user writes that page by hand on paper or another surface.
3. The user uploads a photo of the handwritten page.
4. The API stores the image and the exact reference text together as a `HandwritingSample`.
5. Future transcription prompts include the sample image and the known reference text.

The model is instructed to compare the sample image against the known reference text to infer the user's letter shapes, spacing, shorthand, and ambiguous forms. It then applies that comparison to the current capture.

After `readableRendition`, the UI still shows uncertain spans and alternatives when present. Those uncertainty spans are review output, not training data, and are not stored as correction memory in V1.

Calibration samples must never mutate the immutable source artifact for ordinary captures. Calibration samples are their own source artifacts with known reference text.

## Retrieval

V1 retrieval can be simple and deterministic:

- Use active samples from `profile_default`.
- Limit to the newest 3 samples by default.
- Include the profile lexicon if present.
- Prefer samples whose coverage metadata overlaps the current capture hint when a hint exists.

This can later become semantic retrieval over sample tags, phrases, or embedding similarity without changing the public API.

## Error Handling

- Missing calibration image: return `400`.
- Missing reference text: return `400`.
- Unknown prompt id: return `404`.
- Unsupported media type: return `400`.
- Image too large: return `413`.
- HEIC/HEIF conversion failure: return `400` with a clear message.
- Runtime does not support image inputs: fail the run stage with an actionable error.
- Calibration disabled or no active samples: run the current pipeline unchanged.

## Testing

Add focused tests for:

- Handwriting sample upload accepts multipart image plus reference text.
- HEIC/HEIF handwriting sample converts to PNG and keeps original metadata.
- Default calibration prompt returns stable text and coverage metadata.
- Saved sample creates source artifact provenance, prompt linkage, and handwriting sample state.
- Workspace read returns profile, prompts, samples, and active sample IDs.
- `readableRendition` with calibration sends multiple `localImage` parts.
- Stage prompt includes calibration reference text and current-capture instructions.
- Stage output validation accepts `handwriting.uncertainSpans`.
- Disabled calibration does not alter existing Notes image processing behavior.

## Rollout

1. Add storage/domain support for handwriting profiles, prompts, and samples.
2. Add default calibration prompt and handwriting sample upload endpoints.
3. Add the Notes demo calibration panel with generated copy text and sample upload.
4. Add handwriting context building for `readableRendition`.
5. Add uncertainty display after `readableRendition`.
6. Verify with `IMG_5308.HEIC` plus a reference transcript sample.

## V1 Decisions

- Calibration samples convert HEIC/HEIF to PNG by default.
- Ordinary image captures keep the existing JPEG conversion unless explicitly marked as handwriting captures.
- Uncertainty metadata is stored on run output as `outputs.handwriting`.
- Sample activation is profile-level only. Per-run sample selection is deferred.
- Post-transcription correction memory is out of scope for V1.
