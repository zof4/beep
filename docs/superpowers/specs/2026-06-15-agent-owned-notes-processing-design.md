# Agent-Owned Notes Processing Design

## Goal

Make image-based Notes processing behave like a real Pi/Codex agent job: the agent owns the investigation loop, can use general workspace tools, and returns one validated structured result at the end.

## Problem

The current multimodal path preserves images as native `localImage` parts until the Pi/OpenAI provider boundary, but Notes still treats image processing as staged JSON execution. For `readableRendition`, Beep sends a strict stage prompt that asks for one JSON object. That proves the image can reach Pi, but it does not give the agent a strong task contract for handwriting: inspect the page, use tools, crop or enhance difficult regions, compare calibration samples, retry uncertain reads, and only then finalize.

This makes the system weaker than an xhigh Codex-style workflow. The model can see pixels, but it is not explicitly handed the workspace paths or encouraged to use the general tool loop to investigate them.

## Design Direction

For image captures in `localAgent` mode, replace the fixed staged Notes pipeline with one agent-owned note-processing job.

The control plane still owns persistence, validation, auth, provenance, and UI state. Pi owns the inner work loop.

```text
Browser
  -> uploads image capture

Control plane
  -> normalizes/stores source artifact
  -> builds agent job manifest
  -> submits native multimodal input to Pi

Pi runtime
  -> receives image inputs plus explicit workspace paths
  -> uses general tools when useful
  -> retries/reworks if prompted by validation failure
  -> returns final structured JSON

Control plane
  -> validates final result
  -> stores derived artifacts, comments, proposals, handwriting metadata, and compact run summary
```

Text captures and replay mode can keep the existing staged behavior for now. The first implementation should focus on image captures in `localAgent`.

## Agent Job Contract

The job prompt should tell Pi to process the note end to end:

- transcribe the handwriting;
- use active handwriting calibration samples when provided;
- inspect image files with general tools when useful;
- create temporary crops, rotations, or enhanced images if that helps;
- compare uncertain glyphs against calibration samples;
- produce readable and formatted note artifacts;
- propose todos/comments only when supported by the note;
- report uncertainty instead of guessing confidently;
- return the final JSON only after the work is complete.

The job should not be framed as a single `readableRendition` stage. It should be framed as:

```text
Your task is to process this captured note end to end.
You may use the available workspace tools to inspect image files and create helper crops/enhancements.
Only after you are done, return the final JSON object matching the schema.
```

## Image And Calibration Manifest

The agent must receive both the image input parts and explicit file paths.

The current capture entry should include:

```json
{
  "sourceArtifactId": "src_...",
  "workspacePath": "notes-captures/capture.jpg",
  "kind": "currentCapture",
  "detail": "auto"
}
```

Each calibration sample entry should include:

```json
{
  "sampleId": "hw_sample_...",
  "promptId": "hw_prompt_v2_story",
  "workspacePath": "notes-captures/sample.png",
  "referenceText": "exact text the user copied",
  "coverage": {
    "ambiguousPairs": ["m/n/u/w", "1/l/I", "0/O"]
  }
}
```

The same files should also be attached as `localImage` parts so the model can see them directly before deciding whether tools are needed.

## General Tools

The agent should be allowed to use Pi's general workspace tools. Do not start by inventing purpose-built image tools.

The job prompt can include a short note that helper files may be created in the workspace if useful. The control plane does not need to orchestrate those helper operations. Narrow image-specific tools are out of scope for this design and should only be considered in a separate follow-up if general tools prove too clumsy for image inspection.

## Thinking Level

The image-agent path should request `xhigh` thinking by default for handwriting and dense note transcription.

If the selected model/runtime rejects `xhigh`, fall back to the runtime configured thinking level and record the fallback in the compact run summary. The fallback should not silently change behavior.

## Validation Boundary

The final result must be strict JSON. The control plane should validate it before materializing anything.

Final result shape:

```json
{
  "derivedArtifacts": [
    {
      "kind": "readableRendition",
      "body": "...",
      "sourceArtifactIds": ["src_..."]
    },
    {
      "kind": "formattedNote",
      "body": "...",
      "sourceArtifactIds": ["src_..."]
    }
  ],
  "comments": [],
  "proposals": [],
  "handwriting": {
    "sampleIdsUsed": ["hw_sample_..."],
    "uncertainSpans": [
      {
        "text": "...",
        "alternatives": ["...", "..."],
        "reason": "ambiguous letter shape"
      }
    ]
  },
  "runSummary": {
    "mode": "agentOwned",
    "thinking": "xhigh",
    "calibration": {
      "enabled": true,
      "sampleCount": 1,
      "sampleIdsUsed": ["hw_sample_..."]
    },
    "tools": {
      "used": true,
      "count": 3
    },
    "attempts": [
      { "status": "retry", "reason": "missing readableRendition" },
      { "status": "accepted" }
    ],
    "validation": {
      "ok": true,
      "warnings": []
    }
  }
}
```

The existing validators should continue to own `derivedArtifacts`, `comments`, `proposals`, and `handwriting`. Add a small validator for `runSummary`.

## Retry And Rework

The first failed final answer should not immediately fail the run if the problem is recoverable.

Recoverable failures include:

- non-parseable final JSON;
- schema validation failure;
- missing `readableRendition` for an image capture;
- calibration enabled but no provided sample id is reported as used;
- output is suspiciously short for a dense note;
- uncertainty spans cover most of the page without a useful reason.

On recoverable failure, submit a follow-up/rework instruction in the same Pi session:

```text
Your previous final answer failed validation:
- missing readableRendition
- calibration was enabled but no sampleIdsUsed were reported

Reinspect the current image and calibration samples. Use tools if useful.
Return a corrected final JSON object only when done.
```

Limit automatic rework to two attempts. After that, mark the run failed and preserve the compact run summary.

## Compact Run Summary

Do not build a bulky audit log into the Notes demo.

Store a small summary that answers only:

- did this use agent-owned processing?
- what thinking level was requested/effective?
- was calibration enabled?
- how many samples were provided and reported as used?
- did the agent use tools, and how many calls?
- were retries needed?
- did validation pass?

Demo UI can render one compact row:

```text
Agent run: xhigh | calibration 1/1 | tools 3 | retries 1 | valid
```

Expanded details should show only retry reasons and validation warnings. Full tool transcripts remain in Pi/runtime logs, not in Notes UI state.

## Control Plane Purpose

The control plane should not mediate every crop, enhancement, or inspection step. Its job is to:

- authenticate the request;
- persist the uploaded source artifact;
- build the job manifest;
- submit the job to Pi;
- validate the final result;
- materialize Notes records;
- expose a compact run summary in the test UI.

Pi's job is to decide how much work is needed and use tools inside the workspace.

## Testing Requirements

Tests should prove:

- image captures in `localAgent` use the agent-owned path;
- the runtime request includes native image parts and explicit workspace paths;
- active handwriting samples are included as image parts plus manifest entries;
- `xhigh` thinking is requested for the image-agent path;
- malformed final JSON triggers a rework attempt before failure;
- schema failure triggers a rework attempt;
- successful final output materializes readable/formatted artifacts;
- compact run summary is validated and rendered in the Notes demo;
- replay and text-capture staged paths are not unintentionally changed.

## Open Non-Goals

Do not build custom image crop tools in the first implementation.

Do not store full tool transcripts in Notes state.

Do not replace the entire Notes data model. The agent owns the work loop, not persistence.
