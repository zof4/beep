# Control Plane Reconciliation Design

## Goal

Restore the prior Beep control-plane work onto current `main` without
regressing the newly merged Hindsight + LCM sidecar behavior.

The result should be a real local control-plane slice that runs outside
`beep-agentd`, owns host authority, routes user requests to the existing runtime,
validates scoped runtime tool calls, records audit state, and provides the place
where gatekeeper and approval policy live.

This is a reconciliation project, not a greenfield control-plane design.

## Current Baseline

Current `main` at the start of this design is:

```text
576896f56 Merge Hindsight LCM sidecar evaluation
```

It contains a working runtime-house slice:

- `beep-agentd` owns the Pi RPC session, runtime queue, events, LCM service, and
  Hindsight + LCM coordination.
- The Pi context hook calls the runtime internal LCM route before model calls.
- Hindsight recall feeds LCM as ephemeral external memory hints.
- LCM remains the final context manager and canonical transcript store.
- Hindsight retain happens after successful LCM ingest.
- Static tests and smoke scripts prove the Hindsight + LCM ordering.

Current `main` does not contain the previously built `control-plane/` tree.

## Source Branches

Use these committed branches as source material:

```text
codex-control-plane-runtime-boundary
  head: a1eae65d52883c3277b623dbfcb9f0a14a16f0da
  role: control-plane service, runtime manager, tool broker, scoped runtime
        tokens, web tools, preview tools, approval fallback docs, runtime
        boundary refactor, and LCM recall tools.

gatekeeper-auto-review
  head: ef5ddcef4eca60252371a057660f273ecc3b31f7
  role: gatekeeper auto-review modules and tests for restricted tools.

codex-end-to-end-hindsight-gatekeeper
  head: a2095f6625835e835925c3b99411ace60e72dde1
  role: later integration branch with control-plane, gatekeeper, static preview
        approval, model credential routing, and smoke proof.
```

Prefer committed branch content over any uncommitted or temporary directory
unless the temporary source is explicitly inspected and copied through the same
audit criteria.

## Reconciliation Rule

Current `main` is the behavioral authority for Hindsight + LCM.

Prior branches are the implementation authority for the control-plane boundary
only where their code still fits the current runtime. Do not wholesale replace
runtime memory, LCM, Hindsight sidecar, or smoke-test behavior from current
`main` just because an older control-plane branch contains a different memory
implementation.

Each imported file must satisfy these checks:

- It keeps host authority outside the runtime container.
- It does not give Pi or `beep-agentd` raw Docker, secret, approval, or operator
  authority.
- It uses scoped capability tokens for runtime-to-control-plane calls.
- It preserves current Hindsight + LCM ordering.
- It has focused tests, or the reconciliation adds focused tests before the file
  is considered complete.
- It is smaller and safer to port than to rebuild.

## Target Architecture

### Control Plane

Create or restore a top-level `control-plane/` service that runs on the host.

It owns:

- runtime lifecycle commands for the local dev runtime;
- operator-only API endpoints;
- scoped runtime capability token validation;
- model credential brokering or the local-dev compatibility path;
- control-plane tool service;
- typed broker execution for host-authority operations;
- approval records;
- gatekeeper review;
- audit records;
- static preview site records.

The control plane must not own the agent loop, Beep personality, LCM transcript
ingestion, or Hindsight retain/recall internals.

### Runtime House

Keep `beep-agentd` as the runtime-local service.

It owns:

- Pi RPC process management;
- request queueing;
- runtime event/session state;
- LCM context assembly and post-turn transcript ingest;
- Hindsight recall/retain coordination through the current main path;
- sandbox-local tools and runtime-local stubs.

It may call the control plane through scoped tokens. It must not approve its own
restricted actions or execute host-authority broker operations directly.

### Runtime Tool Extension

Restore a Pi extension equivalent to
`runtime/pi-extensions/control-plane-tools-extension.mjs`.

It should register normal agent-visible tools whose host-authority work is
executed by:

```text
Pi tool call
  -> runtime extension
  -> POST /internal/tools/call on the control plane
  -> control-plane policy, audit, gatekeeper, broker
  -> sanitized tool result back to Pi
```

Initial tools should come from prior branch work only when they pass the audit:

- `preview_port_expose` as a default-allowed local preview proxy tool.
- `preview_container_create_static_site` as a restricted managed static preview
  action.
- Web search/fetch tools are optional for the first reconciliation if they make
  the first slice too broad; they can be restored as the next control-plane tool
  family.

### Gatekeeper

Gatekeeper belongs inside the control-plane trust boundary. It receives exact
tool intent input, trusted recent user context, broker evidence, and policy. It
returns strict normalized decisions.

The first review domain should remain managed static preview creation because
the prior branches already have policy, evidence collection, and tests for it.

Allowed public outcomes:

```text
allow
allow_for_session
deny
timeout
circuit_breaker
escalate_to_user
```

The agent-visible result must not expose hidden rationale, policy text, reviewer
prompt internals, operator tokens, or raw evidence beyond safe summaries.

## Data Flow

### User Request

```text
operator/user
  -> POST /api/requests on control plane
  -> control plane records request metadata
  -> control plane starts or verifies local runtime
  -> control plane forwards to beep-agentd /agent/submit
  -> runtime runs Pi, LCM, and Hindsight path
  -> control plane exposes request, event, summary, and audit status
```

The first request API can be operator-token-only. Multi-user auth is out of
scope for this reconciliation slice.

### Tool Intent

```text
Pi
  -> control-plane tool extension
  -> /internal/tools/call with runtime token
  -> control plane validates token and runtime ownership
  -> tool broker classifies action
  -> default-allowed action executes and audits
  -> restricted action goes to gatekeeper or durable approval
  -> broker result returns to runtime extension
```

Runtime tokens must not authorize operator endpoints such as approval
transitions, site stop operations, runtime lifecycle mutation, or audit export.

### Approval

Use the prior Mode A approval fallback first:

```text
restricted tool intent
  -> gatekeeper deny, allow, or escalation
  -> escalation creates durable pending approval
  -> agent receives needs_review + approvalId
  -> operator endpoint approves, denies, or cancels
```

Hold/wait approval resumption is out of scope until durable approval state,
operator auth, audit, and broker execution are proven on current `main`.

## Storage

Reuse the prior `StateStore` approach if it passes tests on current `main`:

- local state directory under `.beep-dev/control-plane`;
- separate token files for runtime tool token, runtime API token, model
  credential token, and operator token;
- JSON state with lock file for local dev;
- audit records capped for local state size.

Do not introduce Postgres or a migration framework in this reconciliation slice.
The goal is to recover the boundary and tests first.

## Error Handling

- Missing or invalid runtime token returns `401` and performs no broker action.
- Missing or invalid operator token returns `401` for operator endpoints.
- Unknown tool actions fail closed and append audit.
- Gatekeeper timeout fails closed to `timeout` or user escalation.
- Invalid reviewer output fails closed.
- Broker validation failures return sanitized denials and append audit.
- Runtime startup failure is reported through control-plane runtime status.
- Hindsight outage still degrades to LCM-only context through current runtime
  behavior; control-plane reconciliation must not make Hindsight mandatory for
  normal runtime operation.

## Testing

Minimum pure test coverage:

- control-plane state store creates distinct runtime, runtime API, model
  credential, and operator tokens;
- runtime token cannot call operator approval endpoints;
- operator token can list and transition approvals;
- default-allowed preview port exposure succeeds through the broker;
- restricted static preview with missing authorization creates
  `needs_review`;
- static preview with unsafe source, symlink, missing `index.html`, or
  secret-like files denies before execution;
- gatekeeper auto-review allows a bounded authorized static preview and denies
  explicit user refusal;
- control-plane request forwarding records request state and runtime failure
  state;
- current `main` Hindsight + LCM tests still pass.

Minimum live or smoke proof:

- start control plane;
- start or verify runtime API through the control plane;
- submit a simple request through `/api/requests`;
- call one default-allowed control-plane-backed tool;
- call one restricted static preview tool and prove gatekeeper/approval state;
- verify audit contains request, tool, approval/gatekeeper, and broker events;
- run current Hindsight + LCM smoke proof separately or as a prerequisite.

## Non-Goals

- Do not implement multi-user production auth.
- Do not replace current Hindsight sidecar integration with the older memory
  adapter branch.
- Do not vendor upstream Hindsight as part of this control-plane restoration.
  Current `main` already uses the pinned Hindsight image path.
- Do not port the full runtime route refactor unless it is necessary for the
  control-plane boundary.
- Do not make web search/fetch required for the first restored control-plane
  slice.
- Do not implement hold/wait approval resumption yet.
- Do not build the island UI in this slice.

## Implementation Strategy

1. Restore `control-plane/` from the prior branches in the smallest coherent
   piece: config, HTTP utilities, state store, runtime manager, tool manifest,
   tool broker, approval routes, site routes, static preview, gatekeeper, and
   tests.
2. Restore `scripts/beep-control-plane.sh` and any minimal shared environment
   helper needed to run the control plane against the current compose setup.
3. Restore the runtime control-plane tools extension and load it only when the
   control-plane URL and runtime token are configured.
4. Port token separation and model credential routing only if it can be done
   without destabilizing current local-dev Codex auth and Hindsight + LCM smoke
   tests.
5. Run pure control-plane tests and existing current-main tests after each
   narrow import group.
6. Add or update smoke scripts only after the pure boundary tests pass.

## Acceptance

The reconciliation is complete when:

- `control-plane/` exists on current `main` lineage with focused tests;
- `scripts/beep-control-plane.sh status` can report local control-plane and
  runtime status;
- operator endpoints require operator token;
- runtime tool calls require runtime token;
- the runtime token cannot approve or deny pending approvals;
- one default-allowed control-plane-backed tool works;
- one restricted static preview action reaches gatekeeper or durable approval;
- current Hindsight + LCM tests still pass;
- no imported branch code regresses the runtime-house/control-plane authority
  split documented here.
