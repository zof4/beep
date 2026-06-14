import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptProposal,
  createAgentComment,
  createDerivedArtifact,
  createProposal,
  createSourceArtifact,
  createWorkspaceItem,
  lockWorkspaceItem,
  readItemForBeep,
  rejectProposal,
  unlockWorkspaceItem,
} from "../src/notes/workspace-domain.mjs";

const NOW = "2026-06-14T18:00:00.000Z";

test("source artifacts are immutable originals", () => {
  const source = createSourceArtifact({
    id: "src_1",
    kind: "text",
    body: "rough handwritten note",
    createdAt: NOW,
  });

  assert.equal(source.id, "src_1");
  assert.equal(source.kind, "text");
  assert.equal(source.body, "rough handwritten note");
  assert.equal(source.immutable, true);
  assert.deepEqual(source.derivedArtifactIds, []);
});

test("derived artifacts remain separate from source artifacts", () => {
  const derived = createDerivedArtifact({
    id: "derived_1",
    kind: "readableRendition",
    body: "Call Sam about demo timing.",
    sourceArtifactIds: ["src_1"],
    createdAt: NOW,
  });

  assert.equal(derived.id, "derived_1");
  assert.equal(derived.kind, "readableRendition");
  assert.equal(derived.body, "Call Sam about demo timing.");
  assert.deepEqual(derived.sourceArtifactIds, ["src_1"]);
});

test("workspace items support notes and todos as first-class user objects", () => {
  const note = createWorkspaceItem({
    id: "item_note",
    type: "note",
    title: "Project notes",
    body: "Call Sam and plan demo.",
    createdAt: NOW,
  });
  const todo = createWorkspaceItem({
    id: "item_todo",
    type: "todo",
    title: "Call Sam",
    body: "",
    createdAt: NOW,
  });

  assert.equal(note.facets.note.kind, "note");
  assert.equal(todo.facets.todo.status, "open");
  assert.deepEqual(note.agentCommentIds, []);
  assert.deepEqual(todo.proposalIds, []);
});

test("locked items expose metadata but hide content from Beep", () => {
  const item = lockWorkspaceItem(
    createWorkspaceItem({
      id: "item_locked",
      type: "note",
      title: "Private note",
      body: "secret body",
      createdAt: NOW,
    }),
    { lockedAt: NOW },
  );

  const readable = readItemForBeep(item);

  assert.equal(readable.id, "item_locked");
  assert.equal(readable.title, "Private note");
  assert.equal(readable.body, null);
  assert.equal(readable.locked, true);
  assert.equal(readable.contentHidden, true);
});

test("agent comments attach to source items without mutating item body", () => {
  const item = createWorkspaceItem({
    id: "item_note",
    type: "note",
    title: "Planning note",
    body: "Original user text",
    createdAt: NOW,
  });
  const comment = createAgentComment({
    id: "comment_1",
    targetId: item.id,
    body: "This sounds like three tasks.",
    sourceItemIds: [item.id],
    createdAt: NOW,
  });

  assert.equal(item.body, "Original user text");
  assert.equal(comment.targetId, "item_note");
  assert.deepEqual(comment.sourceItemIds, ["item_note"]);
  assert.equal(comment.status, "active");
});

test("proposal accept promotes a draft todo into a workspace item", () => {
  const proposal = createProposal({
    id: "proposal_1",
    kind: "todo",
    title: "Call Sam",
    body: "Ask about demo timing.",
    sourceItemIds: ["item_note"],
    createdAt: NOW,
  });

  const result = acceptProposal(proposal, {
    itemId: "item_promoted",
    acceptedAt: NOW,
  });

  assert.equal(result.proposal.status, "accepted");
  assert.equal(result.item.id, "item_promoted");
  assert.equal(result.item.type, "todo");
  assert.deepEqual(result.item.relationships[0], {
    type: "cameFrom",
    targetId: "item_note",
  });
});

test("proposal accept preserves promotable workspace item kinds", () => {
  for (const [kind, expectedType] of [
    ["calendarBlock", "calendarBlock"],
    ["research", "research"],
  ]) {
    const proposal = createProposal({
      id: `proposal_${kind}`,
      kind,
      title: `${kind} proposal`,
      body: "Promote this.",
      sourceItemIds: ["item_note"],
      createdAt: NOW,
    });

    const result = acceptProposal(proposal, {
      itemId: `item_${kind}`,
      acceptedAt: NOW,
    });

    assert.equal(result.item.type, expectedType);
  }
});

test("proposal reject keeps history but removes active suggestion state", () => {
  const proposal = createProposal({
    id: "proposal_2",
    kind: "research",
    title: "Research options",
    body: "Find relevant references.",
    sourceItemIds: ["item_note"],
    createdAt: NOW,
  });

  const rejected = rejectProposal(proposal, { rejectedAt: NOW });

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectedAt, NOW);
});

test("non-item proposal kinds cannot be promoted into workspace items", () => {
  for (const kind of ["comment", "estimate", "plan"]) {
    const proposal = createProposal({
      id: `proposal_${kind}`,
      kind,
      title: `${kind} suggestion`,
      body: "Needs user review.",
      sourceItemIds: ["item_note"],
      createdAt: NOW,
    });

    assert.throws(
      () =>
        acceptProposal(proposal, {
          itemId: `item_${kind}`,
          acceptedAt: NOW,
        }),
      new RegExp(`proposal kind cannot be promoted: ${kind}`),
    );
  }
});

test("source artifacts clone media and preserve primitive body values", () => {
  const media = { files: [{ id: "file_1", name: "scan.png" }] };
  const source = createSourceArtifact({
    id: "src_media",
    kind: "image",
    body: 0,
    media,
    createdAt: NOW,
  });

  media.files[0].id = "changed";

  assert.equal(source.body, "0");
  assert.notEqual(source.media, media);
  assert.notEqual(source.media.files[0], media.files[0]);
  assert.equal(source.media.files[0].id, "file_1");
});

test("derived artifacts and proposals preserve primitive body values", () => {
  const derived = createDerivedArtifact({
    id: "derived_body",
    kind: "readableRendition",
    body: false,
    createdAt: NOW,
  });
  const proposal = createProposal({
    id: "proposal_body",
    kind: "todo",
    title: "Check body",
    body: 0,
    createdAt: NOW,
  });

  assert.equal(derived.body, "false");
  assert.equal(proposal.body, "0");
});

test("workspace items clone relationship and access policy inputs", () => {
  const relationships = [{ type: "cameFrom", targetId: "source_item" }];
  const accessPolicy = {
    locked: true,
    grants: [{ grantId: "grant_1", principalId: "user_1" }],
  };

  const item = createWorkspaceItem({
    id: "item_clone",
    type: "note",
    title: "Clone inputs",
    body: false,
    relationships,
    accessPolicy,
    createdAt: NOW,
  });

  relationships[0].targetId = "changed_item";
  accessPolicy.grants[0].grantId = "changed_grant";

  assert.equal(item.body, "false");
  assert.deepEqual(item.relationships, [{ type: "cameFrom", targetId: "source_item" }]);
  assert.deepEqual(item.accessPolicy.grants, [{ grantId: "grant_1", principalId: "user_1" }]);
  assert.notEqual(item.relationships[0], relationships[0]);
  assert.notEqual(item.accessPolicy, accessPolicy);
  assert.notEqual(item.accessPolicy.grants[0], accessPolicy.grants[0]);
});

test("lock and unlock copy access policy grants", () => {
  const item = createWorkspaceItem({
    id: "item_lock_copy",
    type: "note",
    title: "Lock copy",
    body: "secret",
    accessPolicy: {
      locked: false,
      grants: [{ grantId: "grant_1" }],
    },
    createdAt: NOW,
  });

  const locked = lockWorkspaceItem(item, { lockedAt: NOW });
  const unlocked = unlockWorkspaceItem(locked, { unlockedAt: NOW });

  locked.accessPolicy.grants[0].grantId = "changed";

  assert.equal(unlocked.accessPolicy.locked, false);
  assert.equal(unlocked.accessPolicy.unlockedAt, NOW);
  assert.deepEqual(item.accessPolicy.grants, [{ grantId: "grant_1" }]);
  assert.deepEqual(unlocked.accessPolicy.grants, [{ grantId: "grant_1" }]);
  assert.notEqual(locked.accessPolicy, item.accessPolicy);
  assert.notEqual(unlocked.accessPolicy, locked.accessPolicy);
  assert.notEqual(locked.accessPolicy.grants, item.accessPolicy.grants);
  assert.notEqual(unlocked.accessPolicy.grants, locked.accessPolicy.grants);
});

test("lock and unlock returned items cannot mutate their input items", () => {
  const item = createWorkspaceItem({
    id: "item_transition_copy",
    type: "todo",
    title: "Transition copy",
    body: "Original body",
    sourceArtifactIds: ["src_1"],
    derivedArtifactIds: ["derived_1"],
    agentCommentIds: ["comment_1"],
    proposalIds: ["proposal_1"],
    relationships: [{ type: "cameFrom", targetId: "item_note" }],
    createdAt: NOW,
  });

  const locked = lockWorkspaceItem(item, { lockedAt: NOW });

  locked.facets.todo.status = "done";
  locked.sourceArtifactIds.push("src_2");
  locked.derivedArtifactIds.push("derived_2");
  locked.agentCommentIds.push("comment_2");
  locked.proposalIds.push("proposal_2");
  locked.relationships[0].targetId = "changed";

  assert.equal(item.facets.todo.status, "open");
  assert.deepEqual(item.sourceArtifactIds, ["src_1"]);
  assert.deepEqual(item.derivedArtifactIds, ["derived_1"]);
  assert.deepEqual(item.agentCommentIds, ["comment_1"]);
  assert.deepEqual(item.proposalIds, ["proposal_1"]);
  assert.deepEqual(item.relationships, [{ type: "cameFrom", targetId: "item_note" }]);

  const unlocked = unlockWorkspaceItem(locked, { unlockedAt: NOW });

  unlocked.facets.todo.status = "blocked";
  unlocked.sourceArtifactIds.push("src_3");
  unlocked.relationships[0].targetId = "unlocked_changed";

  assert.equal(locked.facets.todo.status, "done");
  assert.deepEqual(locked.sourceArtifactIds, ["src_1", "src_2"]);
  assert.deepEqual(locked.relationships, [{ type: "cameFrom", targetId: "changed" }]);
});

test("grant-allowed Beep reads expose locked content", () => {
  const item = lockWorkspaceItem(
    createWorkspaceItem({
      id: "item_grant",
      type: "note",
      title: "Granted note",
      body: "visible to grant",
      accessPolicy: {
        locked: false,
        grants: [{ grantId: "grant_1" }],
      },
      createdAt: NOW,
    }),
    { lockedAt: NOW },
  );

  const readable = readItemForBeep(item, { grantIds: ["grant_1"] });

  assert.equal(readable.body, "visible to grant");
  assert.equal(readable.locked, true);
  assert.equal(readable.contentHidden, false);
});

test("Beep read projections cannot mutate workspace item nested fields", () => {
  const item = createWorkspaceItem({
    id: "item_projection",
    type: "todo",
    title: "Projection copy",
    body: "Original body",
    estimateMinutes: 15,
    sourceArtifactIds: ["src_1"],
    derivedArtifactIds: ["derived_1"],
    relationships: [{ type: "cameFrom", targetId: "item_note" }],
    createdAt: NOW,
  });

  const readable = readItemForBeep(item);

  readable.facets.todo.status = "done";
  readable.sourceArtifactIds.push("src_2");
  readable.derivedArtifactIds.push("derived_2");
  readable.relationships[0].targetId = "changed";

  assert.equal(item.facets.todo.status, "open");
  assert.deepEqual(item.sourceArtifactIds, ["src_1"]);
  assert.deepEqual(item.derivedArtifactIds, ["derived_1"]);
  assert.deepEqual(item.relationships, [{ type: "cameFrom", targetId: "item_note" }]);
});

test("id arrays drop nullish and whitespace-only entries while trimming ids", () => {
  const derived = createDerivedArtifact({
    id: "derived_clean",
    kind: "readableRendition",
    body: "Clean ids",
    sourceArtifactIds: [" src_1 ", null, undefined, "", "   ", 0, false, "src_2"],
    createdAt: NOW,
  });

  assert.deepEqual(derived.sourceArtifactIds, ["src_1", "0", "false", "src_2"]);
});

test("non-pending proposals cannot be accepted or rejected again", () => {
  const proposal = createProposal({
    id: "proposal_done",
    kind: "todo",
    title: "Call Sam",
    body: "Ask about timing.",
    sourceItemIds: ["item_note"],
    createdAt: NOW,
  });
  const accepted = acceptProposal(proposal, {
    itemId: "item_done",
    acceptedAt: NOW,
  }).proposal;
  const rejected = rejectProposal(
    createProposal({
      id: "proposal_rejected",
      kind: "todo",
      title: "Archive note",
      body: "No longer relevant.",
      createdAt: NOW,
    }),
    { rejectedAt: NOW },
  );

  assert.throws(
    () =>
      acceptProposal(accepted, {
        itemId: "item_again",
        acceptedAt: NOW,
      }),
    /proposal is not pending: proposal_done/,
  );
  assert.throws(
    () => rejectProposal(rejected, { rejectedAt: NOW }),
    /proposal is not pending: proposal_rejected/,
  );
  assert.throws(
    () =>
      acceptProposal(rejected, {
        itemId: "item_rejected",
        acceptedAt: NOW,
      }),
    /proposal is not pending: proposal_rejected/,
  );
  assert.throws(
    () => rejectProposal(accepted, { rejectedAt: NOW }),
    /proposal is not pending: proposal_done/,
  );
});

test("accepted proposal output cannot mutate the original proposal", () => {
  const proposal = createProposal({
    id: "proposal_accept_copy",
    kind: "todo",
    title: "Copy proposal",
    body: "Promote safely.",
    sourceItemIds: ["item_note"],
    sourceArtifactIds: ["src_1"],
    createdAt: NOW,
  });

  const accepted = acceptProposal(proposal, {
    itemId: "item_accept_copy",
    acceptedAt: NOW,
  }).proposal;

  accepted.sourceItemIds.push("item_changed");
  accepted.sourceArtifactIds.push("src_changed");

  assert.deepEqual(proposal.sourceItemIds, ["item_note"]);
  assert.deepEqual(proposal.sourceArtifactIds, ["src_1"]);
});

test("rejected proposal output cannot mutate the original proposal", () => {
  const proposal = createProposal({
    id: "proposal_reject_copy",
    kind: "research",
    title: "Reject safely",
    body: "Keep original intact.",
    sourceItemIds: ["item_note"],
    sourceArtifactIds: ["src_1"],
    createdAt: NOW,
  });

  const rejected = rejectProposal(proposal, { rejectedAt: NOW });

  rejected.sourceItemIds.push("item_changed");
  rejected.sourceArtifactIds.push("src_changed");

  assert.deepEqual(proposal.sourceItemIds, ["item_note"]);
  assert.deepEqual(proposal.sourceArtifactIds, ["src_1"]);
});
