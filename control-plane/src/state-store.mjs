import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
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
const STATE_OBJECT_MAP_FIELDS = [
  "runtimes",
  "exposures",
  "agentRequests",
  "approvals",
  "gatekeeperReviews",
  "sites",
];
const STATE_MAP_ID_FIELDS = {
  agentRequests: "requestId",
  approvals: "approvalId",
  gatekeeperReviews: "reviewId",
  runtimes: "runtimeId",
  sites: "siteId",
};
const UNSAFE_STATE_MAP_KEYS = new Set(["__proto__", "prototype", "constructor"]);
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

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnsafeStateMapKey(key) {
  return UNSAFE_STATE_MAP_KEYS.has(String(key));
}

function isValidStateIdentity(value) {
  return typeof value === "string" && value.trim() !== "" && !isUnsafeStateMapKey(value);
}

function assertValidStateIdentity(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid state identity: ${value}`);
  }
  if (isUnsafeStateMapKey(value)) {
    throw new Error(`unsafe state map key: ${value}`);
  }
}

function invalidStateShape(path, message) {
  throw new Error(`invalid state shape: ${path}: ${message}`);
}

function validateStateIdentity(value, path, label) {
  if (!isValidStateIdentity(value)) {
    invalidStateShape(path, `${label} must be a non-empty safe string`);
  }
}

function validateStateMapRecords(state, field, path) {
  const idField = STATE_MAP_ID_FIELDS[field];
  for (const [key, record] of Object.entries(state[field])) {
    validateStateIdentity(key, path, `${field} map key`);
    if (!isPlainObject(record)) {
      invalidStateShape(path, `${field}.${key} must be an object`);
    }
    if (idField) validateStateIdentity(record[idField], path, `${field}.${key}.${idField}`);
    if (idField && record[idField] !== key) {
      invalidStateShape(path, `${field}.${key}.${idField} must match map key`);
    }
    if (field === "exposures") validateExposureRecord(key, record, path);
  }
}

function normalizeExposureContainerPort(containerPort) {
  if (Number.isInteger(containerPort)) return String(containerPort);
  if (typeof containerPort !== "string" || !/^(0|[1-9]\d*)$/.test(containerPort)) return null;
  return String(Number(containerPort)) === containerPort ? containerPort : null;
}

function validateExposureRecord(key, record, path) {
  validateStateIdentity(record.runtimeId, path, `exposures.${key}.runtimeId`);
  const containerPort = normalizeExposureContainerPort(record.containerPort);
  if (containerPort === null) {
    invalidStateShape(path, `exposures.${key}.containerPort must be an integer or canonical integer string`);
  }
  if (`${record.runtimeId}:${containerPort}` !== key) {
    invalidStateShape(path, `exposures.${key} key must match runtimeId and containerPort`);
  }
}

function normalizeStateShape(state, path) {
  if (!isPlainObject(state)) {
    invalidStateShape(path, "top-level state must be an object");
  }
  for (const field of STATE_OBJECT_MAP_FIELDS) {
    if (state[field] === undefined) {
      state[field] = {};
    } else if (!isPlainObject(state[field])) {
      invalidStateShape(path, `${field} must be an object map`);
    }
    validateStateMapRecords(state, field, path);
  }
  if (state.audit === undefined) {
    state.audit = [];
  } else if (!Array.isArray(state.audit)) {
    invalidStateShape(path, "audit must be an array");
  }
  for (const [index, event] of state.audit.entries()) {
    if (!isPlainObject(event)) {
      invalidStateShape(path, `audit.${index} must be an object`);
    }
  }
  return state;
}

function tokenPathStats(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRegularTokenPath(path, stats) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`refusing token path that is not a regular file: ${path}`);
  }
}

function replaceTokenFile(path, token) {
  ensureDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("base64url")}.tmp`;
  let tmpFd = null;
  try {
    tmpFd = openSync(tmpPath, "wx", 0o600);
    writeFileSync(tmpFd, `${token}\n`);
    closeSync(tmpFd);
    tmpFd = null;
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (tmpFd !== null) {
      try {
        closeSync(tmpFd);
      } catch {
        // Preserve the primary token write error.
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // Preserve the primary token replacement error.
    }
    throw error;
  }
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
    return normalizeStateShape(readJson(this.statePath, initialState()), this.statePath);
  }

  readState() {
    return this.withLock(() => this.readStateUnlocked());
  }

  writeStateUnlocked(state) {
    state.updatedAt = nowIso();
    normalizeStateShape(state, this.statePath);
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
      const stats = tokenPathStats(path);
      if (stats) {
        assertRegularTokenPath(path, stats);
        const token = readFileSync(path, "utf8").trim();
        if (isValidToken(token)) {
          chmodSync(path, 0o600);
          return token;
        }
      }
      const token = randomBytes(32).toString("base64url");
      replaceTokenFile(path, token);
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
    assertValidStateIdentity(runtimeId);
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
    const exposureKey = `${exposure.runtimeId}:${exposure.containerPort}`;
    assertValidStateIdentity(exposureKey);
    this.update((state) => {
      state.exposures[exposureKey] = {
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
    assertValidStateIdentity(requestId);
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
    assertValidStateIdentity(site.siteId);
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
    assertValidStateIdentity(approvalId);
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
    assertValidStateIdentity(approvalId);
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
    assertValidStateIdentity(reviewId);
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
