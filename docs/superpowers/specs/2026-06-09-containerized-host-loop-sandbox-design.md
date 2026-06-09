# Containerized Host Loop Sandbox Design

## Goal

Move Beep from a runtime-container-owned agent loop to a host-loop shape while
keeping the first slice local-dev friendly and deployable on an Oracle host.

The host loop may itself run in Docker. The reliability boundary is not
"process is outside every container"; it is "agent loop is outside the
untrusted code-execution sandbox." If a sandbox container crashes, the trusted
agent loop must still answer, report the failure, preserve queue and memory
state, and restart or replace the sandbox.

## Current Setup

The `codex/first-usable-backend-loop` worktree currently has these boundaries:

- `control-plane/` runs on the host on `127.0.0.1:8788`.
- The control plane owns operator tokens, runtime lifecycle, model credential
  handoff, approval and audit state, and privileged tool brokering.
- `beep-agentd` runs inside the Docker runtime container on `127.0.0.1:8787`.
- `beep-agentd` owns the durable request queue, `AgentSupervisor`,
  `PiRpcSession`, LCM context injection, LCM transcript ingest, and Hindsight
  retain/recall coordination.
- The runtime container also exposes the direct `/agent`, `/sessions`, and LCM
  routes that the control plane proxies.
- The Hindsight sidecar runs as a separate Docker Compose service.

That means a runtime container crash still takes down the agent loop. The
control plane can report and restart the runtime, but Beep cannot keep a live
agent conversation outside the failed container.

A nearby branch already contains useful sandbox portal material:

- a same-name Pi tool portal for `bash`, `read`, `write`, `edit`, `ls`, `grep`,
  and `find`;
- a sandbox tool protocol;
- a Docker-side route for executing those tools in a workspace.

The host-loop design should reuse that tool shape, but place the portal manager
on the trusted side and execute each tool inside an isolated sandbox container.

## Design Decision

Build a containerized trusted host loop first:

- `beep-control-plane` and the host-loop agent can run as Docker services for
  local dev and Oracle parity.
- The trusted host-loop service gets Docker authority through the Docker socket
  or a narrow Docker API proxy.
- The model loop, request queue, LCM adapter, Hindsight coordinator, operator
  API, and sandbox manager live in the trusted service boundary.
- Code execution and file mutation happen only in per-session sandbox
  containers.

This keeps local and Oracle deployment nearly identical while still delivering
the failure isolation from the screenshot: sandbox failure does not kill the
agent loop.

Running the trusted loop directly under `systemd` on Oracle remains a later
hardening option. It addresses a different failure class: Docker daemon or
Compose failure taking down trusted services. The first design does not solve
that class.

## Target Services

### Trusted Control Plane

The control plane remains the operator-facing authority service.

Responsibilities:

- operator authentication;
- runtime and sandbox lifecycle API;
- request records and audit;
- approval state and gatekeeper review;
- model credential brokerage;
- privileged external tool brokering;
- public status and observability routes.

It may either embed the host-loop agent in the same Node process for the first
slice or run beside it as a second trusted service. The implementation should
choose the smaller step, but the internal boundary should be explicit.

### Trusted Host Agent

The host agent replaces runtime-local `beep-agentd` as the owner of the Beep
loop.

Responsibilities:

- durable request queue;
- `AgentSupervisor` equivalent;
- Pi RPC process supervision;
- LCM pre-model context assembly;
- post-turn LCM transcript ingest;
- Hindsight recall before context assembly and retain after LCM ingest;
- sandbox lease selection and recovery;
- safe same-name tool portal exposed to Pi.

The host agent must not run model-directed shell commands on its own filesystem.
Its Pi tool extension should register sandbox-backed tools that call the
sandbox manager.

### Sandbox Manager

The sandbox manager lives in the trusted boundary and owns Docker sandbox
containers.

Responsibilities:

- create, inspect, restart, and destroy sandbox containers;
- map a Beep session to a current sandbox lease;
- execute sandbox tool requests inside the correct container;
- enforce workspace path containment;
- cap output, runtime, CPU, memory, PIDs, and disk use;
- emit sandbox lifecycle telemetry;
- rotate a failed sandbox by creating a new generation for the same session.

For local dev, this can use `docker` CLI subprocesses because it matches the
existing control-plane runtime manager. The interface should hide that choice so
Oracle can switch to the Docker Engine API or a socket proxy without changing
the agent loop.

### Untrusted Sandbox Container

Each active Beep session gets a sandbox container.

Responsibilities:

- run shell commands and filesystem tools;
- hold the mutable workspace;
- run dev servers on allowed preview ports;
- contain model-directed code execution.

It must not receive:

- model credentials;
- operator tokens;
- runtime/control-plane capability tokens;
- Docker socket access;
- LCM database mounts;
- Hindsight data mounts;
- host state volumes outside the session workspace.

## Data Flow

### Request Flow

```text
operator
  -> POST /api/requests on control plane
  -> trusted host agent queue
  -> Pi RPC loop in trusted host-agent container
  -> Pi sandbox tool call
  -> sandbox manager
  -> docker exec in session sandbox
  -> tool result back to Pi
  -> LCM ingest and Hindsight retain in trusted host agent
  -> request/status result exposed by control plane
```

### Context Flow

```text
Pi context hook
  -> host-agent internal LCM context assembler
  -> Hindsight recall as ephemeral hints
  -> LCM assemble messages
  -> model call
  -> completed turn
  -> LCM canonical transcript ingest
  -> Hindsight retain after successful LCM ingest
```

The current runtime-local LCM route can become an in-process host-agent adapter
or an internal localhost route inside the trusted service. It should no longer
depend on the sandbox being alive.

### Sandbox Tool Flow

```text
Pi tool: bash/read/write/edit/ls/grep/find
  -> host-agent sandbox portal extension
  -> sandbox manager executeTool(sessionId, request)
  -> ensure sandbox lease exists
  -> docker exec / sandbox RPC
  -> normalized sandbox-tool result
  -> Pi tool result
```

Tool names should remain same-name to minimize prompt and Pi integration churn.

## Sandbox Lifecycle

Each sandbox lease has:

- `sessionId`;
- `generation`;
- `containerId`;
- `workspaceVolume` or bind-mounted workspace path;
- `status`;
- `createdAt`;
- `lastHealthyAt`;
- `lastError`;
- resource limits;
- network policy.

The first local-dev policy:

- create one sandbox per canonical Beep session;
- mount only that session workspace read-write;
- run as non-root;
- set `read_only: true` with writable workspace and tmpfs `/tmp`;
- apply `no-new-privileges`;
- drop Linux capabilities where Docker supports it;
- set memory, CPU, and PID limits;
- disable network by default unless a later tool explicitly grants it;
- expose only configured preview ports through the control plane.

If the sandbox is missing or unhealthy, the sandbox manager creates a new
generation. The host agent records the generation change in request telemetry
and can continue if the workspace remains available.

## Oracle Deployment Shape

The first Oracle-compatible deployment can remain Docker Compose based:

```text
/srv/beep/
  state/
  lcm/
  hindsight/
  workspaces/
  control-plane/
```

Compose services:

- `beep-control-plane` or `beep-host-loop`;
- `hindsight`;
- optional observability services;
- per-session sandboxes created dynamically by the trusted host-loop service,
  not predeclared in Compose.

The trusted host-loop service needs Docker authority. The safest first version
is a Docker socket proxy that only allows container lifecycle and exec operations
for containers with Beep-owned labels. If that proxy is not available, mounting
`/var/run/docker.sock` is acceptable for local dev and early Oracle bring-up,
but it must be treated as full host authority.

## Failure Handling

Sandbox crash:

- mark current lease failed;
- keep the agent loop and request queue alive;
- report the failed tool call with container diagnostics;
- create a new sandbox generation on the next tool call or explicit restart;
- preserve workspace if the workspace is a host volume.

Sandbox hang:

- enforce per-tool timeout;
- terminate the exec process;
- optionally recycle the sandbox after timeout.

Trusted host-loop crash:

- control plane or Compose restarts the service;
- queue state, LCM database, Hindsight state, and workspaces are on durable
  volumes;
- on boot, running requests are marked interrupted and can be resumed or
  requeued.

Docker daemon crash:

- out of scope for the first slice;
- status should report that sandbox operations are unavailable;
- later Oracle hardening can move the trusted supervisor to `systemd`.

## Security Boundaries

The sandbox is untrusted. It may contain attacker-controlled code.

The trusted host-loop container is trusted host authority. It must:

- never expose Docker authority to the model;
- never pass credentials into sandbox environment variables;
- validate all sandbox paths against the session workspace;
- label and filter all managed containers;
- fail closed on unknown sandbox IDs, tool names, or path escapes;
- cap outputs returned to the model;
- log lifecycle and tool execution metadata without leaking secrets.

Network access is a policy decision. The first slice should default to no
sandbox network and route future network needs through control-plane tools with
approval and audit.

## Implementation Units

1. Extract host-loop modules from `runtime/src/beep-runtime-api.mjs`:
   `PiRpcSession`, `AgentSupervisor`, and LCM/Hindsight adapters should become
   trusted host modules instead of runtime-container-only code.
2. Add a sandbox manager interface:
   `ensureSandbox(sessionId)`, `executeTool(sessionId, request)`,
   `restartSandbox(sessionId)`, `stopSandbox(sessionId)`, `status(sessionId)`.
3. Adapt the sandbox portal branch:
   reuse the same tool protocol and Pi extension shape, but route to the host
   sandbox manager instead of a runtime-local `/internal/sandbox/tools/call`.
4. Add a sandbox image:
   a minimal code-execution image with bash, git, ripgrep, Node, and project
   dependencies needed for Beep's first workflows.
5. Update the control plane:
   route `/api/requests` to the host agent, add sandbox status endpoints, and
   keep compatibility proxies for the old runtime only during migration.
6. Update Compose:
   add trusted host-loop service and persistent volumes; make dynamic sandboxes
   Docker-managed children rather than Compose services.
7. Add smoke proof:
   submit a request, execute a file write in sandbox, kill the sandbox, verify
   the agent loop still responds, restart sandbox, and complete another tool
   call.

## Testing

Pure tests:

- sandbox manager validates labels, paths, supported tools, and resource config;
- sandbox tool protocol rejects unknown tools and path escapes;
- host agent marks running requests interrupted after trusted loop restart;
- sandbox crash does not mark the host agent unavailable;
- credentials are not present in sandbox exec environment;
- control-plane status reports host-loop, sandbox, LCM, and Hindsight health
  separately.

Live smoke:

- start Compose trusted stack;
- submit a request through control plane;
- prove `bash`/`write`/`read` execute in the sandbox workspace;
- stop or kill the sandbox container;
- prove `/api/backend/status` and `/api/agent/context` still answer;
- create a new sandbox generation;
- complete a second request with LCM ingest and Hindsight retain still ordered.

## Non-Goals

- Production multi-tenant scheduler.
- Kubernetes or Nomad deployment.
- Solving Docker daemon failure for the trusted loop.
- Broad external web/email/calendar tools.
- Moving LCM or Hindsight into the untrusted sandbox.
- Allowing model-directed Docker control.

## Open Implementation Choices

The implementation plan should decide:

- whether the first host agent is embedded in `control-plane/src/server.mjs` or
  a sibling trusted service;
- whether local dev uses Docker CLI or a Docker API library behind the sandbox
  manager interface;
- whether the first sandbox workspace is a host bind mount or a named Docker
  volume;
- whether to preserve the old runtime API as a compatibility service during the
  first migration or replace it outright.
