import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./config.mjs";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stateError = new Error(`failed to read state JSON: ${path}: ${message}`);
    stateError.cause = error;
    throw stateError;
  }
}

function writeJson(path, value, mode = 0o600) {
  ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(tmpPath, path);
}

function initialState() {
  return {
    schemaVersion: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    runtimes: {},
    exposures: {},
    agentRequests: {},
    approvals: {},
    gatekeeperReviews: {},
    sites: {},
    audit: [],
  };
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

function sleepSync(ms) {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function appendAuditEvent(state, event) {
  state.audit ||= [];
  state.audit.push({
    ...event,
    at: event.at || nowIso(),
  });
  state.audit = state.audit.slice(-1000);
}

function isValidToken(token) {
  return TOKEN_PATTERN.test(token);
}

export class StateStore {
  constructor(stateDir = STATE_DIR) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, "state.json");
    this.lockPath = join(stateDir, "state.lock");
    this.runtimeTokenPath = join(stateDir, "runtime-token");
    this.runtimeApiTokenPath = join(stateDir, "runtime-api-token");
    this.modelCredentialTokenPath = join(stateDir, "model-credential-token");
    this.operatorTokenPath = join(stateDir, "operator-token");
  }

  ensureUnlocked() {
    ensureDir(this.stateDir);
    if (!existsSync(this.statePath)) {
      writeJson(this.statePath, initialState());
    }
  }

  ensure() {
    this.withLock(() => {
      this.ensureUnlocked();
    });
  }

  readStateUnlocked() {
    this.ensureUnlocked();
    const state = readJson(this.statePath, initialState());
    state.runtimes ||= {};
    state.exposures ||= {};
    state.agentRequests ||= {};
    state.approvals ||= {};
    state.gatekeeperReviews ||= {};
    state.sites ||= {};
    state.audit ||= [];
    return state;
  }

  readState() {
    return this.withLock(() => this.readStateUnlocked());
  }

  writeStateUnlocked(state) {
    state.updatedAt = nowIso();
    writeJson(this.statePath, state);
  }

  writeState(state) {
    this.withLock(() => {
      this.writeStateUnlocked(state);
    });
  }

  withLock(callback) {
    ensureDir(this.stateDir);
    const startedAt = Date.now();
    let lockFd = null;
    while (lockFd === null) {
      try {
        lockFd = openSync(this.lockPath, "wx", 0o600);
        try {
          writeFileSync(
            lockFd,
            `${JSON.stringify({
              pid: process.pid,
              acquiredAt: nowIso(),
            })}\n`,
          );
        } catch (metadataError) {
          closeSync(lockFd);
          lockFd = null;
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Preserve the metadata write failure as the primary error.
          }
          throw metadataError;
        }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for state lock: ${this.lockPath}`);
        }
        sleepSync(LOCK_WAIT_MS);
      }
    }

    try {
      return callback();
    } finally {
      closeSync(lockFd);
      try {
        unlinkSync(this.lockPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  update(mutator) {
    return this.withLock(() => {
      const state = this.readStateUnlocked();
      const result = mutator(state);
      this.writeStateUnlocked(state);
      return result;
    });
  }

  ensureTokenFile(path) {
    return this.withLock(() => {
      this.ensureUnlocked();
      if (existsSync(path)) {
        const token = readFileSync(path, "utf8").trim();
        if (isValidToken(token)) {
          chmodSync(path, 0o600);
          return token;
        }
      }
      const token = randomBytes(32).toString("base64url");
      writeFileSync(path, `${token}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
      return token;
    });
  }

  ensureRuntimeToken() {
    return this.ensureTokenFile(this.runtimeTokenPath);
  }

  ensureRuntimeApiToken() {
    return this.ensureTokenFile(this.runtimeApiTokenPath);
  }

  ensureModelCredentialToken() {
    return this.ensureTokenFile(this.modelCredentialTokenPath);
  }

  ensureOperatorToken() {
    return this.ensureTokenFile(this.operatorTokenPath);
  }

  upsertRuntime(runtimeId, patch) {
    this.update((state) => {
      state.runtimes[runtimeId] = {
        ...(state.runtimes[runtimeId] || {}),
        ...patch,
        runtimeId,
        updatedAt: nowIso(),
      };
    });
  }

  upsertExposure(exposure) {
    this.update((state) => {
      state.exposures[`${exposure.runtimeId}:${exposure.containerPort}`] = {
        ...exposure,
        updatedAt: nowIso(),
      };
    });
  }

  createAgentRequest(request) {
    const requestId = newId("cp_req");
    const createdAt = nowIso();
    const created = {
      ...request,
      schemaVersion: 1,
      requestId,
      runtimeId: request.runtimeId || null,
      message: request.message || "",
      status: "submitted",
      source: request.source || "control-plane",
      createdAt,
      updatedAt: createdAt,
    };
    this.update((state) => {
      state.agentRequests[requestId] = created;
      appendAuditEvent(state, {
        kind: "agent_request_created",
        requestId,
        runtimeId: created.runtimeId,
        status: created.status,
      });
    });
    return created;
  }

  updateAgentRequest(requestId, patch) {
    let next = null;
    this.update((state) => {
      const current = state.agentRequests[requestId];
      if (!current) return;
      next = {
        ...current,
        ...patch,
        requestId,
        updatedAt: nowIso(),
      };
      state.agentRequests[requestId] = next;
      appendAuditEvent(state, {
        kind: "agent_request_updated",
        requestId,
        runtimeId: next.runtimeId,
        status: next.status,
        error: next.error || null,
      });
    });
    return next;
  }

  listAgentRequests({ runtimeId = null, limit = 20 } = {}) {
    const requests = Object.values(this.readState().agentRequests || {});
    return requests
      .filter((request) => !runtimeId || request.runtimeId === runtimeId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, limit);
  }

  upsertSite(site, auditEvent = null) {
    this.update((state) => {
      state.sites[site.siteId] = {
        ...(state.sites[site.siteId] || {}),
        ...site,
        updatedAt: nowIso(),
      };
      if (auditEvent) appendAuditEvent(state, auditEvent);
    });
  }

  getSite(siteId) {
    return this.readState().sites?.[siteId] || null;
  }

  listSites({ status = null, limit = 100 } = {}) {
    const sites = Object.values(this.readState().sites || {});
    return sites
      .filter((site) => !status || site.status === status)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, limit);
  }

  createApproval(approval) {
    const approvalId = newId("appr");
    const createdAt = nowIso();
    const created = {
      ...approval,
      schemaVersion: 1,
      approvalId,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    this.update((state) => {
      state.approvals[approvalId] = created;
      appendAuditEvent(state, {
        kind: "approval_created",
        approvalId,
        runtimeId: created.runtimeId,
        toolCallId: created.toolCallId,
        action: created.action,
        status: created.status,
        risk: created.risk || null,
      });
    });
    return created;
  }

  getApproval(approvalId) {
    return this.readState().approvals?.[approvalId] || null;
  }

  listApprovals({ status = null, limit = 100 } = {}) {
    const approvals = Object.values(this.readState().approvals || {});
    return approvals
      .filter((approval) => !status || approval.status === status)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, limit);
  }

  updateApproval(approvalId, patch) {
    let next = null;
    this.update((state) => {
      const current = state.approvals[approvalId];
      if (!current) return;
      next = {
        ...current,
        ...patch,
        approvalId,
        updatedAt: nowIso(),
      };
      state.approvals[approvalId] = next;
      appendAuditEvent(state, {
        kind: "approval_updated",
        approvalId,
        runtimeId: next.runtimeId,
        toolCallId: next.toolCallId,
        action: next.action,
        status: next.status,
        decision: next.decision || null,
        gatekeeperReviewId: next.gatekeeperReviewId || null,
        error: next.error || null,
      });
    });
    return next;
  }

  transitionApproval(approvalId, expectedStatus, patch) {
    let result = null;
    this.update((state) => {
      const current = state.approvals[approvalId];
      if (!current) {
        result = { ok: false, reason: "not_found", approval: null };
        return;
      }
      if (current.status !== expectedStatus) {
        result = { ok: false, reason: "status_conflict", approval: current };
        return;
      }
      const next = {
        ...current,
        ...patch,
        approvalId,
        updatedAt: nowIso(),
      };
      state.approvals[approvalId] = next;
      appendAuditEvent(state, {
        kind: "approval_updated",
        approvalId,
        runtimeId: next.runtimeId,
        toolCallId: next.toolCallId,
        action: next.action,
        status: next.status,
        decision: next.decision || null,
        gatekeeperReviewId: next.gatekeeperReviewId || null,
        error: next.error || null,
      });
      result = { ok: true, approval: next };
    });
    return result;
  }

  createGatekeeperReview(review) {
    const reviewId = newId("gk");
    const createdAt = nowIso();
    const created = {
      ...review,
      schemaVersion: 1,
      reviewId,
      status: "started",
      createdAt,
      updatedAt: createdAt,
    };
    this.update((state) => {
      state.gatekeeperReviews[reviewId] = created;
      appendAuditEvent(state, {
        kind: "gatekeeper_review_created",
        reviewId,
        runtimeId: created.runtimeId,
        toolCallId: created.toolCallId,
        action: created.action,
        status: created.status,
        reviewer: created.reviewer || null,
      });
    });
    return created;
  }

  updateGatekeeperReview(reviewId, patch) {
    let next = null;
    this.update((state) => {
      const current = state.gatekeeperReviews[reviewId];
      if (!current) return;
      next = {
        ...current,
        ...patch,
        reviewId,
        updatedAt: nowIso(),
      };
      state.gatekeeperReviews[reviewId] = next;
      appendAuditEvent(state, {
        kind: "gatekeeper_review_updated",
        reviewId,
        runtimeId: next.runtimeId,
        toolCallId: next.toolCallId,
        action: next.action,
        status: next.status,
        outcome: next.decision?.outcome || null,
        riskLevel: next.decision?.riskLevel || null,
        userAuthorization: next.decision?.userAuthorization || null,
        error: next.error || null,
      });
    });
    return next;
  }

  getGatekeeperReview(reviewId) {
    return this.readState().gatekeeperReviews?.[reviewId] || null;
  }

  listGatekeeperReviews({ status = null, limit = 100 } = {}) {
    const reviews = Object.values(this.readState().gatekeeperReviews || {});
    return reviews
      .filter((review) => !status || review.status === status)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, limit);
  }

  appendAudit(event) {
    this.update((state) => {
      appendAuditEvent(state, event);
    });
  }

  listAudit(limit = 100) {
    const state = this.readState();
    return state.audit.slice(-limit).reverse();
  }
}
