# First Usable Backend Loop

This backend loop ties together the host control plane, managed trusted
host-loop runtime, per-session Docker sandboxes, Lossless Claw memory, and the
local Hindsight memory path. It is the first usable operator path for backend
work: operators enter through the control plane, while the managed runtime owns
the agent loop and memory work, and model-directed code execution happens in
throwaway sandbox containers.

## Authority Boundaries

- The control plane owns host authority: runtime lifecycle, operator auth,
  approvals and audit, model credential handoff, and the tool broker/proxy.
- The trusted host-loop runtime owns `beep-agentd`, the Pi loop, request queue
  and events, LCM context assembly and ingest, Hindsight sidecar coordination,
  and Docker sandbox lifecycle.
- The sandbox containers own model-directed shell and file work. They should
  not receive host credentials, Docker socket access, Hindsight mounts, LCM
  mounts, or control-plane tokens.

## Operator Workflow

Run the control plane from the host and use it as the normal backend API:

```bash
./scripts/beep-control-plane.sh start
./scripts/beep-control-plane.sh status
./scripts/beep-control-plane.sh logs
./scripts/beep-control-plane.sh stop
```

Get the host-only operator token before calling operator endpoints:

```bash
operator_token="$(./scripts/beep-control-plane.sh operator-token)"
runtime_id="${BEEP_CONTROL_PLANE_RUNTIME_ID:-local}"
```

Normal status and request flow:

```bash
curl http://127.0.0.1:8788/api/backend/status \
  -H "authorization: Bearer $operator_token"

curl -X POST http://127.0.0.1:8788/api/requests \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{"message":"Work in the current directory and report status."}'

curl http://127.0.0.1:8788/api/requests \
  -H "authorization: Bearer $operator_token"

curl http://127.0.0.1:8788/api/requests/<id> \
  -H "authorization: Bearer $operator_token"
```

Use the top-level `requestId` returned by `POST /api/requests` for
`GET /api/requests/<id>`, not the nested runtime request ID.

Runtime agent operations are normally reached through the control-plane proxy
under `/api/agent/...`:

```bash
curl http://127.0.0.1:8788/api/agent \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/agent/requests \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/agent/requests/<id> \
  -H "authorization: Bearer $operator_token"
curl "http://127.0.0.1:8788/api/agent/events?limit=20" \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/agent/context \
  -H "authorization: Bearer $operator_token"
```

LCM operations use the same proxy path:

```bash
curl http://127.0.0.1:8788/api/agent/lcm/status \
  -H "authorization: Bearer $operator_token"
curl -X POST http://127.0.0.1:8788/api/agent/lcm/compact \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{"force":true}'
curl -X POST http://127.0.0.1:8788/api/agent/lcm/maintain \
  -H "authorization: Bearer $operator_token"
curl -X POST http://127.0.0.1:8788/api/agent/lcm/backup \
  -H "authorization: Bearer $operator_token"
curl -X POST http://127.0.0.1:8788/api/agent/lcm/assemble-preview \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{"tokenBudget":2048}'
curl -X POST http://127.0.0.1:8788/api/agent/lcm/rotate \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/agent/lcm/doctor \
  -H "authorization: Bearer $operator_token"
```

Runtime lifecycle also stays behind the control plane:

```bash
curl -X POST "http://127.0.0.1:8788/api/runtimes/$runtime_id/stop" \
  -H "authorization: Bearer $operator_token"
curl -X POST "http://127.0.0.1:8788/api/runtimes/$runtime_id/start" \
  -H "authorization: Bearer $operator_token"
```

## Host-Loop Docker Sandbox

The default local-dev runtime service is `beep-host-loop`. It still runs in
Docker for local and Oracle parity, but it is the trusted orchestrator
container, not the untrusted execution sandbox. The service mounts the Docker
socket and creates one sandbox container per Beep session on demand. Sandbox
workspaces persist under `.beep-dev/workspace/sandboxes`, so a crashed sandbox
can be replaced without losing the session files.

`beep-host-loop` defaults Hindsight off through
`BEEP_HOST_LOOP_HINDSIGHT_ENABLED=0`. This keeps a broken or missing Hindsight
sidecar from making the agent loop unusable. Use
`BEEP_HOST_LOOP_HINDSIGHT_ENABLED=1` only when the local Hindsight/Codex auth
path is healthy and the memory sidecar is part of the test.

Local Docker bring-up:

```bash
git submodule update --init --depth 1 vendor/pi vendor/lossless-claw vendor/openai-codex
docker compose --env-file docker/hindsight-image.env \
  -f docker/compose.runtime-dev.yml \
  --profile api up --build -d beep-host-loop
```

Oracle can use the same shape first: a trusted `beep-host-loop` service with
durable `.beep-dev` volumes and dynamically spawned sandbox containers. The
next hardening step for Oracle is to put a Docker socket proxy in front of the
trusted service, or move the trusted supervisor to `systemd` if Docker-daemon
failure becomes the failure class being addressed.

## Memory Flow

- The Pi agent loop handles queued work.
- LCM assembles context before each model call and ingests the canonical
  transcript after each completed turn.
- Hindsight remains a local sidecar that feeds LCM ephemeral external-memory
  hints. It is not the canonical transcript store.
- The operator-only backend status and `/api/agent/context` endpoints expose
  sanitized LCM and Hindsight telemetry. `/api/agent/context` is the
  purpose-built operator route for memory/context observability, including
  `context.pressure`, latest injection and latest ingest telemetry,
  `lcm.available`, `hindsight.available`, `warnings`, and `webSearch`
  readiness. Neither endpoint should expose raw runtime transcripts, raw memory
  files, raw Hindsight memories, or LCM message bodies.

## Live Proof

`npm run test:first-usable-backend` is the pure/static and syntax check. It runs
Node tests plus shell syntax validation for the live smoke script.

`./scripts/smoke-test-first-usable-backend.sh` is the live Docker/control-plane
proof. It validates seed, restart, recall, and backend status through
control-plane routes, while exercising compact and proving memory through
request and status results. A runtime-proxy 502 from compact is tolerated by
the script.

`npm run test:host-loop` runs the host-loop static checks plus syntax
validation for the sandbox smoke script.

`./scripts/smoke-test-host-loop-sandbox.sh` is the live Docker sandbox proof.
It starts an isolated temporary control plane, synchronously starts the managed
`beep-host-loop` runtime, writes a proof file through the sandbox tool route,
kills the sandbox container, verifies backend status still responds, then reads
the proof file after the next tool call recreates the sandbox.

## Operational Notes

- Set `BEEP_RUNTIME_AUTO_UPDATE=0` to avoid dependency refresh during manual
  smoke or token checks when desired. The first usable backend smoke already
  exports it.
- `beep-host-loop` is host authority. Treat its Docker socket mount like host
  root-equivalent access. Sandboxes are the isolation boundary for
  model-directed code execution.
- Direct runtime API curls are compatibility/debug paths. Backend operators
  should use the control-plane routes first.
- Smoke output files are written under
  `${TMPDIR:-/tmp}/beep-first-usable-backend.*`.
- Host-loop sandbox smoke output files are written under
  `${TMPDIR:-/tmp}/beep-host-loop-sandbox-smoke.*`.
