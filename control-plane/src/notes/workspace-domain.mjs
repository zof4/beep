const ITEM_TYPES = new Set(["note", "todo", "calendarBlock", "research"]);
const PROPOSAL_KINDS = new Set(["todo", "calendarBlock", "research", "comment", "estimate", "plan"]);

function nowIso() {
  return new Date().toISOString();
}

function requiredString(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function cleanArray(value) {
  return Array.isArray(value)
    ? value
        .filter((entry) => entry != null)
        .map((entry) => String(entry).trim())
        .filter(Boolean)
    : [];
}

function cloneJson(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function cloneObjectArray(value) {
  return Array.isArray(value) ? value.map((entry) => cloneJson(entry)).filter((entry) => entry != null) : [];
}

function cloneAccessPolicy(value) {
  const policy = cloneJson(value) || { locked: false, grants: [] };
  return {
    ...policy,
    grants: cloneObjectArray(policy.grants),
  };
}

function cloneWorkspaceItem(item) {
  return {
    ...item,
    facets: cloneJson(item.facets),
    sourceArtifactIds: cleanArray(item.sourceArtifactIds),
    derivedArtifactIds: cleanArray(item.derivedArtifactIds),
    agentCommentIds: cleanArray(item.agentCommentIds),
    proposalIds: cleanArray(item.proposalIds),
    relationships: cloneObjectArray(item.relationships),
    accessPolicy: cloneAccessPolicy(item.accessPolicy),
  };
}

function cloneProposal(proposal) {
  return {
    ...proposal,
    sourceItemIds: cleanArray(proposal.sourceItemIds),
    sourceArtifactIds: cleanArray(proposal.sourceArtifactIds),
  };
}

function promotableItemType(kind) {
  switch (kind) {
    case "todo":
      return "todo";
    case "calendarBlock":
      return "calendarBlock";
    case "research":
      return "research";
    default:
      throw new Error(`proposal kind cannot be promoted: ${kind}`);
  }
}

function facetsFor(type, input = {}) {
  switch (type) {
    case "note":
      return { note: { kind: "note" } };
    case "todo":
      return {
        todo: {
          status: input.status || "open",
          estimateMinutes: Number.isFinite(input.estimateMinutes) ? input.estimateMinutes : null,
        },
      };
    case "calendarBlock":
      return {
        calendarBlock: {
          startsAt: input.startsAt || null,
          endsAt: input.endsAt || null,
          status: input.status || "draft",
        },
      };
    case "research":
      return { research: { status: input.status || "draft", sourceCount: Number(input.sourceCount || 0) } };
    default:
      throw new Error(`unsupported workspace item type: ${type}`);
  }
}

export function createSourceArtifact(input) {
  const createdAt = input.createdAt || nowIso();
  return {
    schemaVersion: 1,
    id: requiredString(input.id, "source artifact id"),
    kind: requiredString(input.kind, "source artifact kind"),
    body: String(input.body ?? ""),
    media: cloneJson(input.media),
    immutable: true,
    derivedArtifactIds: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export function createDerivedArtifact(input) {
  const createdAt = input.createdAt || nowIso();
  return {
    schemaVersion: 1,
    id: requiredString(input.id, "derived artifact id"),
    kind: requiredString(input.kind, "derived artifact kind"),
    body: String(input.body ?? ""),
    sourceArtifactIds: cleanArray(input.sourceArtifactIds),
    sourceItemIds: cleanArray(input.sourceItemIds),
    createdAt,
    updatedAt: createdAt,
  };
}

export function createWorkspaceItem(input) {
  const type = requiredString(input.type, "workspace item type");
  if (!ITEM_TYPES.has(type)) throw new Error(`unsupported workspace item type: ${type}`);
  const createdAt = input.createdAt || nowIso();
  return {
    schemaVersion: 1,
    id: requiredString(input.id, "workspace item id"),
    type,
    title: requiredString(input.title, "workspace item title"),
    body: String(input.body ?? ""),
    facets: facetsFor(type, input),
    sourceArtifactIds: cleanArray(input.sourceArtifactIds),
    derivedArtifactIds: cleanArray(input.derivedArtifactIds),
    agentCommentIds: cleanArray(input.agentCommentIds),
    proposalIds: cleanArray(input.proposalIds),
    relationships: cloneObjectArray(input.relationships),
    accessPolicy: cloneAccessPolicy(input.accessPolicy),
    createdAt,
    updatedAt: createdAt,
  };
}

export function lockWorkspaceItem(item, { lockedAt = nowIso() } = {}) {
  const nextItem = cloneWorkspaceItem(item);
  const accessPolicy = cloneAccessPolicy(nextItem.accessPolicy);
  return {
    ...nextItem,
    accessPolicy: {
      ...accessPolicy,
      locked: true,
      lockedAt,
      grants: cloneObjectArray(accessPolicy.grants),
    },
    updatedAt: lockedAt,
  };
}

export function unlockWorkspaceItem(item, { unlockedAt = nowIso() } = {}) {
  const nextItem = cloneWorkspaceItem(item);
  const accessPolicy = cloneAccessPolicy(nextItem.accessPolicy);
  return {
    ...nextItem,
    accessPolicy: {
      ...accessPolicy,
      locked: false,
      unlockedAt,
      grants: cloneObjectArray(accessPolicy.grants),
    },
    updatedAt: unlockedAt,
  };
}

export function readItemForBeep(item, { grantIds = [] } = {}) {
  const locked = item.accessPolicy?.locked === true;
  const hasGrant = grantIds.some((grantId) => item.accessPolicy?.grants?.some((grant) => grant.grantId === grantId));
  const contentHidden = locked && !hasGrant;
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    body: contentHidden ? null : item.body,
    facets: cloneJson(item.facets),
    sourceArtifactIds: cleanArray(item.sourceArtifactIds),
    derivedArtifactIds: cleanArray(item.derivedArtifactIds),
    relationships: cloneObjectArray(item.relationships),
    locked,
    contentHidden,
  };
}

export function createAgentComment(input) {
  const createdAt = input.createdAt || nowIso();
  return {
    schemaVersion: 1,
    id: requiredString(input.id, "agent comment id"),
    targetId: requiredString(input.targetId, "agent comment target id"),
    body: requiredString(input.body, "agent comment body"),
    sourceItemIds: cleanArray(input.sourceItemIds),
    sourceArtifactIds: cleanArray(input.sourceArtifactIds),
    uncertainty: cleanString(input.uncertainty),
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
}

export function createProposal(input) {
  const kind = requiredString(input.kind, "proposal kind");
  if (!PROPOSAL_KINDS.has(kind)) throw new Error(`unsupported proposal kind: ${kind}`);
  const createdAt = input.createdAt || nowIso();
  return {
    schemaVersion: 1,
    id: requiredString(input.id, "proposal id"),
    kind,
    title: requiredString(input.title, "proposal title"),
    body: String(input.body ?? ""),
    sourceItemIds: cleanArray(input.sourceItemIds),
    sourceArtifactIds: cleanArray(input.sourceArtifactIds),
    estimateMinutes: Number.isFinite(input.estimateMinutes) ? input.estimateMinutes : null,
    confidence: Number.isFinite(input.confidence) ? input.confidence : null,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

export function acceptProposal(proposal, { itemId, acceptedAt = nowIso() }) {
  if (proposal.status !== "pending") throw new Error(`proposal is not pending: ${proposal.id}`);
  const acceptedProposal = cloneProposal(proposal);
  const type = promotableItemType(proposal.kind);
  const item = createWorkspaceItem({
    id: requiredString(itemId, "accepted item id"),
    type,
    title: proposal.title,
    body: proposal.body,
    estimateMinutes: proposal.estimateMinutes,
    sourceArtifactIds: acceptedProposal.sourceArtifactIds,
    relationships: acceptedProposal.sourceItemIds.map((targetId) => ({ type: "cameFrom", targetId })),
    createdAt: acceptedAt,
  });
  return {
    proposal: {
      ...acceptedProposal,
      status: "accepted",
      acceptedAt,
      promotedItemId: item.id,
      updatedAt: acceptedAt,
    },
    item,
  };
}

export function rejectProposal(proposal, { rejectedAt = nowIso() }) {
  if (proposal.status !== "pending") throw new Error(`proposal is not pending: ${proposal.id}`);
  return {
    ...cloneProposal(proposal),
    status: "rejected",
    rejectedAt,
    updatedAt: rejectedAt,
  };
}
