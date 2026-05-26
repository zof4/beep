import { join } from "node:path";
import { PiRpcSession } from "./pi-rpc-session.mjs";
import {
  AGENT_AUTOSTART,
  API_AGENTS_DIR,
  API_SESSIONS_DIR,
  DEFAULT_AGENT_ID,
  DEFAULT_PROMPT_TIMEOUT_MS,
  ensureDir,
  newRequestId,
  nowIso,
  readJsonFile,
  safeNumber,
  writeJsonFile,
} from "./runtime-common.mjs";

export class AgentSupervisor {
  constructor({ id = DEFAULT_AGENT_ID, sessions, lcmController } = {}) {
    this.id = id;
    this.sessions = sessions;
    this.lcmController = lcmController;
    this.rootDir = join(API_AGENTS_DIR, id);
    this.statePath = join(this.rootDir, "agent-state.json");
    this.sessionId = `agent_${id}`;
    this.session = null;
    this.starting = null;
    this.draining = false;
    this.waiters = new Map();
    ensureDir(this.rootDir);
    this.state = this.loadState();
    this.persistState();
  }

  defaultState() {
    return {
      schemaVersion: 1,
      id: this.id,
      sessionId: this.sessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      paused: false,
      lastError: null,
      sequence: 0,
      activeRequestId: null,
      requests: {},
    };
  }

  loadState() {
    const existing = readJsonFile(this.statePath, null);
    const state = existing && !existing.__readError ? { ...this.defaultState(), ...existing } : this.defaultState();
    state.requests = state.requests && typeof state.requests === "object" ? state.requests : {};
    state.activeRequestId = null;
    for (const request of Object.values(state.requests)) {
      if (request.status === "running") {
        request.status = "interrupted";
        request.completedAt = nowIso();
        request.error = "Agent daemon restarted before this request completed.";
      }
    }
    state.updatedAt = nowIso();
    return state;
  }

  persistState() {
    this.state.updatedAt = nowIso();
    writeJsonFile(this.statePath, this.state);
  }

  async start() {
    if (this.session && !this.session.closed) return this.session;
    if (this.starting) return this.starting;
    this.starting = PiRpcSession.start({
      id: this.sessionId,
      resumeLatest: true,
      sessions: this.sessions,
      lcmController: this.lcmController,
    })
      .then((session) => {
        this.session = session;
        this.state.lastError = null;
        this.persistState();
        return session;
      })
      .catch((error) => {
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.persistState();
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  status() {
    const requests = Object.values(this.state.requests);
    const byStatus = {};
    for (const request of requests) {
      byStatus[request.status] = (byStatus[request.status] || 0) + 1;
    }
    return {
      id: this.id,
      statePath: this.statePath,
      paused: Boolean(this.state.paused),
      autostart: AGENT_AUTOSTART,
      activeRequestId: this.state.activeRequestId,
      queueDepth: this.queuedRequests().length,
      requests: {
        total: requests.length,
        byStatus,
        recent: requests
          .slice()
          .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
          .slice(0, 20)
          .map((request) => this.publicRequest(request)),
      },
      session: this.session && !this.session.closed ? this.session.status() : this.readSessionStatus(this.sessionId),
      lastError: this.state.lastError,
      updatedAt: this.state.updatedAt,
    };
  }

  readSessionStatus(id) {
    const active = this.sessions?.get(id) || null;
    if (active) return active.status();
    return readJsonFile(join(API_SESSIONS_DIR, id, "status.json"), null);
  }

  queuedRequests() {
    return Object.values(this.state.requests)
      .filter((request) => request.status === "queued")
      .sort((left, right) => left.sequence - right.sequence);
  }

  getRequest(id) {
    const request = this.state.requests[id];
    return request ? this.publicRequest(request) : null;
  }

  publicRequest(request) {
    return {
      id: request.id,
      sequence: request.sequence,
      status: request.status,
      createdAt: request.createdAt,
      startedAt: request.startedAt || null,
      completedAt: request.completedAt || null,
      message: request.message,
      finalText: request.finalText || null,
      error: request.error || null,
      lcm: request.lcm || null,
      promptResult: request.promptResult || null,
    };
  }

  enqueuePrompt({ message, timeoutMs, recordLcm = true, streamingBehavior = undefined } = {}) {
    if (typeof message !== "string" || message.trim().length === 0) {
      throw Object.assign(new Error("Agent submit requires a message or prompt string."), { statusCode: 400 });
    }
    this.state.sequence += 1;
    const request = {
      id: newRequestId("agent_req"),
      sequence: this.state.sequence,
      status: "queued",
      type: "prompt",
      message,
      timeoutMs: safeNumber(timeoutMs, DEFAULT_PROMPT_TIMEOUT_MS),
      recordLcm: recordLcm !== false,
      streamingBehavior,
      createdAt: nowIso(),
    };
    this.state.requests[request.id] = request;
    this.persistState();
    this.drainQueueSoon();
    return this.publicRequest(request);
  }

  drainQueueSoon() {
    setImmediate(() => {
      this.drainQueue().catch((error) => {
        this.state.lastError = error instanceof Error ? error.message : String(error);
        this.persistState();
      });
    });
  }

  async drainQueue() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.state.paused) {
        const request = this.queuedRequests()[0];
        if (!request) break;
        await this.runRequest(request);
      }
    } finally {
      this.draining = false;
    }
  }

  async runRequest(request) {
    request.status = "running";
    request.startedAt = nowIso();
    request.error = null;
    this.state.activeRequestId = request.id;
    this.persistState();
    this.notifyRequest(request);

    try {
      const session = await this.start();
      const promptResult = await session.prompt(request.message, {
        waitForCompletion: true,
        timeoutMs: request.timeoutMs,
        streamingBehavior: request.streamingBehavior,
      });
      request.promptResult = {
        completed: promptResult.completed,
        finalText: promptResult.finalText,
        response: promptResult.response,
      };
      request.finalText = promptResult.finalText || null;
      if (request.recordLcm) {
        request.lcm = await session.recordLcm();
        session.writeSummary();
      }
      request.status = "completed";
      request.completedAt = nowIso();
    } catch (error) {
      request.status = "failed";
      request.completedAt = nowIso();
      request.error = error instanceof Error ? error.message : String(error);
      this.state.lastError = request.error;
    } finally {
      if (this.state.activeRequestId === request.id) {
        this.state.activeRequestId = null;
      }
      this.persistState();
      this.notifyRequest(request);
    }
  }

  waitForRequest(id, timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS) {
    const request = this.state.requests[id];
    if (!request) {
      throw Object.assign(new Error(`Unknown agent request: ${id}`), { statusCode: 404 });
    }
    if (["completed", "failed", "interrupted", "cancelled"].includes(request.status)) {
      return Promise.resolve(this.publicRequest(request));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(id, waiter);
        rejectPromise(new Error(`Timed out waiting for agent request ${id}.`));
      }, timeoutMs);
      const waiter = {
        resolve: (updated) => {
          clearTimeout(timeout);
          resolvePromise(this.publicRequest(updated));
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      };
      const waiters = this.waiters.get(id) || [];
      waiters.push(waiter);
      this.waiters.set(id, waiters);
    });
  }

  removeWaiter(id, waiter) {
    const waiters = this.waiters.get(id) || [];
    const next = waiters.filter((candidate) => candidate !== waiter);
    if (next.length > 0) this.waiters.set(id, next);
    else this.waiters.delete(id);
  }

  notifyRequest(request) {
    if (!["completed", "failed", "interrupted", "cancelled"].includes(request.status)) return;
    const waiters = this.waiters.get(request.id) || [];
    this.waiters.delete(request.id);
    for (const waiter of waiters) {
      waiter.resolve(request);
    }
  }

  pause() {
    this.state.paused = true;
    this.persistState();
    return this.status();
  }

  resume() {
    this.state.paused = false;
    this.persistState();
    this.drainQueueSoon();
    return this.status();
  }

  async steer(message) {
    const session = await this.start();
    return session.send({ type: "steer", message });
  }

  async followUp(message) {
    const session = await this.start();
    return session.send({ type: "follow_up", message });
  }

  async abort() {
    const session = await this.start();
    return session.send({ type: "abort" });
  }

  async recordLcm(options = {}) {
    const session = await this.start();
    const lcm = await session.recordLcm(options);
    return { lcm, summary: session.writeSummary() };
  }

  async lcmStatus() {
    return this.lcmController.statusForRuntimeSession(this.sessionId);
  }

  async currentLcmSession() {
    return this.start();
  }

  async compactLcm(options = {}) {
    return this.lcmController.compactForSession(await this.currentLcmSession(), options);
  }

  async assembleLcmPreview(options = {}) {
    return this.lcmController.assemblePreviewForSession(await this.currentLcmSession(), options);
  }

  async maintainLcm(options = {}) {
    return this.lcmController.maintainForSession(await this.currentLcmSession(), options);
  }

  async rotateLcm(options = {}) {
    return this.lcmController.rotateForSession(await this.currentLcmSession(), options);
  }

  async backupLcm(options = {}) {
    return this.lcmController.backup(options);
  }

  async resetLcm(options = {}) {
    const reason = options.reason === "new" ? "new" : "reset";
    return this.lcmController.handleBeforeReset({
      runtimeSessionId: this.sessionId,
      reason,
    });
  }

  async doctorLcm() {
    return this.lcmController.doctorForRuntimeSession(this.sessionId);
  }

  async stop() {
    if (this.session && !this.session.closed) {
      await this.session.stop();
    }
    return this.status();
  }
}
