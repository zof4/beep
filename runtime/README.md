# Beep Runtime Slice

This runtime is the first container slice for Beep. It assumes there is no API
key, installs the official Codex CLI in the image, and persists ChatGPT/Codex
auth under `/state/codex`.

The command surface is:

- `beep-runtime`: Beep-owned JSON control surface for runtime capabilities,
  model selection, reasoning effort, account status, and usage/context status.
- `beep-agentd`: starts the long-running Beep daemon inside the runtime
  container. It autostarts one canonical Pi RPC agent session, queues user work,
  records state under `/state`, and exposes a private control surface.
- `beep-runtime-api`: compatibility alias for `beep-agentd`.
- `beep-codex-login`: starts `codex login --device-auth` inside the runtime.
- `beep-codex-status`: checks the persisted Codex login state.
- `beep-codex-agent-proof`: runs `codex exec` inside `/workspace` with JSONL
  events written to `/state/proofs/<run-id>/events.jsonl`.
- `beep-pi-codex-proof`: runs vendored Pi against Codex's ChatGPT auth state
  and writes JSONL plus a parsed summary under `/state/proofs/pi-<run-id>`.
- `beep-lcm-inspect`: prints the current Lossless Claw database row counts and
  recent conversations.

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
./scripts/codex-runtime-login.sh
./scripts/codex-runtime-status.sh
./scripts/codex-runtime-agent-proof.sh
./scripts/pi-runtime-codex-proof.sh
./scripts/lcm-runtime-inspect.sh
```

The proof command requires a completed ChatGPT device login first. A successful
run creates a workspace under `.beep-dev/workspace/codex-agent-proof/<run-id>`
and a parsed proof summary under `.beep-dev/state/proofs/<run-id>/summary.json`.

The Pi proof uses the same Codex `auth.json` created by `beep-codex-login`,
then passes the access token into Pi's vendored `openai-codex-responses`
provider. It reads the selected model and thinking level from `beep-runtime`
unless `BEEP_PI_CODEX_MODEL` or `BEEP_PI_THINKING` are set. Vendored Pi is baked
into the runtime image under `/opt/pi`; `/vendor` remains a read-only reference
mount.

`beep-agentd` is the long-running runtime process. It starts inside the Docker
container and stays up. On boot, it autostarts the canonical Beep session
`agent_beep` unless `BEEP_AGENT_AUTOSTART=0` is set. That session is a Pi
`--mode rpc` process using a short-lived model credential. When the control
plane starts the runtime, durable Codex auth stays host-side and the runtime
gets the short-lived credential through the control plane model-credential
endpoint. The active Pi provider still receives that credential inside the Pi
process until the future model-gateway provider adapter replaces Pi's current
`--api-key` provider path, so this local slice is not production process-level
secret isolation.

The daemon keeps a durable request queue under `/state/api/agents/beep`. The
control plane proxies the `/agent` endpoints for normal Beep work. After
control-plane adoption, backend operators should start with
[`docs/first-usable-backend-loop.md`](../docs/first-usable-backend-loop.md) and
the control-plane routes on `:8788`; direct runtime curls on `:8787` remain
compatibility and debug paths:

```bash
curl http://127.0.0.1:8787/health
runtime_api_token="$(./scripts/beep-control-plane.sh runtime-api-token)"
curl http://127.0.0.1:8787/agent \
  -H "authorization: Bearer $runtime_api_token"
curl -X POST http://127.0.0.1:8787/agent/submit \
  -H "authorization: Bearer $runtime_api_token" \
  -H 'content-type: application/json' \
  -d '{"message":"Work in the current directory and create proof.txt"}'
curl http://127.0.0.1:8787/agent/requests \
  -H "authorization: Bearer $runtime_api_token"
curl 'http://127.0.0.1:8787/agent/events?limit=20' \
  -H "authorization: Bearer $runtime_api_token"
curl http://127.0.0.1:8787/agent/summary \
  -H "authorization: Bearer $runtime_api_token"
```

`beep-agentd` is not the future trust boundary for external tools. It owns the
sandbox-local agent loop, queue, events, Pi RPC process, and LCM adapter. Future
website, location, calendar, email, Docker, and secret tools should be exposed
to the harness as local stubs that submit `ToolIntent` requests to the control
plane. The control plane owns the durable tool router, gatekeeper, grants,
audit log, and typed broker execution.

### Local Control Plane

The local control plane lives under `control-plane/` and can be run from the
host with `./scripts/beep-control-plane.sh start`, inspected with
`./scripts/beep-control-plane.sh status`, and stopped with
`./scripts/beep-control-plane.sh stop`. It owns host authority and issues scoped
runtime control-plane tool credentials, while LCM context assembly, transcript
ingest, and Hindsight ordering stay runtime-owned.

Backend operators should use the control-plane request, backend status, runtime
lifecycle, and `/api/agent/...` proxy routes first. Use the direct runtime API
examples below when testing lower-level compatibility or debugging runtime-local
behavior.

For testing or side sessions, the lower-level session API still exists. It
starts additional Pi RPC sessions and stores each under
`/state/api/sessions/<session-id>` with a matching workspace under
`/workspace/api-sessions/<session-id>`:

```bash
curl http://127.0.0.1:8787/capabilities
runtime_api_token="$(./scripts/beep-control-plane.sh runtime-api-token)"
curl -X POST http://127.0.0.1:8787/sessions \
  -H "authorization: Bearer $runtime_api_token" \
  -d '{}'
curl -X POST http://127.0.0.1:8787/sessions/<id>/prompt \
  -H "authorization: Bearer $runtime_api_token" \
  -H 'content-type: application/json' \
  -d '{"message":"Work in the current directory and create proof.txt","waitForCompletion":true}'
curl http://127.0.0.1:8787/sessions/<id>/events \
  -H "authorization: Bearer $runtime_api_token"
curl http://127.0.0.1:8787/sessions/<id>/summary \
  -H "authorization: Bearer $runtime_api_token"
```

`POST /runs` is the convenience endpoint for a complete autonomous task. It
creates a Pi RPC session, sends the prompt, waits for completion, records the
turn stream into LCM by default, closes the session, and returns the final text,
workspace path, event summary, and LCM ingest summary. Long-lived sessions stay
available through `/sessions/:id/prompt`, `/sessions/:id/steer`,
`/sessions/:id/follow-up`, `/sessions/:id/abort`, and `/sessions/:id/rpc`.

The Beep daemon path is more important than `/runs`: `/agent/submit` queues work
onto the always-on `agent_beep` session instead of creating a throwaway session.
After each completed request, new Pi session messages are incrementally ingested
through an in-process `LcmService` backed by Lossless Claw's
`LcmContextEngine`, with a checkpoint so repeated
requests do not duplicate earlier canonical transcript messages. Raw Pi RPC
events remain diagnostic data for progress, replay, and debugging; they are not
the LCM memory substrate.

The control plane can inspect and operate LCM through private agent endpoints:

```bash
runtime_api_token="$(./scripts/beep-control-plane.sh runtime-api-token)"
curl http://127.0.0.1:8787/agent/lcm/status \
  -H "authorization: Bearer $runtime_api_token"
curl -X POST http://127.0.0.1:8787/agent/lcm/compact \
  -H "authorization: Bearer $runtime_api_token" \
  -H 'content-type: application/json' \
  -d '{"force":true,"tokenBudget":2048,"currentTokenCount":2400}'
curl -X POST http://127.0.0.1:8787/agent/lcm/assemble-preview \
  -H "authorization: Bearer $runtime_api_token" \
  -H 'content-type: application/json' \
  -d '{"tokenBudget":2048}'
curl -X POST http://127.0.0.1:8787/agent/lcm/maintain \
  -H "authorization: Bearer $runtime_api_token"
curl -X POST http://127.0.0.1:8787/agent/lcm/backup \
  -H "authorization: Bearer $runtime_api_token"
curl http://127.0.0.1:8787/agent/lcm/doctor \
  -H "authorization: Bearer $runtime_api_token"
```

### Updating Hindsight And LCM

Use:

```bash
./scripts/update-vendored-references.sh
```

The script updates vendored OpenAI Codex, Pi, and Lossless Claw references, then
pulls the pinned Hindsight image from `docker/hindsight-image.env` and records
the resolved image digest in `docker/hindsight-image.lock`. After updating, run:

```bash
./scripts/hindsight-runtime-smoke.sh
./scripts/lcm-runtime-inspect.sh
```

### Hindsight Sidecar Smoke

Beep can run the stock local Hindsight sidecar through Docker Compose. The
sidecar is local-only Hindsight infrastructure; its LLM and embedding work are
configured to use OpenAI Codex OAuth through the same persisted Codex login
state mounted under `.beep-dev/state/codex`.

Run:

```bash
./scripts/hindsight-runtime-smoke.sh
```

The smoke writes a canary to the configured Beep Hindsight bank, recalls it, and
checks that the retained document is readable. It fails if the sidecar is down,
if Codex auth is missing, or if Hindsight recall does not return the canary.

### Hindsight + LCM Live Proof

Run:

```bash
./scripts/smoke-test-hindsight-lcm.sh
```

The proof seeds a project rule, forces LCM compaction, restarts the runtime API,
then asks Beep to continue without restating the rule. Passing evidence is:

- `hindsightMemory.latest.kind` includes `hindsight_recall` or `hindsight_retain`
- `lcmContextInjection.latest.kind` is `assemble`
- `/workspace/api-sessions/agent_beep/hindsight-lcm-proof-recall.txt` contains
  the sidecar + LCM ordering rule

`beep-runtime models list` merges Codex's refreshed `models_cache.json` with
Pi's `openai-codex` model registry. `beep-runtime usage status` reads prior
Codex/Pi proof event streams and reports aggregate usage plus the last known
context usage against the selected model's context window. `account status`
intentionally redacts tokens and only reports token/account presence.

Lossless Claw is baked into the image under `/opt/lossless-claw`. The Beep
daemon uses the vendored engine directly; `lcm-record-pi-session.mjs` remains as
a thin CLI wrapper for dev proof runs. The proof directory contains
`lcm-summary.json`, and the parsed `summary.json` includes that same LCM
section.

Beep also loads `/runtime/pi-extensions/lcm-context-extension.mjs` into the
long-running Pi RPC process. The extension uses Pi's native `context` hook, so
each provider call asks `beep-agentd` for `LcmContextEngine.assemble(...)`
output before Pi converts messages to the model payload. The internal route is
`POST /internal/lcm/context` and is protected by an in-memory bearer token that
is only passed to the child runtime process.

When LCM context injection is enabled, `beep-agentd` disables Pi native
auto-compaction over RPC. Pi still owns the agent loop, tools, queueing,
steering, model selection, and usage reporting; LCM owns pre-model context
assembly and post-turn canonical transcript ingestion. Per-turn telemetry is
written to `lcm-context-injection.json` and appears in `GET /agent/summary`
under `lcmContextInjection`.
