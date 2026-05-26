# Beep

Beep is an experimental agent runtime and control-plane slice. It separates
host authority, model credentials, approvals, and lifecycle management from the
sandboxed runtime that runs the agent loop.

The runtime currently centers on:

- a long-running `beep-agentd` daemon API
- a host-side control plane for lifecycle, approvals, and scoped tools
- LCM-backed runtime memory and recall tools
- environment-driven model and provider credentials
- Docker-based local development

## Credentials

Credentials are intentionally supplied through environment variables or local
state under `.beep-dev/`. Do not commit `.env` files, auth JSON, provider keys,
runtime tokens, or generated state.

Primary model credential path:

```bash
export BEEP_MODEL_GATEWAY_CREDENTIAL_URL="https://example.internal/model-credential"
export BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN="..."
```

Local development can opt into the temporary Codex auth compatibility path:

```bash
export BEEP_ALLOW_RUNTIME_CODEX_AUTH=1
```

That mode reads an existing `CODEX_HOME/auth.json` access token from local
state and is not the production credential-custody model.

Optional web providers are also configured by environment:

```bash
export BEEP_TAVILY_API_KEY="..."
export BEEP_EXA_API_KEY="..."
export BEEP_BRAVE_SEARCH_API_KEY="..."
export BEEP_FIRECRAWL_API_KEY="..."
export BEEP_LINKUP_API_KEY="..."
export BEEP_PERPLEXITY_API_KEY="..."
export BEEP_SERPAPI_API_KEY="..."
```

## Development

Clone with submodules:

```bash
git clone --recurse-submodules https://github.com/zof4/beep.git
cd beep
```

Start the runtime API:

```bash
./scripts/beep-agentd.sh
```

Start the host-side control plane:

```bash
./scripts/beep-control-plane.sh start
```

Useful checks:

```bash
./scripts/beep-runtime.sh capabilities
./scripts/beep-control-plane.sh status
./scripts/smoke-test-runtime.sh
```

See [runtime/README.md](runtime/README.md) and
[control-plane/README.md](control-plane/README.md) for the current runtime and
control-plane details.

## License

Apache-2.0. See [LICENSE](LICENSE).
