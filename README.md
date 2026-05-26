# Beep

Beep is an experimental agent runtime and control-plane slice. It separates
host authority, model credentials, approvals, and lifecycle management from the
sandboxed runtime that runs the agent loop. The goal is to create a long running agent that can be scaled with implementation yet has the tools necessary for real work. 

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
