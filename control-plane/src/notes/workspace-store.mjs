import { randomBytes } from "node:crypto";
import {
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
  createDefaultHandwritingProfile,
  createDefaultHandwritingPrompt,
  createHandwritingSample as createHandwritingSampleDomain,
  toggleHandwritingSampleActive,
} from "./handwriting-domain.mjs";
import {
  acceptProposal as acceptProposalDomain,
  createAgentComment,
  createDerivedArtifact as createDerivedArtifactDomain,
  createProposal,
  createSourceArtifact,
  createWorkspaceItem,
  lockWorkspaceItem,
  rejectProposal as rejectProposalDomain,
  unlockWorkspaceItem,
} from "./workspace-domain.mjs";

const UNSAFE_STATE_MAP_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NOTES_OBJECT_MAP_FIELDS = [
  "items",
  "sourceArtifacts",
  "derivedArtifacts",
  "comments",
  "proposals",
  "runs",
  "handwritingProfiles",
  "handwritingPrompts",
  "handwritingSamples",
];
const NOTES_ARRAY_FIELDS = ["itemOrder", "sourceOrder", "runOrder", "handwritingSampleOrder", "handwritingPromptOrder"];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

function canonicalId(value, label) {
  const id = String(value ?? "").trim();
  if (!id) throw new Error(`${label} is required`);
  if (UNSAFE_STATE_MAP_KEYS.has(id)) throw new Error(`unsafe state map key: ${id}`);
  return id;
}

function canonicalIdArray(value, label) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => canonicalId(entry, label));
}

function createRecordId(input, prefix, label) {
  return Object.hasOwn(input, "id") ? canonicalId(input.id, label) : newId(prefix);
}

function assertUniqueId(records, id, label) {
  if (Object.hasOwn(records, id)) throw new Error(`duplicate ${label}: ${id}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(record, field) {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function setOwnDataValue(record, field, value) {
  Object.defineProperty(record, field, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function ensureOwnPlainObject(record, field) {
  if (!isPlainObject(ownDataValue(record, field))) {
    setOwnDataValue(record, field, {});
  }
}

function ensureOwnArray(record, field) {
  if (!Array.isArray(ownDataValue(record, field))) {
    setOwnDataValue(record, field, []);
  }
}

function ownArrayValue(record, field) {
  const value = ownDataValue(record, field);
  return Array.isArray(value) ? value : [];
}

function appendUniqueOwnArray(record, field, id) {
  setOwnDataValue(record, field, [...new Set([...ownArrayValue(record, field), id])]);
}

function initialNotesState() {
  return {
    schemaVersion: 1,
    items: {},
    itemOrder: [],
    sourceArtifacts: {},
    sourceOrder: [],
    derivedArtifacts: {},
    comments: {},
    proposals: {},
    runs: {},
    runOrder: [],
    handwritingProfiles: {},
    handwritingPrompts: {},
    handwritingSamples: {},
    handwritingSampleOrder: [],
    handwritingPromptOrder: [],
  };
}

function ensureNotesState(state) {
  let notes = ownDataValue(state, "notesBackbone");
  if (!isPlainObject(notes)) {
    notes = initialNotesState();
    setOwnDataValue(state, "notesBackbone", notes);
  }
  for (const field of NOTES_OBJECT_MAP_FIELDS) ensureOwnPlainObject(notes, field);
  for (const field of NOTES_ARRAY_FIELDS) ensureOwnArray(notes, field);
  return notes;
}

function ensureHandwritingDefaults(notes, now = nowIso) {
  if (!Object.hasOwn(notes.handwritingProfiles, DEFAULT_HANDWRITING_PROFILE_ID)) {
    notes.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID] = createDefaultHandwritingProfile({ createdAt: now() });
  }
  if (!Object.hasOwn(notes.handwritingPrompts, DEFAULT_HANDWRITING_PROMPT_ID)) {
    notes.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID] = createDefaultHandwritingPrompt({ createdAt: now() });
  }
  if (!notes.handwritingPromptOrder.includes(DEFAULT_HANDWRITING_PROMPT_ID)) {
    notes.handwritingPromptOrder.push(DEFAULT_HANDWRITING_PROMPT_ID);
  }
}

export class NotesWorkspaceStore {
  constructor({ store, now = nowIso } = {}) {
    if (!store) throw new Error("StateStore is required");
    this.store = store;
    this.now = now;
  }

  readWorkspace() {
    const state = this.store.readState();
    const notes = ensureNotesState(state);
    ensureHandwritingDefaults(notes, this.now);
    return structuredClone(notes);
  }

  updateWorkspace(mutator) {
    return this.store.update((state) => {
      const notes = ensureNotesState(state);
      ensureHandwritingDefaults(notes, this.now);
      return mutator(notes);
    });
  }

  getItem(itemId) {
    const id = canonicalId(itemId, "workspace item id");
    const items = this.readWorkspace().items;
    return Object.hasOwn(items, id) ? items[id] : null;
  }

  createItem(input) {
    const itemId = createRecordId(input, "item", "workspace item id");
    const sourceArtifactIds = canonicalIdArray(input.sourceArtifactIds, "source artifact id");
    const derivedArtifactIds = canonicalIdArray(input.derivedArtifactIds, "derived artifact id");
    const agentCommentIds = canonicalIdArray(input.agentCommentIds, "comment id");
    const proposalIds = canonicalIdArray(input.proposalIds, "proposal id");
    return this.updateWorkspace((workspace) => {
      assertUniqueId(workspace.items, itemId, "workspace item id");
      const item = createWorkspaceItem({
        ...input,
        id: itemId,
        sourceArtifactIds,
        derivedArtifactIds,
        agentCommentIds,
        proposalIds,
        createdAt: input.createdAt || this.now(),
      });
      workspace.items[item.id] = item;
      workspace.itemOrder.push(item.id);
      return item;
    });
  }

  createSourceArtifact(input) {
    const sourceId = createRecordId(input, "src", "source artifact id");
    return this.updateWorkspace((workspace) => {
      assertUniqueId(workspace.sourceArtifacts, sourceId, "source artifact id");
      const source = createSourceArtifact({
        ...input,
        id: sourceId,
        createdAt: input.createdAt || this.now(),
      });
      workspace.sourceArtifacts[source.id] = source;
      workspace.sourceOrder.push(source.id);
      return source;
    });
  }

  getDefaultHandwritingPrompt() {
    const workspace = this.readWorkspace();
    return workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID];
  }

  createHandwritingSample(input) {
    const sampleId = createRecordId(input, "hw_sample", "handwriting sample id");
    const profileId = canonicalId(input.profileId || DEFAULT_HANDWRITING_PROFILE_ID, "handwriting profile id");
    const sourceArtifactId = canonicalId(input.sourceArtifactId, "source artifact id");
    return this.updateWorkspace((workspace) => {
      assertUniqueId(workspace.handwritingSamples, sampleId, "handwriting sample id");
      const profile = workspace.handwritingProfiles[profileId];
      if (!profile) throw new Error(`unknown handwriting profile: ${profileId}`);
      const prompt = input.prompt || workspace.handwritingPrompts[input.promptId || DEFAULT_HANDWRITING_PROMPT_ID];
      if (!prompt) throw new Error(`unknown handwriting prompt: ${input.promptId}`);
      if (!Object.hasOwn(workspace.sourceArtifacts, sourceArtifactId)) {
        throw new Error(`unknown source artifact: ${sourceArtifactId}`);
      }
      const sample = createHandwritingSampleDomain({
        ...input,
        id: sampleId,
        profileId,
        prompt,
        sourceArtifactId,
        createdAt: input.createdAt || this.now(),
      });
      workspace.handwritingSamples[sample.id] = sample;
      workspace.handwritingSampleOrder.push(sample.id);
      const toggled = toggleHandwritingSampleActive({
        profile,
        sample,
        active: sample.active,
        updatedAt: sample.createdAt,
      });
      workspace.handwritingProfiles[profileId] = toggled.profile;
      workspace.handwritingSamples[sample.id] = toggled.sample;
      return workspace.handwritingSamples[sample.id];
    });
  }

  toggleHandwritingSample(sampleId, { active }) {
    const id = canonicalId(sampleId, "handwriting sample id");
    return this.updateWorkspace((workspace) => {
      const sample = workspace.handwritingSamples[id];
      if (!sample) throw new Error(`unknown handwriting sample: ${id}`);
      const profile = workspace.handwritingProfiles[sample.profileId];
      if (!profile) throw new Error(`unknown handwriting profile: ${sample.profileId}`);
      const toggled = toggleHandwritingSampleActive({ profile, sample, active, updatedAt: this.now() });
      workspace.handwritingProfiles[sample.profileId] = toggled.profile;
      workspace.handwritingSamples[id] = toggled.sample;
      return toggled.sample;
    });
  }

  createDerivedArtifact(input) {
    const derivedId = createRecordId(input, "derived", "derived artifact id");
    const sourceArtifactIds = canonicalIdArray(input.sourceArtifactIds, "source artifact id");
    const sourceItemIds = canonicalIdArray(input.sourceItemIds, "workspace item id");
    return this.updateWorkspace((workspace) => {
      assertUniqueId(workspace.derivedArtifacts, derivedId, "derived artifact id");
      const derived = createDerivedArtifactDomain({
        ...input,
        id: derivedId,
        sourceArtifactIds,
        sourceItemIds,
        createdAt: input.createdAt || this.now(),
      });
      workspace.derivedArtifacts[derived.id] = derived;
      for (const sourceId of derived.sourceArtifactIds) {
        if (Object.hasOwn(workspace.sourceArtifacts, sourceId)) {
          const source = workspace.sourceArtifacts[sourceId];
          appendUniqueOwnArray(source, "derivedArtifactIds", derived.id);
          source.updatedAt = derived.createdAt;
        }
      }
      for (const itemId of derived.sourceItemIds) {
        if (Object.hasOwn(workspace.items, itemId)) {
          const item = workspace.items[itemId];
          appendUniqueOwnArray(item, "derivedArtifactIds", derived.id);
          item.updatedAt = derived.createdAt;
        }
      }
      return derived;
    });
  }

  createComment(input) {
    const commentId = createRecordId(input, "comment", "comment id");
    const targetId = canonicalId(input.targetId, "agent comment target id");
    const sourceItemIds = canonicalIdArray(input.sourceItemIds, "workspace item id");
    const sourceArtifactIds = canonicalIdArray(input.sourceArtifactIds, "source artifact id");
    return this.updateWorkspace((workspace) => {
      assertUniqueId(workspace.comments, commentId, "comment id");
      const comment = createAgentComment({
        ...input,
        id: commentId,
        targetId,
        sourceItemIds,
        sourceArtifactIds,
        createdAt: input.createdAt || this.now(),
      });
      workspace.comments[comment.id] = comment;
      if (Object.hasOwn(workspace.items, comment.targetId)) {
        const target = workspace.items[comment.targetId];
        appendUniqueOwnArray(target, "agentCommentIds", comment.id);
        target.updatedAt = comment.createdAt;
      }
      return comment;
    });
  }

  createProposal(input) {
    const proposalId = createRecordId(input, "proposal", "proposal id");
    const sourceItemIds = canonicalIdArray(input.sourceItemIds, "workspace item id");
    const sourceArtifactIds = canonicalIdArray(input.sourceArtifactIds, "source artifact id");
    return this.updateWorkspace((workspace) => {
      assertUniqueId(workspace.proposals, proposalId, "proposal id");
      const proposal = createProposal({
        ...input,
        id: proposalId,
        sourceItemIds,
        sourceArtifactIds,
        createdAt: input.createdAt || this.now(),
      });
      workspace.proposals[proposal.id] = proposal;
      for (const itemId of proposal.sourceItemIds) {
        if (Object.hasOwn(workspace.items, itemId)) {
          const sourceItem = workspace.items[itemId];
          appendUniqueOwnArray(sourceItem, "proposalIds", proposal.id);
          sourceItem.updatedAt = proposal.createdAt;
        }
      }
      return proposal;
    });
  }

  acceptProposal(proposalId) {
    const id = canonicalId(proposalId, "proposal id");
    return this.updateWorkspace((workspace) => {
      if (!Object.hasOwn(workspace.proposals, id)) throw new Error(`unknown proposal: ${id}`);
      const proposal = workspace.proposals[id];
      const accepted = acceptProposalDomain(proposal, { itemId: newId("item"), acceptedAt: this.now() });
      workspace.proposals[id] = accepted.proposal;
      workspace.items[accepted.item.id] = accepted.item;
      workspace.itemOrder.push(accepted.item.id);
      return accepted;
    });
  }

  rejectProposal(proposalId) {
    const id = canonicalId(proposalId, "proposal id");
    return this.updateWorkspace((workspace) => {
      if (!Object.hasOwn(workspace.proposals, id)) throw new Error(`unknown proposal: ${id}`);
      const proposal = workspace.proposals[id];
      const rejected = rejectProposalDomain(proposal, { rejectedAt: this.now() });
      workspace.proposals[id] = rejected;
      return rejected;
    });
  }

  lockItem(itemId) {
    const id = canonicalId(itemId, "workspace item id");
    return this.updateWorkspace((workspace) => {
      if (!Object.hasOwn(workspace.items, id)) throw new Error(`unknown item: ${id}`);
      const item = workspace.items[id];
      workspace.items[id] = lockWorkspaceItem(item, { lockedAt: this.now() });
      return workspace.items[id];
    });
  }

  unlockItem(itemId) {
    const id = canonicalId(itemId, "workspace item id");
    return this.updateWorkspace((workspace) => {
      if (!Object.hasOwn(workspace.items, id)) throw new Error(`unknown item: ${id}`);
      const item = workspace.items[id];
      workspace.items[id] = unlockWorkspaceItem(item, { unlockedAt: this.now() });
      return workspace.items[id];
    });
  }

  upsertRun(run) {
    const runId = canonicalId(run?.id, "run id");
    return this.updateWorkspace((workspace) => {
      const exists = Object.hasOwn(workspace.runs, runId);
      const nextRun = { ...run, id: runId };
      workspace.runs[runId] = nextRun;
      if (!exists) workspace.runOrder.unshift(runId);
      return nextRun;
    });
  }
}
