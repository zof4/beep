# Beep Control Plane

The control plane is the host-side authority boundary for the local Beep stack.
It owns runtime lifecycle, scoped model credentials, scoped tool execution, preview
port exposure, approvals, operator actions, and audit records. The runtime house
owns the agent loop and runtime-local services, but it does not own durable
ChatGPT credentials, Docker control, approval policy, or future gatekeeper
policy. The agent workspace is a third, less-trusted area inside the runtime for
model-directed shell and file work.

See [Agent Runtime Boundaries](../docs/agent-runtime-boundaries.md) for the
canonical split between the control plane, runtime house, and agent workspace.

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

By default `foreground` and `start` refresh vendored runtime dependencies when
stale, start the control plane on `http://127.0.0.1:8788`, and autostart the
runtime API container with control-plane-managed env:

```text
BEEP_ALLOW_RUNTIME_CODEX_AUTH=0
BEEP_MODEL_GATEWAY_CREDENTIAL_URL=http://host.docker.internal:8788/internal/model/credential
BEEP_CONTROL_PLANE_URL=http://host.docker.internal:8788
```

Useful local endpoints:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/api/runtimes/local
curl -X POST http://127.0.0.1:8788/api/requests \
  -H 'content-type: application/json' \
  -d '{"message":"Start a web server on 0.0.0.0:3000, then expose it with preview_port_expose."}'
curl http://127.0.0.1:8788/api/tools
curl http://127.0.0.1:8788/api/audit
```

Lifecycle mutation and approval endpoints require the host-only operator token:

```bash
operator_token="$(./scripts/beep-control-plane.sh operator-token)"
curl -X POST http://127.0.0.1:8788/api/runtimes/local/start \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/approvals \
  -H "authorization: Bearer $operator_token"
curl http://127.0.0.1:8788/api/sites \
  -H "authorization: Bearer $operator_token"
curl -X POST http://127.0.0.1:8788/api/sites/<siteId>/stop \
  -H "authorization: Bearer $operator_token"
```

The first real scoped tool is `preview_port_expose`. Pi sees it as a normal
custom tool. The runtime extension calls `POST /internal/tools/call` with its
runtime capability token. The control plane validates the token, checks the
default allowed scope list, records audit, and returns a preview URL.

This is the intended tool pattern: the agent can call a normal registered tool,
but any host-authority part of that tool executes through the control-plane
tool service and typed broker. The runtime token can request scoped execution; it
cannot approve restricted work or call operator endpoints.

The first web tool surface follows the same pattern. Pi sees `web_search` and
`web_fetch` as normal tools, but provider credentials and external web authority
stay in the control plane. Defaults are selected with:

```text
BEEP_WEB_SEARCH_PROVIDER=tavily
BEEP_WEB_FETCH_PROVIDER=tavily
```

`BEEP_WEB_TOOL_PROVIDER=tavily` can set both defaults for a simple
single-provider deployment.

Supported provider keys:

```text
BEEP_TAVILY_API_KEY
BEEP_EXA_API_KEY
BEEP_BRAVE_SEARCH_API_KEY
BEEP_FIRECRAWL_API_KEY
BEEP_LINKUP_API_KEY
BEEP_PERPLEXITY_API_KEY
BEEP_SERPAPI_API_KEY
```

Provider adapters live under `control-plane/src/web-providers/` and normalize
provider responses into one `web_search` / `web_fetch` contract. See
[Web Tool Surface](../docs/web-tool-surface.md).

To compare providers with real requests, configure keys and run:

```bash
node scripts/benchmark-web-tools.mjs --providers tavily,exa,brave
```

Preview ports are intentionally narrow:

```text
runtime container ports: 3000-3099
host mapped ports:       13000-13099
control-plane proxy:     http://127.0.0.1:8788/preview/local/<port>/
```

The dev server inside the runtime must listen on `0.0.0.0`, not only
`localhost`, so Docker's port mapping can reach it.

Gatekeeper is not implemented in this slice. The tool service already has the
shape needed for it: unknown tools deny, default-allowed tools run, and
review-required tools return `needs_review` until a gatekeeper is attached.

The first restricted managed-container action is
`preview.container.createStaticSite`, exposed to Pi as
`preview_container_create_static_site`. It creates a pending approval instead of
giving the runtime Docker authority. On approval, the control plane starts a
managed static-site container from a control-plane-selected image, mounts only
the requested workspace directory read-only, assigns a host port, labels the
container, records audit, and returns URLs. Managed preview containers are
stopped through `POST /api/sites/<siteId>/stop`; the runtime cannot stop or
remove containers directly.
