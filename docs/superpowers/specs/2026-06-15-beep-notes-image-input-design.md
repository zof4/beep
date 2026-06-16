# Beep Notes Image Input Design

## Purpose

This design adds image input to the Beep Notes product demo and backbone. The
goal is to let the user capture a photo or screenshot of notes, preserve the
original image as a source artifact, and ask Beep to create secondary layers:
readable renditions, comments, draft todos, estimates, and planning proposals.

Audio and voice are explicitly out of scope for this slice. They should use the
same source-artifact idea later, but audio processing needs a transcription
stage and different OpenAI API path.

## Current Findings

OpenAI's public multimodal shape is the Responses API. Image understanding is
sent as text plus `input_image` parts. Images can be supplied by URL, base64
data URL, or file ID:

```json
{
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "Turn this notebook photo into todos." },
      { "type": "input_image", "image_url": "data:image/jpeg;base64,..." }
    ]
  }]
}
```

Codex product surfaces already support image attachments. Codex app supports
dragging images into the prompt composer, and Codex CLI supports attaching
common image formats to prompts.

This repo's Beep path is different from the Codex app composer. The notes demo
must send media through Beep's control-plane and runtime boundary. It should
not call `https://chatgpt.com/backend-api/codex/responses` directly from the
browser or notes control-plane code. That endpoint belongs behind the vendored
Pi/OpenAI Codex provider, which already owns Codex auth, model transport, and
runtime session behavior.

The current implementation already has a `SourceArtifact.media` field, but the
active path is text-only:

- `/notes` capture UI only collects text.
- `NotesBeepGateway` sends only `{ message }`.
- `/agent/submit` queues only a string prompt.
- `PiRpcSession.prompt()` sends only `{ type: "prompt", message }`.
- Runtime session `steer` and `follow_up` routes already pass `images`, which
  suggests the Pi RPC boundary can carry image data if the prompt path is widened.

## Approved Approach

Use the existing Beep Notes pipeline and add an image attachment lane.

The browser captures an image file, stores it as an immutable original
`SourceArtifact.media` entry, then asks Beep to process that source. The notes
gateway sends the stage prompt plus image attachments to `/agent/submit`.
The runtime queue stores the attachments with the request and passes them to
`PiRpcSession.prompt()`. `PiRpcSession.prompt()` sends the same `images` field
shape already used by runtime `steer` and `follow_up` commands.

This is the most Codex-forward and easiest vendored path because it follows the
Responses multimodal content model while keeping all model access behind the
runtime/Pi provider.

## Non-Goals

- Do not implement OCR in the browser, control plane, or runtime.
- Do not flatten image text into the original note.
- Do not mutate or overwrite the source artifact.
- Do not make the browser call OpenAI or ChatGPT backend endpoints.
- Do not patch vendored Pi in this slice unless the existing RPC field proves
  insufficient during implementation.
- Do not add audio recording, speech-to-text, or realtime voice in this slice.

## Data Model

Source artifacts remain immutable. Image capture extends `media`, not `body`.
The source body can hold a user caption or instruction, but the image itself is
the primary source.

```json
{
  "schemaVersion": 1,
  "id": "src_...",
  "kind": "image",
  "body": "optional user caption or instruction",
  "media": {
    "schemaVersion": 1,
    "files": [
      {
        "id": "media_...",
        "kind": "image",
        "name": "notebook.jpg",
        "mimeType": "image/jpeg",
        "sizeBytes": 4812234,
        "dataUrl": "data:image/jpeg;base64,...",
        "detail": "auto"
      }
    ]
  },
  "immutable": true
}
```

For the disposable local demo, base64 data URLs are acceptable with a 12 MiB
raw-file size cap per image and one image per source artifact. The
implementation should reject unsupported MIME types and oversized payloads
before they enter the state store. Production should move media to object
storage and pass file IDs or signed URLs.

Supported local-demo image MIME types:

- `image/png`
- `image/jpeg`
- `image/webp`

GIF is intentionally excluded from the local demo because the OpenAI image
input requirements support non-animated GIFs only, and validating animation
status is unnecessary for the first product slice.

## Gateway Contract

The notes layer should use a neutral attachment contract:

```json
{
  "message": "You are running Beep Notes pipeline stage: readableRendition...",
  "attachments": [
    {
      "type": "image",
      "sourceArtifactId": "src_...",
      "mediaFileId": "media_...",
      "mimeType": "image/jpeg",
      "dataUrl": "data:image/jpeg;base64,...",
      "detail": "auto"
    }
  ],
  "stage": "readableRendition",
  "context": {
    "sourceArtifactId": "src_...",
    "runId": "run_..."
  }
}
```

At the runtime boundary, the control-plane adapter maps image attachments to
the current Pi-compatible `images` field:

```json
{
  "message": "...",
  "images": [
    {
      "mimeType": "image/jpeg",
      "dataUrl": "data:image/jpeg;base64,...",
      "detail": "auto"
    }
  ],
  "waitForCompletion": true
}
```

`attachments` remains the preferred Beep Notes internal concept. `images`
is the current runtime/Pi transport field.

## Pipeline Flow

1. User chooses `Image` in the capture form.
2. User selects or drops an image.
3. UI previews the image and captures an optional instruction.
4. UI posts `POST /api/notes/captures` with `kind: "image"` and `media.files[]`.
5. Control plane validates MIME type, size, and data URL shape.
6. Control plane stores the image source artifact immutably.
7. User clicks `Create and process capture`.
8. Pipeline runs the normal `processNote` stages:
   - `readableRendition`: Beep describes or transcribes the visible note content into a derived artifact.
   - `formattedNote`: Beep creates a clean note if appropriate.
   - `agentCommentary`: Beep adds uncertainty, organization, and prioritization comments.
   - `draftExtraction`: Beep proposes todos, research packets, estimates, or schedule drafts.
   - `plannerPass`: Beep reasons over ordering and timing when proposals exist.
9. The original image remains in `sourceArtifacts`.
10. All Beep-generated outputs are stored as derived artifacts, comments, or proposals.

Review modes continue to apply:

- `stepReview`: pauses after each stage.
- `firstReadCheckpoint`: pauses after the first image-read/rendition stage.
- `autopilot`: runs all stages.

## Product Demo UI

The `/notes` demo should keep its current Apple-style split workspace and add:

- capture type segmented control or select: `Text` and `Image`;
- file picker accepting supported image types;
- image preview inside Original Capture;
- visible file metadata: name, MIME type, approximate size;
- clear/remove image action before submit;
- original-image rendering in the source layer;
- unchanged secondary-layer rendering for comments and proposals.

The interface should keep the product-demo feel. It should not expose raw JSON
by default. Debug detail can stay in the inspector/run area.

## Error Handling

Client-side errors:

- no image selected for image capture;
- unsupported image MIME type;
- file too large for local-demo persistence;
- failed `FileReader` conversion.

Server-side errors:

- malformed `media.files`;
- unsupported MIME type;
- data URL MIME mismatch;
- missing `dataUrl`;
- unsupported attachment type at gateway/runtime boundary.

Pipeline/runtime errors should fail the current run stage and preserve the
source artifact. A failed Beep processing run must not delete the original image.

## Testing

Unit and route coverage should prove:

- image source artifacts clone and preserve media;
- `/api/notes/captures` accepts valid image media;
- invalid image MIME/data URL/size returns `400`;
- `replay` mode still produces deterministic derived artifacts/proposals;
- `localAgent` mode forwards image attachments to `/agent/submit`;
- `/agent/submit` stores image request metadata without dropping it;
- `PiRpcSession.prompt()` includes `images` in the RPC command;
- `/notes` contains file input, preview rendering, and image layer rendering.

Manual verification should cover:

- text capture still works;
- image capture previews and persists;
- processing an image source keeps the original image visible;
- replay processing creates secondary-layer output;
- localAgent mode sends an image-bearing request to the runtime when available.

## Future Work

Production media storage should move from state-store data URLs to object
storage. The Beep gateway can then pass file IDs or signed URLs instead of
base64 data URLs.

Audio should be added as a separate capture type later. Bounded recordings
should go through speech-to-text before the notes pipeline. Live voice should
use a Realtime session only when the product needs live conversation, not for
simple note ingestion.

## References

- OpenAI Images and vision: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI Realtime and audio: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Speech to text: https://developers.openai.com/api/docs/guides/speech-to-text
- Codex app image input: https://developers.openai.com/codex/app/features#image-input
- Codex CLI image inputs: https://developers.openai.com/codex/cli/features#image-inputs
- Local endpoint map: `docs/codex-endpoint-map.md`
