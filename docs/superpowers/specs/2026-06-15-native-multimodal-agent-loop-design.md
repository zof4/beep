# Native Multimodal Agent Loop Design

## Goal

Make Beep's agent loop natively multimodal by carrying structured input parts
from the control plane through the runtime queue into the vendored Pi/Codex
agent engine. Images must be first-class user input, not attachments bolted onto
a text-only request.

The first useful slice should let an operator send text plus one or more image
parts to the long-running Beep agent and have the active Codex-backed model
receive those parts as real Responses `input_image` content.

## Design Principles

- Beep's native turn contract is structured `input`, not `message`.
- Text, remote images, base64 images, and local images are peer input parts.
- Image `detail` is first-class because Codex and current Responses models make
  it first-class.
- Beep should not preserve old text-only behavior as a compatibility target.
- Beep should not adapt itself around Pi's current RPC `message + images`
  command shape.
- Pi is a vendored in-process agent engine for Beep, not an external CLI
  process for the steady-state runtime loop.
- The only serialization step should be the provider boundary where structured
  parts become OpenAI Responses `input_text` and `input_image`.

## Current Baseline

Beep currently runs the long-lived assistant by spawning Pi in RPC mode from
`runtime/src/beep-runtime-api.mjs`.

The current path is:

```text
control plane /api/requests
  -> runtime /agent/submit
  -> AgentSupervisor request queue
  -> PiRpcSession
  -> JSON line command { type: "prompt", message: string }
  -> Pi CLI RPC mode
  -> Pi AgentSession.prompt(text, { images })
  -> Pi provider serialization
```

This path is text-first at multiple layers:

- `control-plane/src/server.mjs` builds a runtime body with only `message`,
  `waitForCompletion`, and `timeoutMs`.
- `AgentSupervisor.enqueuePrompt` stores only `message` plus queue metadata.
- `AgentSupervisor.runRequest` calls `session.prompt(request.message, ...)`.
- `PiRpcSession.prompt` sends Pi a JSON command with `message` and no structured
  input.
- Pi RPC supports `images?: ImageContent[]`, but that shape is still a split
  command inherited from CLI usage, not a native Beep turn model.

This was acceptable for an initial backend loop but is the wrong architecture
for multimodal Beep.

## Research Findings

Vendored Codex models user input as structured parts:

- `text`;
- remote `image`;
- `localImage`;
- image `detail`.

Codex converts those parts into Responses content items such as `input_text` and
`input_image` only at the model-provider boundary. It also wraps image inputs
with image labels for model readability.

Vendored Pi already supports multimodal messages internally:

- `@earendil-works/pi-ai` defines `TextContent` and `ImageContent`.
- Pi `AgentMessage` is a union over normal LLM messages and custom messages.
- Pi core `Agent.prompt()` already accepts `AgentMessage | AgentMessage[]`.
- Pi provider serialization already maps `ImageContent` to Responses
  `input_image` data URLs.
- Pi's higher-level `AgentSession.prompt()` and RPC commands still expose the
  older `text + images` convenience shape.
- Pi's SDK exports `createAgentSession`, `AgentSession`, `AuthStorage`, and
  related runtime types, so Beep can run Pi in process.

The runtime Docker image already builds vendored Pi packages under `/opt/pi`,
and `beep-agentd` already runs with Pi's `tsx` runtime. Beep can import Pi's
package APIs instead of launching `pi --mode rpc`.

OpenAI's current Responses image input shape accepts content arrays containing
`input_text` and `input_image`; image inputs may be supplied as remote URLs,
base64 data URLs, or file IDs. Current `detail` values are `low`, `high`,
`original`, and `auto`.

## Native Input Contract

Beep's request body must use `input` as the turn payload:

```json
{
  "input": [
    { "type": "text", "text": "What changed in this screenshot?" },
    {
      "type": "image",
      "mimeType": "image/png",
      "data": "BASE64",
      "detail": "high"
    }
  ]
}
```

The native part model is:

```ts
type BeepInputPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      data: string;
      mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      detail?: "low" | "high" | "original" | "auto";
    }
  | {
      type: "image";
      url: string;
      detail?: "low" | "high" | "original" | "auto";
    }
  | {
      type: "localImage";
      path: string;
      detail?: "low" | "high" | "original" | "auto";
    };
```

`input` must contain at least one part. Empty text parts are rejected. Base64
image data must be syntactically valid base64 and paired with a supported MIME
type. Remote image URLs must be absolute `https:` URLs. `localImage` paths are
runtime workspace paths and must be contained by the active Beep workspace.

The implementation should include explicit byte and count limits. The first
slice should allow enough room for normal screenshots while rejecting accidental
large payloads before they enter durable state.

## Architecture

### Control Plane

The control plane owns the operator-facing request contract.

Responsibilities:

- accept `POST /api/requests` with native `input`;
- validate the shape and reject invalid input before starting the runtime;
- persist the native request record;
- forward the same native `input` to the runtime `/agent/submit` route;
- expose request summaries without leaking raw base64 image data by default;
- keep audit records focused on request metadata, image counts, MIME types, byte
  sizes, and route outcomes.

The request record should store canonical `input`. Public list/detail views can
return redacted or summarized image data, but the durable internal record must
remain multimodal.

### Runtime Queue

The runtime queue must store structured input directly.

Responsibilities:

- accept `POST /agent/submit` with native `input`;
- enqueue `input` alongside timeout, LCM, and streaming metadata;
- pass `input` unchanged into the active native Pi session;
- preserve structured input in request status, summaries, and diagnostics where
  safe;
- make `POST /agent/steer` and `POST /agent/follow-up` use the same `input`
  contract.

The queue should no longer model the request as `message`. If a helper method
needs a display label, it should derive one from the first text part or from a
redacted summary such as `2 text parts, 1 image/png image`.

### Native Pi Runtime

Replace `PiRpcSession` with an in-process `PiNativeSession`.

Responsibilities:

- create a Pi session with vendored Pi's SDK (`createAgentSession`) and call a
  structured content API directly;
- inject the short-lived Codex credential through Pi `AuthStorage` runtime API
  key overrides instead of a CLI `--api-key` flag;
- subscribe to Pi session events in process;
- preserve Beep's current event JSONL, summary, LCM, Hindsight, web-search, and
  sandbox portal behavior;
- stop and restart the native session cleanly when model, thinking level, or
  runtime state changes.

Beep should patch the vendored Pi high-level session API where needed so it
accepts the same structured content parts natively. Pi core already accepts
`AgentMessage[]`; the goal is to expose that path directly from the APIs Beep
uses without splitting the turn into text and image side channels.

The canonical content object should be shared across Beep and vendored Pi. If
Pi's current `ImageContent` type lacks `url`, `localImage`, or `detail`, Beep
should extend the vendored Pi type so the same object can move from HTTP input
through the agent loop without an intermediate Beep adapter.

### Pi/Codex Provider Boundary

Provider serialization is the only shape change.

Responsibilities:

- accept the shared structured content object carried by Beep and Pi;
- serialize model requests as Responses `input_text` and `input_image`;
- preserve existing hosted web search injection through the provider request
  hook;
- maintain tool-result images as normal Pi/Codex multimodal content.

If Pi currently lacks fields required by the native content object, Beep should
add them to vendored Pi and update the OpenAI Responses serializer to emit the
corresponding provider fields.

## Data Flow

```text
operator
  -> POST /api/requests { input: BeepInputPart[] }
  -> control plane validates and records native input
  -> control plane forwards { input } to runtime /agent/submit
  -> runtime queues native input
  -> PiNativeSession.prompt(input)
  -> Pi AgentMessage[] carries TextContent and ImageContent
  -> Pi/Codex provider builds Responses content
  -> model receives input_text and input_image parts
  -> Pi emits normal events
  -> Beep records events, LCM, Hindsight, and request status
```

Steering and follow-up use the same input flow:

```text
operator
  -> POST /api/agent/steer { input }
  -> runtime /agent/steer
  -> PiNativeSession.steer(input)
  -> active turn receives structured user content
```

## Error Handling

Invalid native input should fail fast with `400` and a precise field path.

Examples:

- `input` missing or not an array;
- empty `input`;
- unknown part type;
- empty text;
- unsupported image MIME type;
- invalid base64;
- image payload exceeds configured byte limits;
- remote image URL is not absolute HTTPS;
- local image path escapes the runtime workspace;
- unsupported `detail` value.

Pi session startup errors should remain runtime errors. They should not be
reported as validation errors against user input.

If the active model does not support image input, Beep should fail before the
provider request with an operator-readable error. It should not silently replace
the image with text or omit the image.

## Security And State

Raw image bytes are user input and can be large or sensitive.

The first implementation should:

- reject oversized payloads before durable persistence;
- avoid logging raw base64;
- redact image data from public request list/detail views unless an internal
  debug path explicitly asks for canonical state;
- keep local image reads contained to the Beep workspace;
- preserve existing model credential isolation by passing credentials through
  Pi in-memory auth overrides only;
- keep sandbox tool execution separate from model input handling.

Remote image URLs are model-provider inputs. They do not grant Beep shell or
filesystem authority, but they may expose external resources to the provider.
The first slice should allow `https:` URLs only. Policy controls for domain
allowlists can be added later if needed.

## Testing

Focused tests should prove:

- control-plane request validation accepts mixed text/image `input`;
- control-plane request validation rejects malformed parts with useful errors;
- control-plane forwarding sends native `input` to `/agent/submit`;
- public request listing redacts or summarizes image payloads;
- runtime `/agent/submit` queues native `input`;
- runtime request execution passes native input into `PiNativeSession`;
- runtime `/agent/steer` and `/agent/follow-up` use the same native input
  contract;
- `PiNativeSession` injects Codex credentials through in-memory Pi auth;
- vendored Pi high-level prompt APIs accept structured content without splitting
  into `message + images`;
- Pi/Codex provider serialization emits Responses `input_image` with `detail`;
- image-capability failures are explicit and do not drop images;
- LCM/Hindsight event recording continues after multimodal turns without
  storing raw image bytes in summaries.

An optional credential-gated integration proof can send a small PNG to the
active Codex-backed model and assert that Pi's provider payload contains an
`input_image`.

## Out Of Scope

- preserving the old `message` request contract;
- adding compatibility shims that split Beep input into `message + images`;
- keeping Pi RPC as the steady-state Beep agent boundary;
- adding audio or video input;
- adding image generation output;
- uploading files to the OpenAI Files API;
- third-party image storage;
- UI polish for drag-and-drop image upload beyond the backend-native contract.

## References

- Vendored Codex user input schema:
  `vendor/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/UserInput.ts`
- Vendored Codex image serialization:
  `vendor/openai-codex/codex-rs/protocol/src/models.rs`
- Vendored Pi SDK exports:
  `vendor/pi/packages/coding-agent/src/index.ts`
- Vendored Pi session API:
  `vendor/pi/packages/coding-agent/src/core/agent-session.ts`
- Vendored Pi core agent API:
  `vendor/pi/packages/agent/src/agent.ts`
- Vendored Pi Responses serialization:
  `vendor/pi/packages/ai/src/providers/openai-responses-shared.ts`
- OpenAI Images and Vision guide:
  `https://developers.openai.com/api/docs/guides/images-vision`
