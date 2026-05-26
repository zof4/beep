import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./config.mjs";

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ...fallback,
      readError: error instanceof Error ? error.message : String(error),
    };
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
    approvals: {},
    sites: {},
    audit: [],
  };
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

export class StateStore {
  constructor(stateDir = STATE_DIR) {
    this.stateDir = stateDir;
    this.statePath = join(stateDir, "state.json");
    this.runtimeTokenPath = join(stateDir, "runtime-token");
    this.operatorTokenPath = join(stateDir, "operator-token");
  }

  ensure() {
    ensureDir(this.stateDir);
    if (!existsSync(this.statePath)) {
      writeJson(this.statePath, initialState());
    }
  }

  readState() {
    this.ensure();
    const state = readJson(this.statePath, initialState());
    state.runtimes ||= {};
    state.exposures ||= {};
    state.approvals ||= {};
    state.sites ||= {};
    state.audit ||= [];
    return state;
  }

  writeState(state) {
    state.updatedAt = nowIso();
    writeJson(this.statePath, state);
  }

  update(mutator) {
    const state = this.readState();
    const result = mutator(state);
    this.writeState(state);
    return result;
  }

  ensureRuntimeToken() {
    this.ensure();
    if (existsSync(this.runtimeTokenPath)) {
      const token = readFileSync(this.runtimeTokenPath, "utf8").trim();
      if (token) return token;
    }
    const token = randomBytes(32).toString("base64url");
    writeFileSync(this.runtimeTokenPath, `${token}\n`, { mode: 0o600 });
    return token;
  }

  ensureOperatorToken() {
    this.ensure();
    if (existsSync(this.operatorTokenPath)) {
      const token = readFileSync(this.operatorTokenPath, "utf8").trim();
      if (token) return token;
    }
    const token = randomBytes(32).toString("base64url");
    writeFileSync(this.operatorTokenPath, `${token}\n`, { mode: 0o600 });
    return token;
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

  upsertSite(site) {
    this.update((state) => {
      state.sites[site.siteId] = {
        ...(state.sites[site.siteId] || {}),
        ...site,
        updatedAt: nowIso(),
      };
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
    const created = {
      schemaVersion: 1,
      approvalId,
      status: "pending",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...approval,
    };
    this.update((state) => {
      state.approvals[approvalId] = created;
    });
    this.appendAudit({
      kind: "approval_created",
      approvalId,
      runtimeId: created.runtimeId,
      toolCallId: created.toolCallId,
      action: created.action,
      status: created.status,
      risk: created.risk || null,
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
    });
    if (next) {
      this.appendAudit({
        kind: "approval_updated",
        approvalId,
        runtimeId: next.runtimeId,
        toolCallId: next.toolCallId,
        action: next.action,
        status: next.status,
        decision: next.decision || null,
        error: next.error || null,
      });
    }
    return next;
  }

  appendAudit(event) {
    this.update((state) => {
      state.audit.push({
        ...event,
        at: event.at || nowIso(),
      });
      state.audit = state.audit.slice(-1000);
    });
  }

  listAudit(limit = 100) {
    const state = this.readState();
    return state.audit.slice(-limit).reverse();
  }
}
