import { join } from "node:path";
import { API_SESSIONS_DIR, parseJsonl, readJsonFile, safeNumber } from "../runtime-common.mjs";
import { jsonResponse, readRequestJson, routeError, textResponse } from "../http-utils.mjs";

export async function handleAgentRoute(req, res, url, parts, { agentSupervisor }) {
  const action = parts[1] || "";
  const id = parts[2] || "";

  if (req.method === "GET" && action === "") {
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.status() });
    return;
  }

  if (req.method === "GET" && action === "requests" && !id) {
    const requests = Object.values(agentSupervisor.state.requests)
      .sort((left, right) => right.sequence - left.sequence)
      .map((request) => agentSupervisor.publicRequest(request));
    jsonResponse(res, 200, { ok: true, requests });
    return;
  }

  if (req.method === "GET" && action === "requests" && id) {
    const request = agentSupervisor.getRequest(id);
    if (!request) {
      routeError(res, 404, `Unknown agent request: ${id}`);
      return;
    }
    jsonResponse(res, 200, { ok: true, request });
    return;
  }

  if (req.method === "GET" && action === "events") {
    const status = agentSupervisor.readSessionStatus(agentSupervisor.sessionId);
    if (!status) {
      routeError(res, 404, "The Beep agent session has not started yet.");
      return;
    }
    const events = parseJsonl(status.eventsPath);
    const limit = safeNumber(url.searchParams.get("limit"), events.length);
    const selected = events.slice(Math.max(0, events.length - limit));
    if (url.searchParams.get("format") === "ndjson") {
      textResponse(res, 200, `${selected.map((event) => JSON.stringify(event)).join("\n")}\n`, {
        "content-type": "application/x-ndjson; charset=utf-8",
      });
      return;
    }
    jsonResponse(res, 200, { ok: true, sessionId: agentSupervisor.sessionId, total: events.length, events: selected });
    return;
  }

  if (req.method === "GET" && action === "summary") {
    if (agentSupervisor.session && !agentSupervisor.session.closed) {
      jsonResponse(res, 200, { ok: true, summary: agentSupervisor.session.writeSummary() });
      return;
    }
    const summary = readJsonFile(join(API_SESSIONS_DIR, agentSupervisor.sessionId, "summary.json"), null);
    if (!summary) {
      routeError(res, 404, "The Beep agent session has no summary yet.");
      return;
    }
    jsonResponse(res, 200, { ok: true, summary });
    return;
  }

  if (action === "lcm" && id) {
    if (req.method === "GET" && id === "status") {
      jsonResponse(res, 200, { ok: true, lcm: await agentSupervisor.lcmStatus() });
      return;
    }
    if (req.method === "GET" && id === "doctor") {
      jsonResponse(res, 200, { ok: true, doctor: await agentSupervisor.doctorLcm() });
      return;
    }
    if (req.method !== "POST") {
      routeError(res, 405, "Unsupported method for agent LCM route.");
      return;
    }
    const body = await readRequestJson(req);
    if (id === "compact") {
      const compact = await agentSupervisor.compactLcm(body);
      jsonResponse(res, compact.ok ? 200 : 409, { ok: compact.ok, compact });
      return;
    }
    if (id === "assemble-preview") {
      jsonResponse(res, 200, { ok: true, preview: await agentSupervisor.assembleLcmPreview(body) });
      return;
    }
    if (id === "maintain") {
      jsonResponse(res, 200, { ok: true, maintain: await agentSupervisor.maintainLcm(body) });
      return;
    }
    if (id === "rotate") {
      const rotate = await agentSupervisor.rotateLcm(body);
      jsonResponse(res, rotate.ok ? 200 : 409, { ok: rotate.ok, rotate });
      return;
    }
    if (id === "backup") {
      const backup = await agentSupervisor.backupLcm(body);
      jsonResponse(res, backup.ok ? 200 : 500, { ok: backup.ok, backup });
      return;
    }
    if (id === "reset") {
      const reset = await agentSupervisor.resetLcm(body);
      jsonResponse(res, reset.ok ? 200 : 409, { ok: reset.ok, reset });
      return;
    }
    routeError(res, 404, `Unknown agent LCM action: ${id}`);
    return;
  }

  if (req.method !== "POST") {
    routeError(res, 405, "Unsupported method for agent route.");
    return;
  }

  const body = await readRequestJson(req);

  if (action === "start") {
    const session = await agentSupervisor.start();
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.status(), session: session.status() });
    return;
  }

  if (action === "submit") {
    const request = agentSupervisor.enqueuePrompt({
      message: body.message || body.prompt,
      timeoutMs: body.timeoutMs,
      recordLcm: body.recordLcm,
      streamingBehavior: body.streamingBehavior,
    });
    if (body.waitForCompletion) {
      const completed = await agentSupervisor.waitForRequest(request.id, body.timeoutMs);
      jsonResponse(res, completed.status === "completed" ? 200 : 500, {
        ok: completed.status === "completed",
        request: completed,
        agent: agentSupervisor.status(),
      });
      return;
    }
    jsonResponse(res, 202, { ok: true, request, agent: agentSupervisor.status() });
    return;
  }

  if (action === "pause") {
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.pause() });
    return;
  }

  if (action === "resume") {
    jsonResponse(res, 200, { ok: true, agent: agentSupervisor.resume() });
    return;
  }

  if (action === "steer") {
    const response = await agentSupervisor.steer(body.message || body.prompt);
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "follow-up") {
    const response = await agentSupervisor.followUp(body.message || body.prompt);
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "abort") {
    const response = await agentSupervisor.abort();
    jsonResponse(res, response.success === false ? 422 : 200, { ok: response.success !== false, response });
    return;
  }

  if (action === "lcm") {
    const result = await agentSupervisor.recordLcm({ force: Boolean(body.force) });
    jsonResponse(res, 200, { ok: true, ...result });
    return;
  }

  if (action === "stop") {
    jsonResponse(res, 200, { ok: true, agent: await agentSupervisor.stop() });
    return;
  }

  routeError(res, 404, `Unknown agent action: ${action}`);
}
