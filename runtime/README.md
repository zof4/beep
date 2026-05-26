# Beep Runtime Slice

This runtime is the first container slice for Beep. The canonical runtime path
uses the long-running `/agent` daemon API. Production model credentials should
come from the control-plane/model-gateway adapter; local dev can still opt into
reading an existing Codex `auth.json` access token with `BEEP_ALLOW_RUNTIME_CODEX_AUTH=1`.

Boundary vocabulary:

- The **control plane** is the authority plane for auth, lifecycle, approvals,
  audit, external tool dispatch, and typed host brokers.
- The **runtime house** is the sandboxed agent data plane. It owns
  `beep-agentd`, the harness process, the request queue, runtime-local tool
  stubs, LCM, and event/state adapters.
- The **agent workspace** is the less-trusted command area where model-directed
  shell/file work happens.

LCM belongs in the runtime house, not in the control plane and not as arbitrary
workspace scratch. Durable auth and approvals belong in the control plane, not
in the runtime house or workspace. The full boundary contract is documented in
[Agent Runtime Boundaries](../docs/agent-runtime-boundaries.md).

Runtime dependency policy is latest-by-default. The host wrappers run
`scripts/refresh-runtime-dependencies.sh --if-stale` on first use and then after
`BEEP_RUNTIME_UPDATE_INTERVAL_SECONDS` elapses, defaulting to 24 hours. That
refreshes vendored `openai-codex`, `pi`, and `lossless-claw` from their `main`
branches, writes update state under `.beep-dev/update-state`, and bumps
`BEEP_RUNTIME_UPDATE_EPOCH` so Docker does not reuse a stale Codex CLI install
layer. The image installs `@openai/codex@latest` at build time.

Update controls:

```bash
scripts/refresh-runtime-dependencies.sh --force
scripts/refresh-runtime-dependencies.sh --status
BEEP_RUNTIME_AUTO_UPDATE=0 ./scripts/beep-agentd.sh
BEEP_RUNTIME_UPDATE_INTERVAL_SECONDS=3600 ./scripts/beep-agentd.sh
BEEP_RUNTIME_UPDATE_REQUIRED=1 ./scripts/beep-agentd.sh
```

The command surface is:

- `beep-runtime`: Beep-owned JSON control surface for runtime capabilities,
  model selection, reasoning effort, account status, and usage/context status.
- `beep-agentd`: starts the long-running Beep daemon inside the runtime
  container. It autostarts one canonical Pi RPC agent session, queues user work,
  records state under `/state`, and exposes a private control surface.
- `beep-runtime-api`: compatibility alias for `beep-agentd`.
- `beep-codex-login`: dev compatibility command for `codex login --device-auth`
  inside the runtime.
- `beep-codex-status`: checks the persisted Codex login state.
- `beep-codex-agent-proof`: dev-only standalone proof command. It writes
  diagnostic JSONL under `/state/proofs/<run-id>` and does not mutate LCM or
  bypass control-plane authority.
- `beep-pi-codex-proof`: runs vendored Pi through the model credential adapter
  as a dev-only standalone proof. It writes JSONL plus a parsed summary under
  `/state/proofs/pi-<run-id>` and does not mutate LCM or establish production
  auth custody.
- `beep-lcm-inspect`: prints the current Lossless Claw database row counts and
  recent conversations.
- `scripts/refresh-runtime-dependencies.sh`: host-side update lane for latest
  Codex, Pi, and Lossless Claw before rebuilding runtime images.
- `scripts/beep-control-plane.sh`: host-side control plane. It starts the
  runtime through Docker Compose, brokers model credentials to the runtime, and
  exposes scoped runtime tools such as preview port sharing.

Host wrappers:

```bash
./scripts/beep-runtime.sh capabilities
./scripts/beep-runtime.sh models list
./scripts/beep-runtime.sh models current
./scripts/beep-runtime.sh models set gpt-5.5
./scripts/beep-runtime.sh thinking get
./scripts/beep-runtime.sh thinking set low
./scripts/beep-runtime.sh usage status
./scripts/beep-runtime.sh account status
./scripts/beep-agentd.sh
./scripts/beep-runtime-api.sh
./scripts/beep-control-plane.sh
./scripts/codex-runtime-login.sh
./scripts/codex-runtime-status.sh
./scripts/codex-runtime-agent-proof.sh
./scripts/pi-runtime-codex-proof.sh
./scripts/lcm-runtime-inspect.sh
```

The proof command requires a completed ChatGPT device login first. A successful
run creates a workspace under `.beep-dev/workspace/codex-agent-proof/<run-id>`
and a parsed proof summary under `.beep-dev/state/proofs/<run-id>/summary.json`.

The Pi proof resolves its model credential through `/runtime/src/model-credential.mjs`.
That adapter prefers `BEEP_MODEL_GATEWAY_CREDENTIAL_URL`. Local dev can opt into
the temporary Codex auth compatibility path with `BEEP_ALLOW_RUNTIME_CODEX_AUTH=1`,
which reads an existing access token but does not refresh or own durable auth.
It reads the selected model and thinking level from `beep-runtime` unless
`BEEP_PI_CODEX_MODEL` or `BEEP_PI_THINKING` are set. Vendored Pi is baked into
the runtime image under `/opt/pi`; `/vendor` remains a read-only reference mount.

`beep-agentd` is the long-running runtime process. It starts inside the Docker
container and stays up. On boot, it autostarts the canonical Beep session
`agent_beep` unless `BEEP_AGENT_AUTOSTART=0` is set. That session is a Pi
`--mode rpc` process using a scoped model credential from the gateway adapter
or the explicit local-dev compatibility path. Its
workspace is `/workspace/api-sessions/agent_beep`, and its event/session state
is under `/state/api/sessions/agent_beep`.

The daemon keeps a durable request queue under `/state/api/agents/beep`. The
control plane should use the `/agent` endpoints for normal Beep work:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/agent
curl -X POST http://127.0.0.1:8787/agent/submit \
  -H 'content-type: application/json' \
  -d '{"message":"Work in the current directory and create proof.txt"}'
curl http://127.0.0.1:8787/agent/requests
curl http://127.0.0.1:8787/agent/events?limit=20
curl http://127.0.0.1:8787/agent/summary
```

`beep-agentd` is not the trust boundary for external tools. It owns the
sandbox-local agent loop, queue, events, Pi RPC process, and LCM adapter. Tools
that need host authority are registered as normal Pi tools inside the runtime,
then call the control-plane tool service with a scoped runtime capability token.
The control plane owns the durable tool service, future gatekeeper, grants, audit
log, and typed broker execution. Low-risk tools can be default-allowed by policy;
restricted tools return `needs_review` until the gatekeeper is attached.

Do not add new host-authority behavior directly to `beep-agentd` because it is
convenient for the agent loop. Add a runtime tool stub, pass the authority
request through the control plane, and keep operator-only actions behind the
operator credential.

The host-side control plane runs on `http://127.0.0.1:8788`:

```bash
./scripts/beep-control-plane.sh start
./scripts/beep-control-plane.sh status
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/api/runtimes/local
curl http://127.0.0.1:8788/api/tools
curl -X POST http://127.0.0.1:8788/api/requests \
  -H 'content-type: application/json' \
  -d '{"message":"Start a dev server on 0.0.0.0:3000 and expose it."}'
```

The first real scoped runtime tool is `preview_port_expose`. It exposes a dev
server already running inside the runtime container on ports `3000-3099` through
the control-plane proxy at `http://127.0.0.1:8788/preview/local/<port>/` and the
direct Docker mapping at `http://127.0.0.1:<13000-13099>/`.

The first web tools are `web_search` and `web_fetch`. They are registered by
the managed control-plane tool extension and execute through the control-plane
`WebToolService`, which owns provider keys and the search/fetch provider
defaults. Provider adapters are vendored in the control plane so Tavily, Exa,
Brave, Firecrawl, Linkup, Perplexity Search, and SerpAPI can be swapped or
compared without changing the Pi tool contract. See
[Web Tool Surface](../docs/web-tool-surface.md).

The first restricted managed-container tool is
`preview_container_create_static_site`. It requests
`preview.container.createStaticSite`, creates a pending approval, and only the
host/operator side can approve it with the control-plane operator token. The
runtime token cannot approve its own restricted tool calls. The same
operator-only surface lists and stops managed previews through
`GET /api/sites` and `POST /api/sites/<siteId>/stop`.

For testing or side sessions, the lower-level session API exists only when
`BEEP_RUNTIME_DEV_ENDPOINTS=1`. It starts additional Pi RPC sessions and stores each under
`/state/api/sessions/<session-id>` with a matching workspace under
`/workspace/api-sessions/<session-id>`:

```bash
curl http://127.0.0.1:8787/capabilities
curl -X POST http://127.0.0.1:8787/sessions -d '{}'
curl -X POST http://127.0.0.1:8787/sessions/<id>/prompt \
  -H 'content-type: application/json' \
  -d '{"message":"Work in the current directory and create proof.txt","waitForCompletion":true}'
curl http://127.0.0.1:8787/sessions/<id>/events
curl http://127.0.0.1:8787/sessions/<id>/summary
```

`POST /runs` is a dev-only convenience endpoint for a complete autonomous task. It
creates a Pi RPC session, sends the prompt, waits for completion, records the
turn stream into LCM by default, closes the session, and returns the final text,
workspace path, event summary, and LCM ingest summary. Long-lived sessions stay
available through `/sessions/:id/prompt`, `/sessions/:id/steer`,
`/sessions/:id/follow-up`, `/sessions/:id/abort`, and `/sessions/:id/rpc`.
For focused runtime proofs, `POST /sessions` and `POST /runs` accept the same
Pi spawn controls used internally by delegated workers, including
`loadLcmContextExtension`, `loadLcmRecallToolsExtension`,
`loadControlPlaneToolsExtension`, `noBuiltinTools`, `noContextFiles`,
`noSkills`, `noPromptTemplates`, `noThemes`, `toolAllowlist`, and
`systemPrompt`.

The Beep daemon path is canonical: `/agent/submit` queues work
onto the always-on `agent_beep` session instead of creating a throwaway session.
After each completed request, new Pi session messages are incrementally ingested
through an in-process `LcmService` backed by Lossless Claw's native
`LcmContextEngine.afterTurn(...)` path, with a checkpoint so repeated
requests do not duplicate earlier canonical transcript messages. Raw Pi RPC
events remain diagnostic data for progress, replay, and debugging; they are not
the LCM memory substrate.

The agent should reach compacted history through runtime recall tools, not by
querying or editing the LCM database directly from the workspace. Control-plane
LCM operations such as compact, maintain, rotate, backup, and doctor should stay
on private runtime endpoints that the control plane can call for future UI/admin
flows.

The control plane can inspect and operate LCM through private agent endpoints:

```bash
curl http://127.0.0.1:8787/agent/lcm/status
curl -X POST http://127.0.0.1:8787/agent/lcm/compact \
  -H 'content-type: application/json' \
  -d '{"force":true,"tokenBudget":2048,"currentTokenCount":2400}'
curl -X POST http://127.0.0.1:8787/agent/lcm/assemble-preview \
  -H 'content-type: application/json' \
  -d '{"tokenBudget":2048}'
curl -X POST http://127.0.0.1:8787/agent/lcm/maintain
curl -X POST http://127.0.0.1:8787/agent/lcm/reset \
  -H 'content-type: application/json' \
  -d '{"reason":"reset"}'
curl -X POST http://127.0.0.1:8787/agent/lcm/backup
curl http://127.0.0.1:8787/agent/lcm/doctor
```

`beep-runtime models list` merges Codex's refreshed `models_cache.json` with
Pi's `openai-codex` model registry. `beep-runtime usage status` reads prior
Codex/Pi proof event streams and reports aggregate usage plus the last known
context usage against the selected model's context window. `account status`
intentionally redacts tokens and only reports token/account presence.

Lossless Claw is baked into the image under `/opt/lossless-claw`. The Beep
daemon uses the vendored engine directly. `lcm-record-pi-session.mjs` remains as
a canonical session-message CLI wrapper for explicit dev diagnostics. The legacy
raw-event LCM writer has been removed; standalone proof summaries no longer
append raw event floods to LCM.

Beep also loads `/runtime/pi-extensions/lcm-context-extension.mjs` into the
long-running Pi RPC process. The extension uses Pi's native `context` hook, so
each provider call asks `beep-agentd` for `LcmContextEngine.assemble(...)`
output before Pi converts messages to the model payload. The internal route is
`POST /internal/lcm/context` and is protected by an in-memory bearer token that
is only passed to the child runtime process.

The same extension forwards Pi lifecycle hooks to LCM. New-session/reset and
session-end events call `POST /internal/lcm/lifecycle`, which executes
Lossless Claw's `before_reset` and `session_end` semantics through the shared
`LcmService` engine connection.

Beep also loads `/runtime/pi-extensions/lcm-recall-tools-extension.mjs` as a
managed Pi extension. It registers `lcm_grep`, `lcm_describe`, and
`lcm_expand_query` as normal main-agent tools. The extension does not touch
SQLite directly; it calls the runtime's `POST /internal/lcm/tool` route, which
executes through the shared `LcmService` engine connection. The extension also uses Pi's
`before_agent_start` hook to add Beep's LCM recall policy to the system prompt
so the agent knows when exact recall is expected.

For deep recall, `lcm_expand_query` creates a bounded delegated Pi expansion
session. That session is started with built-in tools disabled, a narrow LCM tool
allowlist, and a scoped runtime expansion grant; only delegated sessions receive
`lcm_expand`.

LCM compaction uses the same Beep model credential adapter as Pi. The runtime
defaults to `openai-codex` with the configured Beep model for Lossless Claw
summary calls, preserving 8 fresh messages unless `LCM_FRESH_TAIL_COUNT` or
`BEEP_LCM_FRESH_TAIL_COUNT` overrides it. The live proof
`lcm-real-proof-final_20260525t031040171z_a12865d1` forced model-backed
compaction into `sum_fd52c0d6d902ab75`, then verified parent
`lcm_expand_query` and delegated `lcm_expand` calls through real Pi sessions.

When LCM context injection is enabled, `beep-agentd` disables Pi native
auto-compaction over RPC. Pi still owns the agent loop, tools, queueing,
steering, model selection, and usage reporting; LCM owns pre-model context
assembly, lifecycle handling, and post-turn canonical transcript ingestion.
Per-turn telemetry is
written to `lcm-context-injection.json` and appears in `GET /agent/summary`
under `lcmContextInjection`.

LCM is the exact-continuity provider, not a semantic memory system. It should
assemble bounded, source-backed continuity before every provider request that
can carry conversational context. The broader agent-facing memory design is
documented in [Beep Memory Surface](../docs/beep-memory-surface.md): the next
memory step is to harden summary-backed LCM context and benchmark recall, then
add semantic/search memory as the complementary search and recall layer beside
LCM.
