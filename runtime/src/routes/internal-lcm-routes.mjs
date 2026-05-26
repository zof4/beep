import {
  LCM_CONTEXT_TOKEN,
  LCM_CONTEXT_TOKEN_BUDGET,
  nowIso,
} from "../runtime-common.mjs";
import {
  resolveExpansionGrant,
  runPiDelegatedExpandQuery,
} from "../lcm-delegated-expansion.mjs";
import { jsonResponse, readRequestJson, routeError } from "../http-utils.mjs";

function internalTokenAuthorized(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization === `Bearer ${LCM_CONTEXT_TOKEN}`;
}

export async function handleInternalRoute(req, res, _url, parts, { sessions, lcmController }) {
  const resource = parts[1] || "";
  const action = parts[2] || "";

  if (resource !== "lcm" || !["context", "tool", "lifecycle"].includes(action)) {
    routeError(res, 404, `Unknown internal route: ${req.method} /${parts.join("/")}`);
    return;
  }
  if (req.method !== "POST") {
    routeError(res, 405, "Unsupported method for internal LCM route.");
    return;
  }
  if (!internalTokenAuthorized(req)) {
    routeError(res, 403, "Internal LCM route requires runtime authorization.");
    return;
  }

  const startedAtMs = Date.now();
  const body = await readRequestJson(req);
  const runtimeSessionId = typeof body.runtimeSessionId === "string" ? body.runtimeSessionId : "";
  if (!runtimeSessionId) {
    routeError(res, 400, "runtimeSessionId is required.");
    return;
  }

  if (action === "tool") {
    const toolName = typeof body.toolName === "string" ? body.toolName.trim() : "";
    if (!toolName) {
      routeError(res, 400, "toolName is required.");
      return;
    }
    const session = sessions.get(runtimeSessionId) || null;
    const delegatedRuntimeSessionId =
      typeof body.delegatedRuntimeSessionId === "string" ? body.delegatedRuntimeSessionId.trim() : "";
    const expansionGrantId = typeof body.expansionGrantId === "string" ? body.expansionGrantId.trim() : "";
    const expansionGrant = expansionGrantId
      ? resolveExpansionGrant({
          grantId: expansionGrantId,
          delegatedRuntimeSessionId,
          parentRuntimeSessionId: runtimeSessionId,
        })
      : null;
    if (toolName === "lcm_expand" && !expansionGrant) {
      routeError(res, 403, "lcm_expand requires a valid delegated expansion grant.");
      return;
    }
    try {
      const result = await lcmController.callRecallTool({
        runtimeSessionId,
        toolName,
        params: body.params && typeof body.params === "object" ? body.params : {},
        expansionGrant,
        delegateExpandQuery:
          toolName === "lcm_expand_query"
            ? (request) =>
                runPiDelegatedExpandQuery({
                  sessions,
                  lcmController,
                  parentRuntimeSessionId: runtimeSessionId,
                  parentSession: session,
                  ...request,
                })
            : undefined,
      });
      session?.recordLcmContextInjection({
        kind: `tool:${toolName}`,
        ok: true,
        at: nowIso(),
        durationMs: Date.now() - startedAtMs,
        runtimeSessionId,
        delegatedRuntimeSessionId: delegatedRuntimeSessionId || undefined,
      });
      jsonResponse(res, 200, {
        ok: true,
        toolName,
        result: result.result,
        context: {
          durationMs: Date.now() - startedAtMs,
          lcmLogTail: result.lcmLogTail,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session?.recordLcmContextInjection({
        kind: `tool:${toolName || "unknown"}`,
        ok: false,
        at: nowIso(),
        durationMs: Date.now() - startedAtMs,
        runtimeSessionId,
        error: message,
      });
      routeError(res, 500, message);
    }
    return;
  }

  if (action === "lifecycle") {
    const lifecycleAction = typeof body.action === "string" ? body.action.trim() : "";
    const session = sessions.get(runtimeSessionId) || null;
    try {
      let result;
      if (lifecycleAction === "before_reset") {
        const reason = body.reason === "new" ? "new" : "reset";
        result = await lcmController.handleBeforeReset({
          runtimeSessionId,
          reason,
        });
      } else if (lifecycleAction === "session_end") {
        const reason = typeof body.reason === "string" ? body.reason.trim() : "unknown";
        result = await lcmController.handleSessionEnd({
          runtimeSessionId,
          reason,
          nextRuntimeSessionId: typeof body.nextRuntimeSessionId === "string" ? body.nextRuntimeSessionId : undefined,
        });
      } else {
        routeError(res, 400, 'lifecycle action must be "before_reset" or "session_end".');
        return;
      }
      session?.recordLcmContextInjection({
        kind: `lifecycle:${lifecycleAction}`,
        ok: true,
        at: nowIso(),
        durationMs: Date.now() - startedAtMs,
        runtimeSessionId,
        reason: result.reason,
      });
      jsonResponse(res, 200, {
        ok: true,
        action: lifecycleAction,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session?.recordLcmContextInjection({
        kind: `lifecycle:${lifecycleAction || "unknown"}`,
        ok: false,
        at: nowIso(),
        durationMs: Date.now() - startedAtMs,
        runtimeSessionId,
        error: message,
      });
      routeError(res, 500, message);
    }
    return;
  }

  if (!Array.isArray(body.messages)) {
    routeError(res, 400, "messages must be an array.");
    return;
  }

  const session = sessions.get(runtimeSessionId) || null;
  try {
    const result = await lcmController.assembleLiveMessages({
      runtimeSessionId,
      messages: body.messages,
      tokenBudget: body.tokenBudget,
      prompt: body.prompt,
      includeMessages: true,
    });
    const assemble = result.assemble;
    const telemetry = {
      kind: "assemble",
      ok: true,
      at: nowIso(),
      durationMs: Date.now() - startedAtMs,
      runtimeSessionId,
      inputMessageCount: result.source.inputMessageCount,
      outputMessageCount: assemble.messageCount,
      estimatedTokens: assemble.estimatedTokens,
      contextProjection: assemble.contextProjection,
      tokenBudget: Number(body.tokenBudget || LCM_CONTEXT_TOKEN_BUDGET),
    };
    session?.recordLcmContextInjection(telemetry);
    jsonResponse(res, 200, {
      ok: true,
      messages: assemble.messages,
      context: {
        ...telemetry,
        lcmLogTail: result.lcmLogTail,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session?.recordLcmContextInjection({
      kind: "assemble",
      ok: false,
      at: nowIso(),
      durationMs: Date.now() - startedAtMs,
      runtimeSessionId,
      inputMessageCount: body.messages.length,
      error: message,
    });
    routeError(res, 500, message);
  }
}
