# First Usable Backend Loop

This backend loop ties together the host control plane, managed runtime,
long-running Pi agent loop, Lossless Claw memory, and the local Hindsight memory
path. It is the first usable operator path for backend work: operators enter
through the control plane, while the managed runtime does agent and memory work
inside the runtime house.

## Authority Boundaries

- The control plane owns host authority: runtime lifecycle, operator auth,
  approvals and audit, model credential handoff, and the tool broker/proxy.
- The runtime house owns `beep-agentd`, the Pi loop, request queue and events,
  LCM context assembly and ingest, and Hindsight sidecar coordination.
- The agent workspace remains less trusted and model-directed. It is where Pi
  can run shell and file work, but it should not hold host authority or durable
  credentials.

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
```

Runtime lifecycle also stays behind the control plane:

```bash
curl -X POST "http://127.0.0.1:8788/api/runtimes/$runtime_id/stop" \
  -H "authorization: Bearer $operator_token"
curl -X POST "http://127.0.0.1:8788/api/runtimes/$runtime_id/start" \
  -H "authorization: Bearer $operator_token"
```

## Memory Flow

- The Pi agent loop handles queued work.
- LCM assembles context before each model call and ingests the canonical
  transcript after each completed turn.
- Hindsight remains a local sidecar that feeds LCM ephemeral external-memory
  hints. It is not the canonical transcript store.
- Backend status exposes sanitized LCM and Hindsight telemetry. It should not
  expose raw memory files or raw conversation text.

## Live Proof

`npm run test:first-usable-backend` is the pure/static and syntax check. It runs
Node tests plus shell syntax validation for the live smoke script.

`./scripts/smoke-test-first-usable-backend.sh` is the live Docker/control-plane
proof. It validates seed, compact, restart, recall, and backend status through
control-plane routes.

## Operational Notes

- Set `BEEP_RUNTIME_AUTO_UPDATE=0` to avoid dependency refresh during manual
  smoke or token checks when desired. The first usable backend smoke already
  exports it.
- Direct runtime API curls are compatibility/debug paths. Backend operators
  should use the control-plane routes first.
- Smoke output files are written under
  `${TMPDIR:-/tmp}/beep-first-usable-backend.*`.
