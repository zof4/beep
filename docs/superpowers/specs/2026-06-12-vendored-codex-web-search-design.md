# Vendored Codex Web Search Design

## Goal

Give the Beep Pi-backed agent loop native hosted web search by injecting the
same Responses `web_search` tool contract used by vendored Codex, without
routing searches through Beep's older `web_run` broker or the public API-key
path that failed with missing Responses scopes.

The first slice should let a user ask the long-running Beep assistant current
questions and receive cited answers when the active Codex-backed model chooses
to search. Web search is available from startup by default.

## Current Baseline

Beep currently runs the local assistant through Pi:

- `runtime/src/beep-runtime-api.mjs` launches Pi in RPC mode with the
  `openai-codex` provider.
- Pi's OpenAI Codex Responses provider builds a Responses request and serializes
  only `context.tools` into `body.tools`.
- Pi has a `before_provider_request` extension hook that can inspect or replace
  the final provider payload before the network request is sent.
- `control-plane/src/tool-manifest.mjs` advertises a `web_run` tool, and
  `control-plane/src/openai-web-search.mjs` calls the public
  `https://api.openai.com/v1/responses` endpoint with an API key.

That `web_run` path is the wrong default for Beep's Codex-backed loop:

- it depends on public API-key Responses scopes;
- it is an agent-visible function tool rather than a provider-hosted search
  tool;
- vendored Codex suppresses hosted search when a standalone `web.run`
  extension exists;
- it does not track new hosted `web_search` fields added by Codex.

## Research Findings

OpenAI's current docs say new Responses integrations should use
`{ "type": "web_search" }`, not the legacy preview shape. Current controls
include `filters`, `external_web_access`, `return_token_budget`,
`search_context_size`, `search_content_types`, image result settings, and
`user_location`.

OpenAI's Codex config now uses top-level `web_search`, with legacy
`features.web_search_cached` and `features.web_search_request` mapped to
`cached` and `live`.

OpenClaw Gateway docs now document native Codex web search under
`tools.web.search.openaiCodex`, but the Beep vendored `vendor/pi` repository
does not contain that OpenClaw Gateway implementation even after updating Pi to
upstream `17721d5`.

Therefore Beep should not wait for Pi to grow this feature. Beep can inject the
hosted search tool through Pi's provider-payload hook while using vendored
Codex as the compatibility source.

## Design Decision

Implement a Beep-owned Pi extension that injects vendored-Codex-compatible
hosted web search into OpenAI Codex Responses payloads.

Use `vendor/openai-codex` as the source of truth for the tool contract:

- detect supported `web_search` fields from vendored Codex source;
- normalize Beep config into that shape;
- add exactly one hosted `web_search` entry to the outgoing `body.tools`;
- do not expose Beep `web_run` as the normal web-search path;
- fail closed when config is invalid;
- add a drift test that fails when vendored Codex supports new web-search fields
  that Beep has not acknowledged.

This keeps Beep aligned with Codex when Codex adds new search capabilities, but
does not require replacing Pi as the current agent loop.

## User-Facing Behavior

Default local behavior:

```text
BEEP_CODEX_WEB_SEARCH_ENABLED=1
BEEP_CODEX_WEB_SEARCH_MODE=live
```

`live` mode means hosted search gets `external_web_access: true` when vendored
Codex exposes that field. `cached` mode remains available and maps to
`external_web_access: false`. `disabled` removes the hosted search tool.

The model decides whether to search on a turn. Beep should not ask the operator
for approval on every query. Gatekeeper or operator policy may disable web
search globally or for a future channel/session scope, but default local-dev
policy is allowed.

No fallback search provider is used in this feature. If hosted Codex search is
not available for the active model/account, the request should report a clear
native-search failure or complete without search according to provider behavior.
It must not silently route through `web_run`, Brave, DuckDuckGo, Parallel, or a
public API-key Responses call.

## Components

### Codex Web Search Contract Module

Create a small runtime module responsible for converting Beep config into a
Responses `web_search` tool object.

Responsibilities:

- read and validate `enabled`, `mode`, `allowedDomains`, `contextSize`,
  `userLocation`, `searchContentTypes`, and future acknowledged fields;
- map `mode: "live"` to `external_web_access: true`;
- map `mode: "cached"` to `external_web_access: false`;
- omit optional fields when unset;
- reject invalid values with operator-readable errors.

This module must not call the network. It only builds the hosted tool spec.

### Pi Provider Hook Extension

Create a Pi extension loaded by `runtime/src/beep-runtime-api.mjs`.

Responsibilities:

- register `before_provider_request`;
- identify OpenAI Codex Responses payloads by their payload shape, not by a
  fragile model-name substring alone;
- preserve all existing Pi-provided tools;
- append or replace exactly one `type: "web_search"` hosted tool;
- skip injection for disabled mode;
- log a sanitized one-line status event for diagnostics.

The hook should be deterministic and idempotent. If another layer already
injected `web_search`, Beep replaces that entry with the Beep-normalized entry
instead of adding duplicates.

### Runtime Wiring

Modify the Beep runtime launcher to load the new extension alongside the
existing LCM, Hindsight, sandbox portal, and control-plane tools extensions.

The new extension must run before Beep sends the provider request. It should not
depend on the sandbox container being alive, because hosted web search is a
provider tool, not a sandbox command.

### Control Plane Tool Manifest

Stop advertising `web_run` as the default web-search ability for the Beep
agent. If Beep keeps `web_run` for diagnostics, migration, or an explicit
operator route, it should be hidden from normal `/api/tools` and not loaded into
Pi by default.

This avoids the hosted-search suppression behavior in vendored Codex and avoids
the public Responses API scope issue.

### Drift Test

Add a test that reads vendored Codex web-search type definitions and compares
the supported field names against Beep's acknowledged list.

The test should fail when vendored Codex adds a new supported web-search field
that Beep does not explicitly acknowledge. The fix can either expose the field
in Beep config or add a deliberate ignore entry with a comment explaining why.

## Data Flow

```text
operator request
  -> control plane /api/requests
  -> Beep runtime queue
  -> Pi RPC session
  -> Pi builds OpenAI Codex Responses payload
  -> Beep web-search before_provider_request hook
  -> payload.tools includes { type: "web_search", ... }
  -> OpenAI Codex Responses provider call
  -> model may call hosted web_search
  -> provider returns normal response stream and citations
  -> Pi completes turn
  -> Beep LCM/Hindsight ingest remains unchanged
```

## Error Handling

Invalid Beep web-search config should fail startup or extension initialization
with a clear message. It should not send malformed provider payloads.

If Pi changes the provider-payload hook API, the extension should fail loudly in
runtime diagnostics and leave the agent loop usable without claiming web search
is enabled.

If hosted search is unavailable for the account/model, Beep should surface the
provider error. It should not retry through a different search provider.

If the outgoing payload already contains a non-Beep `web_search` entry, Beep
should replace it with the normalized configured entry and log that replacement
without exposing credentials or request content.

## Security And Policy

Hosted search is a provider-side model tool. It does not grant shell, filesystem
or Docker authority. It still gives the model access to external web content, so
it should be controlled by explicit policy knobs:

- global enable/disable;
- mode `live`, `cached`, or `disabled`;
- optional domain allowlist;
- optional approximate user location.

Per-query approvals are out of scope for this feature. They would make normal
search use too slow. Future policy can add channel/session-level gates, but the
default local-dev stance is allowed.

## Testing

Focused tests should prove:

- the builder emits the minimal hosted tool for default `live` mode;
- `cached` sets `external_web_access: false`;
- `disabled` omits the hosted tool;
- allowed domains map into `filters.allowed_domains`;
- user location maps into the hosted tool shape;
- the Pi hook preserves existing function tools and deduplicates `web_search`;
- invalid config fails with a useful error;
- the runtime launcher includes the extension path;
- normal `/api/tools` no longer exposes `web_run` by default;
- vendored Codex drift is detected.

End-to-end testing can use a local fake Pi provider payload fixture first. A
real provider test should be optional and credential-gated, because it depends
on the active ChatGPT/Codex account having hosted search access.

## Out Of Scope

- adding Brave, DuckDuckGo, Parallel, SearXNG, Tavily, or any managed search
  fallback;
- per-query gatekeeper prompts;
- replacing Pi with the Codex app-server harness;
- changing sandbox tool execution;
- adding dynamic third-party tool installation.

## References

- OpenAI Web Search guide:
  `https://developers.openai.com/api/docs/guides/tools-web-search`
- OpenAI Codex config reference:
  `https://developers.openai.com/codex/config-reference`
- OpenClaw Web Search docs:
  `https://docs.openclaw.ai/tools/web`
- Pi provider hook docs:
  `vendor/pi/packages/coding-agent/docs/extensions.md`
- Pi Codex Responses provider:
  `vendor/pi/packages/ai/src/providers/openai-codex-responses.ts`
- Vendored Codex web-search source:
  `vendor/openai-codex/codex-rs/tools/src/tool_spec.rs`
