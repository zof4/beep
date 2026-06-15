# Handwriting Calibration For Beep Notes

Date: 2026-06-15

## Decision

Build V1 as a Notes testing-demo feature with data shapes that can later promote into a general Beep user handwriting profile. V1 uses multimodal calibration memory: image samples plus exact reference transcripts are stored, retrieved, and sent as native image parts alongside future handwriting captures. V1 does not train a model.

## Goals

- Let a user upload a handwriting calibration page and provide exact reference text.
- Use saved calibration samples when transcribing later handwritten image captures.
- Preserve the native multimodal pipe: current captures and calibration samples must flow as `localImage` parts, not as text-only summaries or inline browser base64.
- Capture uncertainty and corrections as first-class profile data so the system adapts over time.
- Keep the feature scoped to the Notes demo until profile identity, privacy, and cross-agent lifecycle are designed.

## Non-Goals

- No fine-tuning or small neural network in V1.
- No cross-user or cloud profile sync in V1.
- No general Beep identity/profile migration in V1.
- No handwritten text segmentation or custom OCR engine in V1.

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

- Image file input accepting PNG, JPEG, WebP, HEIC, and HEIF.
- Reference transcript textarea.
- Save sample button.
- Saved samples list with sample name, created time, source format, converted format, and an active/inactive toggle.
- Processing option: `Use handwriting calibration`.

The calibration panel is not a marketing/onboarding page. It lives inside the existing Notes workspace UI as a utility area for testing.

## Data Model

Extend the Notes workspace state with handwriting-specific maps and order arrays:

```js
{
  handwritingProfiles: {},
  handwritingSamples: {},
  handwritingCorrections: {},
  handwritingSampleOrder: [],
  handwritingCorrectionOrder: []
}
```

Create a default profile automatically:

```js
{
  id: "profile_default",
  label: "Default handwriting profile",
  activeSampleIds: [],
  correctionIds: [],
  lexicon: [],
  createdAt,
  updatedAt
}
```

Handwriting sample:

```js
{
  id,
  profileId,
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
  tags: [],
  active: true,
  createdAt,
  updatedAt
}
```

Handwriting correction:

```js
{
  id,
  profileId,
  sourceArtifactId,
  derivedArtifactId,
  beforeText,
  correctedText,
  spanCorrections: [
    {
      before,
      after,
      note
    }
  ],
  createdAt
}
```

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
POST /api/notes/handwriting/samples
POST /api/notes/handwriting/samples/:id/toggle
POST /api/notes/handwriting/corrections
```

`POST /api/notes/handwriting/samples` uses multipart form data:

```text
profileId=profile_default
referenceText=...
image=<file>
```

It writes a workspace image file, creates a source artifact for provenance, creates a handwriting sample linked to that source artifact, and activates the sample on the profile.

`POST /api/notes/handwriting/corrections` stores corrected transcript data and links it to the original source artifact and derived artifact.

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
      referenceText,
      imagePart: { type: "localImage", path, detail }
    }
  ],
  corrections: [],
  lexicon: []
}
```

The gateway input order is:

```text
text: stage prompt
text: handwriting calibration instructions
text: calibration sample 1 reference transcript
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

## Correction Flow

After `readableRendition`, the UI shows:

- The transcript body.
- Uncertain spans and alternatives when present.
- A correction textarea initialized to the transcript.
- Save correction button.

Saving a correction creates a `HandwritingCorrection` and appends it to the active profile. Future handwriting context includes recent corrections as textual hints:

```text
Recent corrections:
- Read "Power pants" as "Power plans" in daily-list handwriting.
```

Corrections must never mutate the immutable source artifact. V1 stores corrections as profile correction records. If the user wants a corrected transcript to become the canonical readable text, that creates a new derived artifact linked to the same source artifact.

## Retrieval

V1 retrieval can be simple and deterministic:

- Use active samples from `profile_default`.
- Limit to the newest 3 samples by default.
- Include up to 5 recent corrections.
- Include the profile lexicon if present.

This can later become semantic retrieval over sample tags, phrases, or embedding similarity without changing the public API.

## Error Handling

- Missing calibration image: return `400`.
- Missing reference text: return `400`.
- Unsupported media type: return `400`.
- Image too large: return `413`.
- HEIC/HEIF conversion failure: return `400` with a clear message.
- Runtime does not support image inputs: fail the run stage with an actionable error.
- Calibration disabled or no active samples: run the current pipeline unchanged.

## Testing

Add focused tests for:

- Handwriting sample upload accepts multipart image plus reference text.
- HEIC/HEIF handwriting sample converts to PNG and keeps original metadata.
- Saved sample creates both source artifact provenance and handwriting sample state.
- Workspace read returns profile, samples, corrections, and active sample IDs.
- `readableRendition` with calibration sends multiple `localImage` parts.
- Stage prompt includes calibration reference text and correction hints.
- Stage output validation accepts `handwriting.uncertainSpans`.
- Corrections persist without mutating source artifacts.
- Disabled calibration does not alter existing Notes image processing behavior.

## Rollout

1. Add storage/domain support for handwriting profiles, samples, and corrections.
2. Add handwriting sample upload and correction endpoints.
3. Add the Notes demo calibration panel.
4. Add handwriting context building for `readableRendition`.
5. Add transcript correction UI.
6. Verify with `IMG_5308.HEIC` plus a reference transcript sample.

## V1 Decisions

- Calibration samples convert HEIC/HEIF to PNG by default.
- Ordinary image captures keep the existing JPEG conversion unless explicitly marked as handwriting captures.
- Uncertainty metadata is stored on run output as `outputs.handwriting`.
- Sample activation is profile-level only. Per-run sample selection is deferred.
