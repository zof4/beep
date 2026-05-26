# Codex Endpoint And Protocol Map

This note records the source-level contract Beep should mirror while we build a no-API-key Pi runtime path. The source of truth is the vendored OpenAI Codex checkout at:

```text
vendor/openai-codex
commit: 3fd79b7986b8019acb35a8e3a28ae32b67ca31ac
date:   2026-05-18 17:28:50 -0700
title:  app-server: use profile ids in v2 permission params (#23360)
```

The practical conclusion: Beep should not use `/v1/chat/completions` as the primary agent endpoint. Current Codex uses the Responses API and its app-server JSON-RPC surface. For Pi, we should keep Pi's harness loop, but replace or wrap its current OpenAI Codex provider with a Beep model gateway that follows Codex's current auth, model, usage, and approval contracts.

## No-API-Key Auth Path

Codex supports API-key auth, but this slice assumes we do not have an API key. The path we need is ChatGPT managed auth.

Codex source:

- `vendor/openai-codex/codex-rs/login/src/server.rs`
- `vendor/openai-codex/codex-rs/login/src/device_code_auth.rs`
- `vendor/openai-codex/codex-rs/login/src/auth/manager.rs`
- `vendor/openai-codex/codex-rs/model-provider/src/auth.rs`
- `vendor/openai-codex/codex-rs/model-provider/src/bearer_auth_provider.rs`

Browser OAuth:

```text
issuer:          https://auth.openai.com
authorize:       GET /oauth/authorize
token:           POST /oauth/token
client_id:       app_EMoamEEZ73f0CkXaXp7hrann
callback:        http://localhost:1455/auth/callback
fallback port:   1457
pkce:            S256
scope:           openid profile email offline_access api.connectors.read api.connectors.invoke
extra params:    id_token_add_organizations=true
                 codex_cli_simplified_flow=true
                 originator=<client originator>
```

Device-code auth:

```text
request code:    POST https://auth.openai.com/api/accounts/deviceauth/usercode
verify URL:      https://auth.openai.com/codex/device
poll token:      POST https://auth.openai.com/api/accounts/deviceauth/token
timeout:         15 minutes
completion:      exchange returned authorization_code through /oauth/token
```

QR login can be built on the device-code flow by encoding the verification URL and showing the user code beside it. Do not assume the code can be embedded into the URL until verified against the live endpoint.

Refresh:

```text
refresh:         POST https://auth.openai.com/oauth/token
grant_type:      refresh_token
client_id:       app_EMoamEEZ73f0CkXaXp7hrann
```

Token exchange:

```text
token:           POST https://auth.openai.com/oauth/token
grant_type:      urn:ietf:params:oauth:grant-type:token-exchange
requested_token: openai-api-key
subject_token:   <id_token>
subject_type:    urn:ietf:params:oauth:token-type:id_token
```

Codex persists both OAuth token data and, when available, the exchanged API-key-style token. Runtime requests attach:

```text
Authorization: Bearer <current token>
ChatGPT-Account-ID: <workspace/account id when present>
X-OpenAI-Fedramp: true when account claim requires it
```

Beep production rule: durable ChatGPT refresh tokens stay in a control-plane token vault or model gateway, not inside the editable runtime workspace. The runtime gets a narrow model-gateway capability, not raw refresh credentials. The runtime adapter now expects `BEEP_MODEL_GATEWAY_CREDENTIAL_URL` for that path; `BEEP_ALLOW_RUNTIME_CODEX_AUTH=1` is local-dev compatibility only and does not refresh tokens.

## Model And Completion Calls

Codex model provider shape:

- Base provider URL normally points at an OpenAI-compatible `/v1` base.
- Endpoint paths are relative to that base.
- `wire_api = responses`.

Endpoints used by Codex source:

```text
GET  /v1/models?client_version=<version>
POST /v1/responses
POST /v1/responses/compact
```

Official current OpenAI API surface to support in Beep's model gateway:

```text
GET  /v1/models
GET  /v1/models/{model}
POST /v1/responses
GET  /v1/responses/{response_id}
POST /v1/responses/{response_id}/cancel
GET  /v1/responses/{response_id}/input_items
POST /v1/responses/compact
POST /v1/responses/input_tokens
```

Codex request controls to preserve:

```text
model
input
instructions
tools
tool_choice
parallel_tool_calls
reasoning.effort
reasoning.summary
text.verbosity
service_tier
prompt_cache_key
previous_response_id
include: reasoning.encrypted_content when supported
store
stream
```

Pi already has a provider at:

```text
vendor/pi/packages/ai/src/providers/openai-codex-responses.ts
```

That provider currently targets:

```text
default base: https://chatgpt.com/backend-api
path:         /codex/responses
transport:    WebSocket first, SSE fallback
headers:      Authorization, chatgpt-account-id, originator, session_id, x-client-request-id
```

Pi also has an OAuth helper at:

```text
vendor/pi/packages/ai/src/utils/oauth/openai-codex.ts
```

But Codex's current implementation is more complete than Pi's helper. The first adapter should reconcile Pi with Codex by adding:

- device-code auth support;
- workspace restriction handling;
- token exchange handling where required;
- refresh-token rotation semantics;
- account ID, plan, and rate-limit propagation;
- current model and reasoning-effort catalog handling;
- usage and response ID persistence for LCM.

## App-Server JSON-RPC Surface

Codex app-server is not the model endpoint. It is the local process protocol clients use to drive Codex. Beep does not need to expose this exact protocol externally, but it should mirror the lifecycle shape.

Source:

```text
vendor/openai-codex/codex-rs/app-server/README.md
vendor/openai-codex/codex-rs/app-server-protocol/src/protocol/common.rs
vendor/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2
```

Thread and turn lifecycle:

```text
initialize
thread/start
thread/resume
thread/fork
thread/list
thread/read
thread/turns/list
thread/compact/start
thread/rollback
turn/start
turn/steer
turn/interrupt
review/start
```

Important notifications:

```text
thread/started
thread/status/changed
thread/tokenUsage/updated
turn/started
turn/completed
turn/diff/updated
turn/plan/updated
item/started
item/completed
item/agentMessage/delta
item/reasoning/summaryTextDelta
item/reasoning/summaryPartAdded
item/reasoning/textDelta
item/commandExecution/outputDelta
item/fileChange/outputDelta
item/fileChange/patchUpdated
item/autoApprovalReview/started
item/autoApprovalReview/completed
serverRequest/resolved
account/updated
account/rateLimits/updated
account/login/completed
model/rerouted
model/verification
warning
```

Beep equivalent: `Run`, `Turn`, `Item`, `ToolCallRequest`, `ApprovalRequest`, `ApprovalDecision`, `UsageSnapshot`, and `LcmRecord` events.

## Account, Usage, And Rate Limits

Codex account methods:

```text
account/read
account/login/start
account/login/cancel
account/logout
account/rateLimits/read
account/sendAddCreditsNudgeEmail
```

Login modes:

```text
apiKey
chatgpt
chatgptDeviceCode
chatgptAuthTokens
```

Usage structures:

```text
thread/tokenUsage/updated:
  threadId
  turnId
  tokenUsage:
    total:
      totalTokens
      inputTokens
      cachedInputTokens
      outputTokens
      reasoningOutputTokens
    last:
      totalTokens
      inputTokens
      cachedInputTokens
      outputTokens
      reasoningOutputTokens
    modelContextWindow
```

Rate-limit structures:

```text
account/rateLimits/read:
  rateLimits:
    limitId
    limitName
    primary:
      usedPercent
      windowDurationMins
      resetsAt
    secondary
    credits
    planType
    rateLimitReachedType
```

Beep rule: LCM records raw usage events, while the control plane stores aggregate usage and rate-limit snapshots for UI and policy.

## Commands

Codex commands exist at two levels.

App-server JSON-RPC commands:

```text
thread/shellCommand
command/exec
command/exec/write
command/exec/resize
command/exec/terminate
```

Slash commands in the CLI are UI commands, not model endpoints. Official current CLI docs list commands including:

```text
/permissions
/ide
/keymap
/vim
/sandbox-add-read-dir
/agent
/apps
/plugins
/hooks
/clear
/compact
/copy
/diff
/exit
/experimental
/approve
/memories
/skills
/feedback
/init
/logout
/mcp
/mention
/model
/fast
/plan
/goal
/personality
/ps
/stop
/fork
/side
/raw
/resume
/new
/quit
/review
/status
/debug-config
/statusline
/title
/theme
```

Beep should not blindly copy CLI slash commands. The first runtime should expose typed runtime commands that map to our concepts:

```text
runtime.status
runtime.compact
runtime.resume
runtime.stop
runtime.model.set
runtime.reasoning.set
runtime.permissions.set
runtime.approval.retry
runtime.memory.mode
runtime.lcm.status
```

## Approval Model

Codex approval flow:

```text
approvalPolicy:
  untrusted
  on-failure
  on-request
  granular
  never

approvalsReviewer:
  user
  auto_review
  guardian_subagent
```

Approval request methods:

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
mcpServer/elicitation/request
```

Approval decisions include command accept, accept-for-session, policy amendment, network amendment, decline, and cancel. Auto-review emits started/completed notifications and assigns risk and authorization.

Beep mapping:

```ts
type GatekeeperDecision =
  | { outcome: "allow"; scope: "once" | "session" | "grant"; agentMessage: string }
  | { outcome: "deny"; reasonCategory: string; agentMessage: string }
  | { outcome: "escalate_to_user"; prompt: string; requestedCapability: string };
```

The gatekeeper is non-conversational, but it is not invisible. It should run
from the control-plane trust boundary with the external tool service, not inside
`beep-agentd`. The agent calls registered tools normally; the tool service
executes default-allowed calls immediately and returns allow, deny,
`needs_review`, or escalate results for restricted calls.

## LCM Implications

LCM records the entire autonomous run, not just a final answer. For every run it must record:

- user request;
- model request metadata;
- model output items;
- response IDs and continuation IDs;
- tool calls;
- tool results;
- approval requests;
- gatekeeper decisions;
- user escalation results;
- usage snapshots;
- compaction events;
- final answer;
- failure or blocked state.

Lossless Claw source is vendored at:

```text
vendor/lossless-claw
commit: d42c124a28657c3bacbec34d03128aba1b7638fe
version: 0.11.1
```

It persists every message to SQLite, builds DAG summaries, and exposes recall tools such as `lcm_grep`, `lcm_describe`, and `lcm_expand`. Beep should wrap it behind `LcmAdapter` instead of depending on OpenClaw plugin APIs directly.

## Sources

- OpenAI Codex GitHub: https://github.com/openai/codex
- Codex slash command docs: https://developers.openai.com/codex/cli/slash-commands
- Pi GitHub: https://github.com/earendil-works/pi
- Lossless Claw GitHub: https://github.com/martian-engineering/lossless-claw
