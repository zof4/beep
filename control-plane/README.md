# Beep Control Plane

The control plane is the host-side authority boundary for the local Beep stack.
It owns runtime lifecycle, scoped model credentials, scoped tool execution, preview
port exposure, approvals, operator actions, and audit records. The runtime house
owns the agent loop and runtime-local services, but it does not own durable
ChatGPT credentials, Docker control, approval policy, or future gatekeeper
policy. The agent workspace is a third, less-trusted area inside the runtime for
model-directed shell and file work.

This README is the local reference for the split between the control plane,
runtime house, and agent workspace.

Run it in the foreground from the host:

```bash
./scripts/beep-control-plane.sh foreground
```

Or run it as a local background process:

```bash
./scripts/beep-control-plane.sh start
./scripts/beep-control-plane.sh status
./scripts/beep-control-plane.sh logs
./scripts/beep-control-plane.sh stop
```

For the first usable backend operator workflow, see
[`docs/first-usable-backend-loop.md`](../docs/first-usable-backend-loop.md).
The short version is: run the stack through the control-plane helper, get an
operator token, check `GET /api/backend/status`, submit work with
`POST /api/requests`, read it back with `GET /api/requests` or
`GET /api/requests/<id>`, and operate runtime memory through proxied routes such
as `GET /api/agent/lcm/status` and `POST /api/agent/lcm/compact`.

By default `foreground` and `start` run the optional runtime dependency refresh
helper when it exists and reports stale dependencies, start the control plane on
`http://127.0.0.1:8788`, and autostart the runtime API container with
control-plane-managed env:

```text
BEEP_ALLOW_RUNTIME_CODEX_AUTH=0
BEEP_RUNTIME_API_TOKEN=<control-plane runtime API token>
BEEP_MODEL_GATEWAY_CREDENTIAL_URL=http://host.docker.internal:8788/internal/model/credential
BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN=<control-plane model credential token>
BEEP_CONTROL_PLANE_URL=http://host.docker.internal:8788
BEEP_CONTROL_PLANE_RUNTIME_TOKEN=<control-plane tool token>
```

Useful local endpoints:

```bash
operator_token="$(./scripts/beep-control-plane.sh operator-token)"
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/api/runtimes/${BEEP_CONTROL_PLANE_RUNTIME_ID:-local} \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/tools
```

Lifecycle mutation, approval, site, and audit endpoints require the host-only
operator token:

```bash
operator_token="$(./scripts/beep-control-plane.sh operator-token)"
curl -X POST http://127.0.0.1:8788/api/requests \
  -H "authorization: Bearer $operator_token" \
  -H 'content-type: application/json' \
  -d '{"message":"Start a web server on 0.0.0.0:3000, then expose it with preview_port_expose."}'
curl -X POST http://127.0.0.1:8788/api/runtimes/${BEEP_CONTROL_PLANE_RUNTIME_ID:-local}/start \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/approvals \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/sites \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/audit \
  -H "authorization: Bearer $operator_token"
curl -X POST http://127.0.0.1:8788/api/sites/<siteId>/stop \
  -H "authorization: Bearer $operator_token"
```

The first real scoped tool is `preview_port_expose`. Control-plane tool
exposure defaults off; set `BEEP_CONTROL_PLANE_TOOLS_ENABLED=1` when starting
the stack if Pi should see it as a normal custom tool. The runtime extension
calls `POST /internal/tools/call` with its runtime capability token. The control
plane validates the token, checks the default allowed scope list, records audit,
and returns a preview URL.

This is the intended tool pattern: the agent can call a normal registered tool,
but any host-authority part of that tool executes through the control-plane
tool service and typed broker. The runtime token can request scoped execution; it
cannot approve restricted work or call operator endpoints.

Preview ports are intentionally narrow:

```text
runtime container ports: 3000-3099
host mapped ports:       13000-13099
control-plane proxy:     http://127.0.0.1:8788/preview/local/<port>/
```

The dev server inside the runtime must listen on `0.0.0.0`, not only
`localhost`, so Docker's port mapping can reach it.

Gatekeeper is implemented as deterministic local auto-review for the first
restricted action. Unknown tools deny, default-allowed tools run, and
review-required tools either auto-approve, deny, or return `needs_review` with a
sanitized agent-visible message and durable approval ID.

The first restricted managed-container action is
`preview.container.createStaticSite`, exposed to Pi as
`preview_container_create_static_site`. It creates a pending approval instead of
giving the runtime Docker authority. On approval, the control plane starts a
managed static-site container from a control-plane-selected image, mounts only
the requested workspace directory read-only, assigns a host port, labels the
container, records audit, and returns URLs. Managed preview containers are
stopped through `POST /api/sites/<siteId>/stop`; the runtime cannot stop or
remove containers directly.

Managed static previews can be updated in place through
`preview.container.updateStaticSite`, exposed to Pi as
`preview_container_update_static_site`. The update action is also restricted:
the runtime can request it, but the control plane revalidates the source path,
builds a fresh read-only snapshot, starts a replacement container, swaps the site
record, and keeps the existing `/sites/<siteId>/` proxy URL stable. The direct
Docker-mapped localhost URL may change after each update.

Operators can exercise the same path with:

```bash
curl -sS -X POST "$CONTROL_PLANE_URL/api/sites/<siteId>/update" \
  -H "authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"sourcePath":"/workspace/api-sessions/agent_beep/site"}'
```

The pure reconciliation smoke for this local slice lives at
`scripts/smoke-test-control-plane-reconciliation.sh`.

The first usable backend smoke lives at
`scripts/smoke-test-first-usable-backend.sh`; it exercises the backend status,
request, runtime restart, and LCM control routes through the control plane.
