# LCM First-Party Integration Plan

## Purpose

Beep now vendors Lossless Claw as a first-party runtime context engine on the
long-running Pi path. LCM owns pre-model context assembly, post-turn canonical
transcript ingestion, deduplication, compaction policy, recall tools, delegated
expansion, lifecycle hooks, and maintenance surfaces. The remaining work is
hardening and production policy, not replacing the integration shape.

The target is to make Beep's Pi runtime use Lossless Claw at that level, not as a passive event sink.

Boundary rule: LCM lives in the runtime house. It is part of the agent data plane
because it assembles model context before provider calls and ingests canonical
transcript messages after turns. The control plane may operate LCM through
private runtime endpoints, but LCM does not own auth, approvals, Docker, domains,
secrets, or host tool policy. The agent workspace should access LCM through
runtime recall tools, not direct SQLite writes. See
[Agent Runtime Boundaries](./agent-runtime-boundaries.md).

## Current Beep State

Working:

- `beep-agentd` runs as a long-running Docker service.
- It autostarts the canonical `agent_beep` Pi RPC session.
- Pi runs against the `openai-codex` provider using the runtime model credential adapter: `BEEP_MODEL_GATEWAY_CREDENTIAL_URL` for the control-plane path, or explicit local-dev `BEEP_ALLOW_RUNTIME_CODEX_AUTH=1` compatibility.
- The local runtime update lane refreshes `vendor/pi`, `vendor/lossless-claw`,
  and `vendor/openai-codex` from `main` on first use and then after the
  configured update interval, so LCM and Pi are not frozen to stale local copies.
- Current runtime model selection is `gpt-5.5` with `thinking=low`.
- The daemon has a durable request queue under `/state/api/agents/beep`.
- The clean-slate proof request completed through the long-running session and wrote `clean-slate-lcm-proof.txt` in `/workspace/api-sessions/agent_beep`.
- LCM SQLite exists at `/lcm/beep-lcm.sqlite`.
- New completed requests are imported from Pi's durable session JSONL through
  Lossless Claw's native `LcmContextEngine.afterTurn(...)` path.
- The LCM checkpoint is based on Pi session message count, so replaying `/agent/lcm` does not duplicate already-ingested transcript messages.
- Forced proof compaction and context assembly work through `LcmContextEngine.compact` and `LcmContextEngine.assemble`.
- The dev runtime has been reset to a clean LCM baseline: 1 conversation, 4 messages, 5 message parts, and 0 legacy raw-event rows.
- `beep-agentd` now uses an in-process `LcmService`, so normal runtime recording and control endpoints share one Lossless Claw engine/DB connection instead of shelling out to a proof script.
- The legacy raw-event LCM proof importer has been removed. Standalone proof summaries are diagnostics-only; the canonical LCM write path is Pi session-message ingestion through the long-running `/agent` daemon path.
- Private control-plane endpoints now expose status, compaction, assemble preview, maintain, rotate, backup, and doctor operations.
- Pi context injection now uses Pi's first-party extension `context` hook. `beep-agentd` loads `/runtime/pi-extensions/lcm-context-extension.mjs` into the long-running Pi RPC process, and that extension calls the daemon's internal `POST /internal/lcm/context` route before each provider call.
- When the extension is loaded, `beep-agentd` disables Pi native auto-compaction through RPC so Lossless Claw owns pre-model context assembly.
- The live proof request `agent_req_mpe4o9t8_16ee86e4` completed through the long-running agent, created `lcm-context-injection-proof.txt`, made 2 successful LCM assemble calls during the turn loop, and appended 4 new canonical transcript messages to LCM.
- Pi recall tools are now registered through `/runtime/pi-extensions/lcm-recall-tools-extension.mjs`.
- `lcm_grep`, `lcm_describe`, and `lcm_expand_query` call `POST /internal/lcm/tool`, which executes through the in-process `LcmService` instead of direct SQLite access.
- The recall extension also adds Beep's LCM recall policy through Pi's
  `before_agent_start` system-prompt hook, so the agent is taught to use the
  exact recall tools when old context matters.
- The live recall proof request `agent_req_mpkbsxy4_da7686a1` completed with exactly one `lcm_grep` tool call and recovered an older `preview_port_expose` request from LCM.
- Completed turns now enter Lossless Claw through `LcmContextEngine.afterTurn(...)`, not direct batch writes, so LCM owns ingestion and post-turn compaction policy.
- LCM model-backed compaction now uses Beep's model credential adapter, so
  Lossless Claw summaries can be produced through the same
  `openai-codex`/model-gateway or local-dev auth compatibility path as Pi.
- Beep's runtime LCM default preserves 8 fresh messages unless
  `LCM_FRESH_TAIL_COUNT` or `BEEP_LCM_FRESH_TAIL_COUNT` overrides it. This
  keeps early real histories eligible for compaction while remaining
  configurable.
- Pi session lifecycle hooks now forward new/resume/fork/shutdown semantics to LCM through `POST /internal/lcm/lifecycle`.
- `lcm_expand_query` now matches the first-party delegated shape: the main
  agent selects candidate summaries, the runtime creates a scoped grant-backed
  delegated Pi session, and that session receives `lcm_grep`, `lcm_describe`,
  and sub-agent-only `lcm_expand`.
- Live delegated expansion proof
  `lcm-real-proof-final_20260525t031040171z_a12865d1` forced real
  model-backed compaction, then called `lcm_expand_query`; delegated Pi session
  `lcm_expansion_20260525t031044817z_eeebe3a5` had built-in tools disabled,
  only `lcm_grep`, `lcm_describe`, and `lcm_expand` allowlisted, called
  `lcm_expand`, and returned citation `sum_fd52c0d6d902ab75`.

Not first-party-level yet:

- Production will still need a rotate/archive policy for any future polluted or obsolete runtime state, but the current dev baseline is clean.
- Tiny raw-message-only histories currently return Lossless Claw's safe live-context fallback instead of a summary-backed `thread_bootstrap` projection. That is correct first-party behavior until summaries or complete context-item coverage exist.
- The live daemon path now has a manual summary-backed delegated expansion
  proof; it still needs to be promoted into an automated regression.
- Delegated/stateless write policy still needs production hardening so
  expansion sessions cannot pollute durable continuity state.
- LCM admin commands are not yet surfaced through stable control-plane UI/API
  contracts beyond the private runtime endpoints.
- LCM is only the exact-continuity and compaction provider. Semantic/search
  memory should be added beside LCM as the separate search and recall layer,
  with direct tools and evidence references back to LCM. See
  [Beep Memory Surface](./beep-memory-surface.md).

## How First-Party Lossless Claw Handles It

The first-party plugin wires into the host runtime through `vendor/lossless-claw/src/plugin/index.ts`:

- `before_prompt_build`: prepends the Lossless recall policy.
- `registerContextEngine("lossless-claw", ...)`: exposes a runtime context engine.
- `registerTool`: adds `lcm_grep`, `lcm_describe`, `lcm_expand`, and `lcm_expand_query`.
- `registerCommand`: adds `/lcm`, `/lcm status`, `/lcm rotate`, `/lcm doctor`, and related command handling.
- `before_reset`: applies `/new` and `/reset` semantics.
- `session_end`: handles rollovers, deletion, and session lifecycle cleanup.

Pi does not expose that exact OpenClaw plugin API. Beep maps the same concepts
onto Pi's native extension surface:

- `before_agent_start`: injects the LCM recall policy into the system prompt.
- `context`: calls `LcmContextEngine.assemble(...)` before provider requests.
- `registerTool`: exposes `lcm_grep` and `lcm_describe`.
- `session_before_switch`: applies `/new` semantics before Pi switches sessions.
- `session_shutdown`: forwards session-end semantics.

The first-party engine is `LcmContextEngine` in `vendor/lossless-claw/src/engine.ts`.

It handles runtime state this way:

1. Bootstrap or reconcile the canonical session transcript.
2. Ingest only persistable agent messages, not raw transport events.
3. Store messages and structured parts in SQLite.
4. Append context items that can later be raw messages or summary references.
5. Deduplicate replayed batches and crash-recovered tails.
6. Externalize large files, large tool outputs, and large raw payloads.
7. After each turn, evaluate whether compaction is needed.
8. Record deferred compaction debt or compact inline depending on config.
9. Assemble future model context from summaries plus a protected fresh tail.
10. Expose recall tools so the agent can search, describe, and expand compacted history.
11. Maintain transcript storage with optional GC and `/lcm rotate`.

The key distinction: Lossless Claw preserves every meaningful transcript message. It does not require every streaming event or duplicate snapshot to become a memory message.

## Correct Beep Architecture

```mermaid
flowchart TD
  User["User Request"] --> Agentd["beep-agentd"]
  Agentd --> Pi["Pi RPC Session"]
  Pi --> Events["Raw Pi Event Log"]
  Pi --> ContextHook["Pi context extension hook"]
  ContextHook --> LcmRoute["beep-agentd internal LCM context route"]
  LcmRoute --> LcmEngine
  LcmEngine --> Context["Assembled Next-Turn Context"]
  Context --> Pi
  Pi --> Adapter["Pi Session Adapter"]
  Adapter --> LcmEngine["Lossless Claw Context Engine"]
  LcmEngine --> DB["LCM SQLite + Large Files"]
  LcmEngine --> RecallTools["lcm_grep / lcm_describe / lcm_expand_query / delegated lcm_expand"]
```

The adapter is not the memory system. It is the boundary glue that maps Pi's session JSONL shape into Lossless Claw's canonical message input. Raw event logs remain useful for diagnostics, replay, UI progress, and debugging. They should not be the memory substrate.

## Required Beep Modules

### 1. Pi Session Adapter

Input:

- Pi session JSONL from `/state/api/sessions/<id>/pi-sessions/*.jsonl`.
- Pi RPC events from `/state/api/sessions/<id>/events.jsonl` only for diagnostics and fallback metadata.

Output:

- Calls into `LcmContextEngine.afterTurn(...)` with canonical transcript
  messages compatible with Lossless Claw.

Rules:

- Keep user prompt once.
- Keep assistant final message once per assistant response.
- Keep tool calls and tool results as structured parts.
- Keep final answer once.
- Preserve response IDs, tool call IDs, model metadata, usage, and timestamps as metadata.
- Drop streaming-only events from LCM memory: `message_update`, `tool_execution_update`, `response`, empty `message_start`, routine `agent_start`, routine `agent_end`.
- Keep raw JSONL as diagnostics, not as LCM conversation rows.

Acceptance:

- A request that previously appended roughly 100 raw-event rows appends only the new canonical Pi session messages.
- The persisted message count tracks Pi's durable session message count order of magnitude.
- Re-running LCM ingest over the same completed request is idempotent.
- Current proof: the clean-slate live request `agent_req_mpdjyo6f_8bba9e23` appended 4 canonical messages and 4 context items from a zero-row LCM DB, then a second `/agent/lcm` pass appended 0 messages and 0 context items.

### 2. Beep LCM Engine Adapter

Replace passive store writes with a wrapper around first-party `LcmContextEngine` behavior.

Responsibilities:

- Initialize the Lossless Claw DB and migrations.
- Create an LCM conversation per stable Beep runtime session.
- Call `assemble` before Pi model turns once Pi integration supports context injection.
- Call `afterTurn` after each completed canonical turn.
- Call `maintain` for deferred compaction and transcript maintenance.
- Expose `compact`, `rotate`, status, and diagnostics through Beep runtime/control APIs.

Acceptance:

- LCM summaries are created when thresholds are forced low in test config.
- Future context can be assembled from summaries plus fresh tail.
- LCM no longer has `summaries=0` after a forced compaction test.
- Current proof: forced temp-DB compaction over 37 Pi session messages created 3 summaries and assembled 4 context messages with `contextProjection.mode=thread_bootstrap`.

### 3. Pi Context Injection

Pi currently owns its session context. Beep needs a controlled way to feed Lossless Claw's assembled context into Pi before model calls.

Implemented route:

- Keep `--mode rpc` for daemon control.
- Load a Beep Pi extension via `--extension /runtime/pi-extensions/lcm-context-extension.mjs`.
- Use Pi's existing `context` event, which runs before `convertToLlm`.
- Have the extension call `POST /internal/lcm/context` with the live Pi `AgentMessage[]`.
- Have `beep-agentd` call `LcmContextEngine.assemble(...)` through the in-process `LcmService`.
- Return the assembled message array to Pi before the provider request.
- Disable Pi native auto-compaction while this route is active.

Acceptance:

- A large prior conversation can be compacted by LCM and still influence the next Pi turn.
- Pi native compaction is disabled when Lossless Claw owns compaction.
- No duplicate or conflicting compaction summaries are written by Pi and LCM for the same turn.
- Current proof: the request `agent_req_mpe4o9t8_16ee86e4` made two `assemble` calls through the extension path. LCM safely fell back to live context because the current dev history has no summaries and the DB context items trail the live turn by the unpersisted prompt/tool messages.

### 4. LCM Recall Tool Surface

Register LCM tools into Pi as normal tools:

- `lcm_grep`
- `lcm_describe`
- `lcm_expand_query`

`lcm_expand` should remain restricted to delegated/sub-agent recall contexts, matching first-party Lossless Claw's recursion guard.

Acceptance:

- The agent can search old memories without direct SQL.
- The agent can expand a summary into source-backed details.
- Tool outputs cite summary IDs or message references for follow-up.

Status:

- `lcm_grep`, `lcm_describe`, and `lcm_expand_query` are implemented as
  main-agent managed Pi extension tools.
- Tool execution goes through `POST /internal/lcm/tool` and the shared
  `LcmService` engine connection.
- `lcm_expand_query` spawns a delegated Pi expansion session. That session gets
  only the LCM recall tools it needs and `lcm_expand` requires a scoped runtime
  expansion grant.

### 5. Large Payload Handling

Mirror Lossless Claw's first-party behavior:

- Externalize large tool results and raw payloads into LCM large-file storage.
- Store compact references in message rows.
- Use `lcm_describe` to inspect large payloads.
- Enable stub substitution for evictable large tool results after migration and tests.

Acceptance:

- Large tool output does not blow up active context.
- Raw payload remains recoverable.
- Fresh tail is never stubbed.

### 6. Compaction And Maintenance Controls

Expose Beep-native controls equivalent to first-party `/lcm` commands:

- `GET /agent/lcm/status`
- `POST /agent/lcm/compact`
- `POST /agent/lcm/assemble-preview`
- `POST /agent/lcm/rotate`
- `POST /agent/lcm/maintain`
- `GET /agent/lcm/doctor`
- `POST /agent/lcm/backup`

Future UI can map these to buttons rather than command-line usage.

Acceptance:

- Forced compaction creates summaries.
- Rotate preserves active conversation identity and summaries while shrinking transcript storage.
- Doctor reports corrupted/truncated summaries.
- Status shows DB size, row counts, summary counts, deferred compaction debt, fresh tail config, and active conversation.

### 7. Session Policy

Implement the same session controls Lossless Claw expects:

- `ignoreSessionPatterns` for proofs, throwaway tests, and low-value maintenance sessions.
- `statelessSessionPatterns` for delegated runs that may read context but must not mutate memory.
- Heartbeat pruning for routine idle acknowledgements.
- Session reset and rotation semantics.

Acceptance:

- Smoke tests and idle heartbeat-only runs do not pollute durable memory.
- Delegated recall does not recursively write noisy LCM state.
- Real user work remains lossless.

### 8. Storage Budgets

LCM's first-party goal is not "small DB"; it is "bounded active context with recoverable raw history." Beep still needs operational budgets.

Policies:

- Raw Pi event logs: rotate and compress by size/time.
- LCM DB: keep canonical messages, summaries, and large-file references.
- Large files: cap per-user storage and add explicit deletion/export policy.
- Backups: bounded retention.
- SQLite: expose `VACUUM` or equivalent maintenance through explicit admin/control action.

Acceptance:

- Storage growth is predictable per user.
- Active context remains bounded even across long-running sessions.
- Raw diagnostics can be trimmed without losing LCM memory.

## Pi And Runtime Assessment

Pi is viable for the current harness choice:

- `--mode rpc` supports long-running subprocess control.
- It supports prompt acceptance, steering, follow-ups, aborts, session switching, model changes, compaction commands, and session stats.
- Its docs explicitly say durable harness recovery should be session-log based and that provider streams are not resumable.
- That matches Beep's intended daemon model.

Current runtime status:

- Docker service can build and start.
- `beep-agentd` is healthy from inside the container and outside the sandbox.
- Host sandboxed curl may fail because of the local execution sandbox, but escalated host curl succeeds.
- The Pi RPC session is running.
- `get_state` succeeds without a model call.
- The managed Pi extensions are loaded with `--no-extensions` plus explicit
  Beep extension paths, and Pi native auto-compaction is disabled when LCM
  context injection is active.

Current runtime gap:

- It works as a long-running Pi/Codex-auth daemon.
- It now imports Pi session messages through Lossless Claw's native
  `afterTurn` path.
- It injects assembled LCM context back into Pi before model calls through Pi's `context` extension hook.
- It exposes `lcm_grep` and `lcm_describe` through Pi as managed tools.
- It forwards Pi lifecycle hooks to LCM for before-reset and session-end
  semantics.
- It has not produced summary-backed live context yet because no live compaction
  has created summaries in the dev DB.

## Implementation Slices

### Slice A: Stop LCM Event Flood

- Keep raw Pi events in JSONL.
- Add a Pi session adapter.
- Keep raw proof/event logs as diagnostics and use canonical session-message ingestion for LCM writes.
- Add regression tests using saved Pi session logs.

Status: implemented for live daemon ingestion. The old raw-event importer has been removed; standalone proof summaries no longer mutate LCM.

### Slice B: Use Lossless Claw Stores Correctly

- Preserve structured message parts.
- Store tool calls/results with stable tool IDs.
- Store model usage and response IDs as metadata, not separate memory messages.
- Make ingestion idempotent.

Status: implemented for the current Pi session path. Clean-slate live proof imported 4 messages from a zero-row DB, then imported 0 on the replay pass.

### Slice C: First Forced Compaction

- Add a low-threshold test config.
- Force LCM compaction on a synthetic long transcript.
- Prove `summaries > 0`.
- Prove assembled context includes summaries plus fresh tail.

Status: proven against a temp DB using the real Pi session transcript. Forced compaction over 37 messages created 3 summaries and assembled a 4-message next-turn context projection.

### Slice D: Runtime LCM API

- Add status, compact, rotate, maintain, and doctor endpoints.
- Keep these private to the control plane.
- Return structured JSON suitable for future UI buttons.

Status: implemented through `LcmService` for `/agent/lcm/status`, `/agent/lcm/compact`, `/agent/lcm/assemble-preview`, `/agent/lcm/maintain`, `/agent/lcm/rotate`, `/agent/lcm/backup`, and `/agent/lcm/doctor`.

### Slice E: Pi Context Hook

- Decide whether to embed `AgentSession` directly or patch Pi provider/extension hooks.
- Feed LCM-assembled context into model calls.
- Disable or subordinate Pi-native compaction when LCM owns compaction.

Status: implemented through the Pi `context` extension hook for the long-running
runtime path. The remaining work is hardening and tests around summary-backed
context after live compaction.

### Slice F: Recall Tools

- Register `lcm_grep`, `lcm_describe`, and `lcm_expand_query` as main-agent Pi
  tools, and `lcm_expand` as a delegated expansion-only Pi tool.
- Add bounded expansion and an in-session concurrency guard.
- Prove the agent can recover an old detail through LCM recall.

Status: implemented for managed Pi recall. Main-agent `lcm_grep`,
`lcm_describe`, and `lcm_expand_query` execute through `POST /internal/lcm/tool`.
`lcm_expand_query` creates a bounded delegated Pi session with
`--no-builtin-tools`, a narrow LCM tool allowlist, and a runtime expansion grant;
`lcm_expand` is only registered in that delegated mode. The final live proof
created summary `sum_fd52c0d6d902ab75`, then verified one parent
`lcm_expand_query` call and one delegated `lcm_expand` call with no failures.

### Slice G: Storage And Lifecycle

- Add event-log rotation/compression.
- Add session ignore/stateless policy.
- Add heartbeat pruning.
- Add rotate/backup/doctor controls.
- Add DB and large-file budget reporting.

Status: partially implemented. Post-turn ingestion now goes through
`LcmContextEngine.afterTurn(...)`, private maintain/rotate/backup/doctor
endpoints exist, and Pi lifecycle hooks call LCM lifecycle handlers. Remaining
work is event-log retention, full ignore/stateless policy, heartbeat pruning,
and storage budget reporting.

## Next Concrete Step

Harden the first-party LCM implementation:

1. Harden always-on passive context injection with automated summary-backed tests.
2. Promote the live delegated `lcm_expand_query` proof into an automated
   regression.
3. Finish ignore/stateless write policy for delegated and low-value sessions.
4. Add event-log retention, heartbeat pruning, and storage budget reporting.
5. Keep `lcm_grep` and `lcm_describe` as direct exact-continuity tools.

The boundary proof should later assert this same LCM/tool shape, including the
already implemented recall path.

That locks the runtime-house/control-plane split into executable behavior before
more tools and auth surfaces are added.
