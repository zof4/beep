import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";
import {
  DEFAULT_HANDWRITING_PROFILE_ID,
  DEFAULT_HANDWRITING_PROMPT_ID,
  createDefaultHandwritingPrompt,
} from "../src/notes/handwriting-domain.mjs";
import { NotesWorkspaceStore } from "../src/notes/workspace-store.mjs";

const UNSAFE_IDS = ["__proto__", "prototype", "constructor"];
const PROTOTYPE_LINK_FIELDS = ["agentCommentIds", "derivedArtifactIds", "proposalIds", "updatedAt"];
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

function tempNotesStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-notes-store-test-"));
  const stateStore = new StateStore(dir);
  const notesStore = new NotesWorkspaceStore({ store: stateStore, now: () => "2026-06-14T18:00:00.000Z" });
  return {
    notesStore,
    stateStore,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function withTempNotesStore(callback) {
  const { notesStore, stateStore, cleanup } = tempNotesStore();
  try {
    return callback(notesStore, stateStore);
  } finally {
    cleanup();
  }
}

function clearPrototypeWorkspaceLinks() {
  for (const field of PROTOTYPE_LINK_FIELDS) {
    delete Object.prototype[field];
  }
}

function assertPrototypeWorkspaceLinksClean() {
  for (const field of PROTOTYPE_LINK_FIELDS) {
    assert.equal(Object.hasOwn(Object.prototype, field), false);
  }
}

function withCleanPrototypeWorkspaceLinks(callback) {
  clearPrototypeWorkspaceLinks();
  try {
    return callback();
  } finally {
    clearPrototypeWorkspaceLinks();
  }
}

function withObjectPrototypeRecords(records, callback) {
  const fields = Object.keys(records);
  for (const field of fields) delete Object.prototype[field];
  try {
    for (const [field, value] of Object.entries(records)) {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    }
    return callback();
  } finally {
    for (const field of fields) delete Object.prototype[field];
  }
}

function createHandwritingImageSource(notesStore, id = "src_hw_sample") {
  return notesStore.createSourceArtifact({
    id,
    kind: "image",
    media: {
      schemaVersion: 1,
      files: [
        {
          kind: "image",
          name: "sample.png",
          mimeType: "image/png",
          sizeBytes: 100,
          workspacePath: "notes-captures/sample.png",
        },
      ],
    },
  });
}

test("workspace store creates notes and todos", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const todo = notesStore.createItem({ type: "todo", title: "Call Sam", body: "" });

    const workspace = notesStore.readWorkspace();

    assert.equal(note.type, "note");
    assert.equal(todo.type, "todo");
    assert.deepEqual(workspace.itemOrder, [note.id, todo.id]);
    assert.equal(workspace.items[note.id].body, "Call Sam");
  } finally {
    cleanup();
  }
});

test("workspace store normalizes inherited top-level notes fields without touching getters", () => {
  const { notesStore, stateStore, cleanup } = tempNotesStore();
  let getterCount = 0;
  try {
    stateStore.update((state) => {
      state.notesBackbone = {};
    });

    for (const field of [...NOTES_OBJECT_MAP_FIELDS, ...NOTES_ARRAY_FIELDS]) {
      Object.defineProperty(Object.prototype, field, {
        configurable: true,
        get() {
          getterCount += 1;
          return NOTES_ARRAY_FIELDS.includes(field) ? [] : {};
        },
      });
    }

    const workspace = notesStore.readWorkspace();

    assert.equal(getterCount, 0);
    for (const field of NOTES_OBJECT_MAP_FIELDS) {
      assert.equal(Object.hasOwn(workspace, field), true);
      if (field === "handwritingProfiles") {
        assert.equal(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].id, DEFAULT_HANDWRITING_PROFILE_ID);
      } else if (field === "handwritingPrompts") {
        assert.equal(workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID].id, DEFAULT_HANDWRITING_PROMPT_ID);
      } else {
        assert.deepEqual(workspace[field], {});
      }
    }
    for (const field of NOTES_ARRAY_FIELDS) {
      assert.equal(Object.hasOwn(workspace, field), true);
      if (field === "handwritingPromptOrder") {
        assert.deepEqual(workspace.handwritingPromptOrder, [DEFAULT_HANDWRITING_PROMPT_ID]);
      } else {
        assert.deepEqual(workspace[field], []);
      }
    }
  } finally {
    for (const field of [...NOTES_OBJECT_MAP_FIELDS, ...NOTES_ARRAY_FIELDS]) {
      delete Object.prototype[field];
    }
    cleanup();
  }
});

test("workspace store rejects unsafe item ids", () => {
  for (const unsafeId of UNSAFE_IDS) {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () => notesStore.createItem({ id: unsafeId, type: "note", title: "Inbox", body: "Call Sam" }),
        new RegExp(`unsafe state map key: ${unsafeId}`),
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.items, unsafeId), false);
      assert.deepEqual(workspace.itemOrder, []);
    });
  }
});

test("workspace store rejects unsafe item reference ids", () => {
  for (const field of ["sourceArtifactIds", "derivedArtifactIds", "agentCommentIds", "proposalIds"]) {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () =>
          notesStore.createItem({
            id: `item_unsafe_${field}`,
            type: "note",
            title: "Inbox",
            body: "Call Sam",
            [field]: ["__proto__"],
          }),
        /unsafe state map key: __proto__/,
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.items, `item_unsafe_${field}`), false);
      assert.deepEqual(workspace.itemOrder, []);
    });
  }
});

test("workspace store rejects blank item reference ids", () => {
  for (const field of ["sourceArtifactIds", "derivedArtifactIds", "agentCommentIds", "proposalIds"]) {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () =>
          notesStore.createItem({
            id: `item_blank_${field}`,
            type: "note",
            title: "Inbox",
            body: "Call Sam",
            [field]: ["   "],
          }),
        /is required/,
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.items, `item_blank_${field}`), false);
      assert.deepEqual(workspace.itemOrder, []);
    });
  }
});

test("workspace store canonicalizes item reference ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({
      id: "item_refs",
      type: "note",
      title: "Inbox",
      body: "Call Sam",
      sourceArtifactIds: [" src_ref "],
      derivedArtifactIds: [" derived_ref "],
      agentCommentIds: [" comment_ref "],
      proposalIds: [" proposal_ref "],
    });
    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.items[item.id].sourceArtifactIds, ["src_ref"]);
    assert.deepEqual(workspace.items[item.id].derivedArtifactIds, ["derived_ref"]);
    assert.deepEqual(workspace.items[item.id].agentCommentIds, ["comment_ref"]);
    assert.deepEqual(workspace.items[item.id].proposalIds, ["proposal_ref"]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects duplicate item ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({ id: "item_fixed", type: "note", title: "Inbox", body: "Call Sam" });

    assert.throws(
      () => notesStore.createItem({ id: item.id, type: "todo", title: "Call Sam", body: "duplicate" }),
      /duplicate workspace item id: item_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.itemOrder, [item.id]);
    assert.equal(workspace.items[item.id].type, "note");
    assert.equal(workspace.items[item.id].body, "Call Sam");
  } finally {
    cleanup();
  }
});

test("workspace store rejects whitespace-wrapped duplicate item ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({ id: "item_fixed", type: "note", title: "Inbox", body: "Call Sam" });

    assert.throws(
      () => notesStore.createItem({ id: " item_fixed ", type: "todo", title: "Call Sam", body: "duplicate" }),
      /duplicate workspace item id: item_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.itemOrder, [item.id]);
    assert.equal(workspace.items[item.id].type, "note");
    assert.equal(workspace.items[item.id].body, "Call Sam");
  } finally {
    cleanup();
  }
});

test("workspace store canonicalizes public item ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({ id: "item_public", type: "note", title: "Inbox", body: "Call Sam" });

    assert.equal(notesStore.getItem(" item_public ").id, item.id);

    const locked = notesStore.lockItem(" item_public ");
    assert.equal(locked.accessPolicy.locked, true);
    assert.equal(notesStore.getItem(item.id).accessPolicy.locked, true);

    const unlocked = notesStore.unlockItem(" item_public ");
    assert.equal(unlocked.accessPolicy.locked, false);
    assert.equal(notesStore.getItem(item.id).accessPolicy.locked, false);
  } finally {
    cleanup();
  }
});

test("workspace store attaches comments and proposals to source items", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const comment = notesStore.createComment({
      targetId: note.id,
      body: "This has one clear follow-up.",
      sourceItemIds: [note.id],
    });
    const proposal = notesStore.createProposal({
      kind: "todo",
      title: "Call Sam",
      body: "Ask about demo timing.",
      sourceItemIds: [note.id],
    });

    const stored = notesStore.getItem(note.id);

    assert.deepEqual(stored.agentCommentIds, [comment.id]);
    assert.deepEqual(stored.proposalIds, [proposal.id]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects unsafe comment ids", () => {
  for (const unsafeId of UNSAFE_IDS) {
    withTempNotesStore((notesStore) => {
      const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });

      assert.throws(
        () =>
          notesStore.createComment({
            id: unsafeId,
            targetId: note.id,
            body: "Unsafe comment.",
            sourceItemIds: [note.id],
          }),
        new RegExp(`unsafe state map key: ${unsafeId}`),
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.comments, unsafeId), false);
      assert.deepEqual(workspace.items[note.id].agentCommentIds, []);
    });
  }
});

test("workspace store rejects unsafe comment target ids before map lookup", () => {
  withCleanPrototypeWorkspaceLinks(() => {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () =>
          notesStore.createComment({
            id: "comment_unsafe_target",
            targetId: "__proto__",
            body: "Unsafe target.",
            sourceItemIds: [],
          }),
        /unsafe state map key: __proto__/,
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.comments, "comment_unsafe_target"), false);
      assert.deepEqual(workspace.itemOrder, []);
      assertPrototypeWorkspaceLinksClean();
    });
  });
});

test("workspace store canonicalizes comment target ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ id: "item_comment_ref", type: "note", title: "Inbox", body: "Call Sam" });
    const comment = notesStore.createComment({
      id: "comment_ref",
      targetId: " item_comment_ref ",
      body: "This has one clear follow-up.",
      sourceItemIds: [note.id],
    });
    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.comments[comment.id].targetId, note.id);
    assert.deepEqual(workspace.items[note.id].agentCommentIds, [comment.id]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects duplicate comment ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const comment = notesStore.createComment({
      id: "comment_fixed",
      targetId: note.id,
      body: "Original comment.",
      sourceItemIds: [note.id],
    });

    assert.throws(
      () =>
        notesStore.createComment({
          id: " comment_fixed ",
          targetId: note.id,
          body: "Replacement comment.",
          sourceItemIds: [note.id],
        }),
      /duplicate comment id: comment_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.comments[comment.id].body, "Original comment.");
    assert.deepEqual(workspace.items[note.id].agentCommentIds, [comment.id]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects unsafe proposal ids", () => {
  for (const unsafeId of UNSAFE_IDS) {
    withTempNotesStore((notesStore) => {
      const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });

      assert.throws(
        () =>
          notesStore.createProposal({
            id: unsafeId,
            kind: "todo",
            title: "Call Sam",
            body: "Unsafe proposal.",
            sourceItemIds: [note.id],
          }),
        new RegExp(`unsafe state map key: ${unsafeId}`),
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.proposals, unsafeId), false);
      assert.deepEqual(workspace.items[note.id].proposalIds, []);
    });
  }
});

test("workspace store rejects unsafe proposal source item ids before map lookup", () => {
  withCleanPrototypeWorkspaceLinks(() => {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () =>
          notesStore.createProposal({
            id: "proposal_unsafe_source",
            kind: "todo",
            title: "Call Sam",
            body: "Unsafe source.",
            sourceItemIds: ["__proto__"],
          }),
        /unsafe state map key: __proto__/,
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.proposals, "proposal_unsafe_source"), false);
      assert.deepEqual(workspace.itemOrder, []);
      assertPrototypeWorkspaceLinksClean();
    });
  });
});

test("workspace store rejects blank reference ids before mutation", () => {
  for (const { name, create } of [
    {
      name: "derived source artifacts",
      create: (notesStore) =>
        notesStore.createDerivedArtifact({
          id: "derived_blank_source_artifact",
          kind: "readableRendition",
          body: "Clean note",
          sourceArtifactIds: ["   "],
        }),
    },
    {
      name: "derived source items",
      create: (notesStore) =>
        notesStore.createDerivedArtifact({
          id: "derived_blank_source_item",
          kind: "readableRendition",
          body: "Clean note",
          sourceItemIds: ["   "],
        }),
    },
    {
      name: "comment source items",
      create: (notesStore, note) =>
        notesStore.createComment({
          id: "comment_blank_source_item",
          targetId: note.id,
          body: "Blank source.",
          sourceItemIds: ["   "],
        }),
    },
    {
      name: "comment source artifacts",
      create: (notesStore, note) =>
        notesStore.createComment({
          id: "comment_blank_source_artifact",
          targetId: note.id,
          body: "Blank source.",
          sourceArtifactIds: ["   "],
        }),
    },
    {
      name: "proposal source items",
      create: (notesStore, note) =>
        notesStore.createProposal({
          id: "proposal_blank_source_item",
          kind: "todo",
          title: "Call Sam",
          body: "Blank source.",
          sourceItemIds: ["   "],
        }),
    },
    {
      name: "proposal source artifacts",
      create: (notesStore, note) =>
        notesStore.createProposal({
          id: "proposal_blank_source_artifact",
          kind: "todo",
          title: "Call Sam",
          body: "Blank source.",
          sourceArtifactIds: ["   "],
        }),
    },
  ]) {
    withTempNotesStore((notesStore) => {
      const note = notesStore.createItem({ id: `item_${name.replaceAll(" ", "_")}`, type: "note", title: "Inbox", body: "" });

      assert.throws(() => create(notesStore, note), /is required/);

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.keys(workspace.derivedArtifacts).length, 0);
      assert.equal(Object.keys(workspace.comments).length, 0);
      assert.equal(Object.keys(workspace.proposals).length, 0);
      assert.deepEqual(workspace.items[note.id].agentCommentIds, []);
      assert.deepEqual(workspace.items[note.id].proposalIds, []);
    });
  }
});

test("workspace store canonicalizes proposal source item ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ id: "item_proposal_ref", type: "note", title: "Inbox", body: "Call Sam" });
    const proposal = notesStore.createProposal({
      id: "proposal_ref",
      kind: "todo",
      title: "Call Sam",
      body: "Ask about demo timing.",
      sourceItemIds: [" item_proposal_ref "],
    });
    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.proposals[proposal.id].sourceItemIds, [note.id]);
    assert.deepEqual(workspace.items[note.id].proposalIds, [proposal.id]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects duplicate proposal ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const proposal = notesStore.createProposal({
      id: "proposal_fixed",
      kind: "todo",
      title: "Call Sam",
      body: "Original proposal.",
      sourceItemIds: [note.id],
    });

    assert.throws(
      () =>
        notesStore.createProposal({
          id: " proposal_fixed ",
          kind: "research",
          title: "Research Sam",
          body: "Replacement proposal.",
          sourceItemIds: [note.id],
        }),
      /duplicate proposal id: proposal_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.proposals[proposal.id].kind, "todo");
    assert.equal(workspace.proposals[proposal.id].body, "Original proposal.");
    assert.deepEqual(workspace.items[note.id].proposalIds, [proposal.id]);
  } finally {
    cleanup();
  }
});

test("workspace store canonicalizes public proposal ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const accepted = notesStore.createProposal({
      kind: "todo",
      title: "Call Sam",
      body: "Ask about demo timing.",
      sourceItemIds: [note.id],
    });
    const rejected = notesStore.createProposal({
      kind: "research",
      title: "Research Sam context",
      body: "",
      sourceItemIds: [note.id],
    });

    const promoted = notesStore.acceptProposal(` ${accepted.id} `);
    const rejectedProposal = notesStore.rejectProposal(` ${rejected.id} `);
    const workspace = notesStore.readWorkspace();

    assert.equal(promoted.proposal.status, "accepted");
    assert.equal(workspace.proposals[accepted.id].status, "accepted");
    assert.equal(rejectedProposal.status, "rejected");
    assert.equal(workspace.proposals[rejected.id].status, "rejected");
  } finally {
    cleanup();
  }
});

test("workspace store public update methods do not touch inherited map getters", () => {
  const { notesStore, cleanup } = tempNotesStore();
  let proposalGetterCount = 0;
  let itemGetterCount = 0;
  try {
    Object.defineProperty(Object.prototype, "ghost_proposal", {
      configurable: true,
      get() {
        proposalGetterCount += 1;
        return undefined;
      },
    });
    Object.defineProperty(Object.prototype, "ghost_item", {
      configurable: true,
      get() {
        itemGetterCount += 1;
        return undefined;
      },
    });

    assert.throws(() => notesStore.acceptProposal("ghost_proposal"), /unknown proposal: ghost_proposal/);
    assert.throws(() => notesStore.rejectProposal("ghost_proposal"), /unknown proposal: ghost_proposal/);
    assert.throws(() => notesStore.lockItem("ghost_item"), /unknown item: ghost_item/);
    assert.throws(() => notesStore.unlockItem("ghost_item"), /unknown item: ghost_item/);

    assert.equal(proposalGetterCount, 0);
    assert.equal(itemGetterCount, 0);
  } finally {
    delete Object.prototype.ghost_proposal;
    delete Object.prototype.ghost_item;
    cleanup();
  }
});

test("workspace store accepts and rejects proposals", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const note = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const accepted = notesStore.createProposal({
      kind: "todo",
      title: "Call Sam",
      body: "Ask about demo timing.",
      sourceItemIds: [note.id],
    });
    const rejected = notesStore.createProposal({
      kind: "research",
      title: "Research Sam context",
      body: "",
      sourceItemIds: [note.id],
    });

    const promoted = notesStore.acceptProposal(accepted.id);
    const rejectedProposal = notesStore.rejectProposal(rejected.id);

    assert.equal(promoted.proposal.status, "accepted");
    assert.equal(promoted.item.type, "todo");
    assert.equal(rejectedProposal.status, "rejected");
  } finally {
    cleanup();
  }
});

test("workspace store persists item lock and unlock state", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({ type: "note", title: "Private", body: "Do not share" });

    const locked = notesStore.lockItem(item.id);
    const storedLocked = notesStore.getItem(item.id);

    assert.equal(locked.accessPolicy.locked, true);
    assert.equal(storedLocked.accessPolicy.locked, true);
    assert.equal(storedLocked.accessPolicy.lockedAt, "2026-06-14T18:00:00.000Z");

    const unlocked = notesStore.unlockItem(item.id);
    const storedUnlocked = notesStore.getItem(item.id);

    assert.equal(unlocked.accessPolicy.locked, false);
    assert.equal(storedUnlocked.accessPolicy.locked, false);
    assert.equal(storedUnlocked.accessPolicy.unlockedAt, "2026-06-14T18:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("workspace store creates immutable source artifacts", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({ kind: "text", body: "messy note" });
    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.sourceArtifacts[source.id].immutable, true);
    assert.equal(workspace.sourceOrder[0], source.id);
  } finally {
    cleanup();
  }
});

test("workspace store rejects unsafe source artifact ids", () => {
  for (const unsafeId of UNSAFE_IDS) {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () => notesStore.createSourceArtifact({ id: unsafeId, kind: "text", body: "messy note" }),
        new RegExp(`unsafe state map key: ${unsafeId}`),
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.sourceArtifacts, unsafeId), false);
      assert.deepEqual(workspace.sourceOrder, []);
    });
  }
});

test("workspace store rejects duplicate source artifact ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({ id: "src_fixed", kind: "text", body: "messy note" });

    assert.throws(
      () => notesStore.createSourceArtifact({ id: source.id, kind: "text", body: "replacement" }),
      /duplicate source artifact id: src_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.sourceOrder, [source.id]);
    assert.equal(workspace.sourceArtifacts[source.id].body, "messy note");
  } finally {
    cleanup();
  }
});

test("workspace store rejects whitespace-wrapped duplicate source artifact ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({ id: "src_fixed", kind: "text", body: "messy note" });

    assert.throws(
      () => notesStore.createSourceArtifact({ id: " src_fixed ", kind: "text", body: "replacement" }),
      /duplicate source artifact id: src_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.sourceOrder, [source.id]);
    assert.equal(workspace.sourceArtifacts[source.id].body, "messy note");
  } finally {
    cleanup();
  }
});

test("workspace store creates derived artifacts linked to sources", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({ kind: "text", body: "messy note" });
    const derived = notesStore.createDerivedArtifact({
      kind: "readableRendition",
      body: "Clean note",
      sourceArtifactIds: [source.id],
    });
    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.derivedArtifacts[derived.id].body, "Clean note");
    assert.deepEqual(workspace.sourceArtifacts[source.id].derivedArtifactIds, [derived.id]);
  } finally {
    cleanup();
  }
});

test("workspace store creates derived artifacts linked to source items", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const derived = notesStore.createDerivedArtifact({
      kind: "readableRendition",
      body: "Clean note",
      sourceItemIds: [item.id],
    });
    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.derivedArtifacts[derived.id].body, "Clean note");
    assert.deepEqual(workspace.derivedArtifacts[derived.id].sourceItemIds, [item.id]);
    assert.deepEqual(workspace.items[item.id].derivedArtifactIds, [derived.id]);
  } finally {
    cleanup();
  }
});

test("workspace store source linkage ignores inherited derived artifact id getters", () => {
  withCleanPrototypeWorkspaceLinks(() => {
    const { notesStore, stateStore, cleanup } = tempNotesStore();
    let getterCount = 0;
    try {
      const source = notesStore.createSourceArtifact({ id: "src_malformed_links", kind: "text", body: "messy note" });
      stateStore.update((state) => {
        delete state.notesBackbone.sourceArtifacts[source.id].derivedArtifactIds;
      });
      Object.defineProperty(Object.prototype, "derivedArtifactIds", {
        configurable: true,
        get() {
          getterCount += 1;
          return ["inherited_derived"];
        },
      });

      const derived = notesStore.createDerivedArtifact({
        id: "derived_malformed_source_link",
        kind: "readableRendition",
        body: "Clean note",
        sourceArtifactIds: [source.id],
      });

      assert.equal(getterCount, 0);
      assert.deepEqual(notesStore.readWorkspace().sourceArtifacts[source.id].derivedArtifactIds, [derived.id]);
    } finally {
      cleanup();
    }
  });
});

test("workspace store rejects unsafe derived artifact ids", () => {
  for (const unsafeId of UNSAFE_IDS) {
    withTempNotesStore((notesStore) => {
      const source = notesStore.createSourceArtifact({ kind: "text", body: "messy note" });

      assert.throws(
        () =>
          notesStore.createDerivedArtifact({
            id: unsafeId,
            kind: "readableRendition",
            body: "Unsafe derived artifact.",
            sourceArtifactIds: [source.id],
          }),
        new RegExp(`unsafe state map key: ${unsafeId}`),
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.derivedArtifacts, unsafeId), false);
      assert.deepEqual(workspace.sourceArtifacts[source.id].derivedArtifactIds, []);
    });
  }
});

test("workspace store rejects unsafe derived source artifact ids before map lookup", () => {
  withCleanPrototypeWorkspaceLinks(() => {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () =>
          notesStore.createDerivedArtifact({
            id: "derived_unsafe_source",
            kind: "readableRendition",
            body: "Unsafe source.",
            sourceArtifactIds: ["__proto__"],
          }),
        /unsafe state map key: __proto__/,
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.derivedArtifacts, "derived_unsafe_source"), false);
      assert.deepEqual(workspace.sourceOrder, []);
      assertPrototypeWorkspaceLinksClean();
    });
  });
});

test("workspace store canonicalizes derived source artifact ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({ id: "src_derived_ref", kind: "text", body: "messy note" });
    const derived = notesStore.createDerivedArtifact({
      id: "derived_ref",
      kind: "readableRendition",
      body: "Clean note",
      sourceArtifactIds: [" src_derived_ref "],
    });
    const workspace = notesStore.readWorkspace();

    assert.deepEqual(workspace.derivedArtifacts[derived.id].sourceArtifactIds, [source.id]);
    assert.deepEqual(workspace.sourceArtifacts[source.id].derivedArtifactIds, [derived.id]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects duplicate derived artifact ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({ kind: "text", body: "messy note" });
    const derived = notesStore.createDerivedArtifact({
      id: "derived_fixed",
      kind: "readableRendition",
      body: "Clean note",
      sourceArtifactIds: [source.id],
    });

    assert.throws(
      () =>
        notesStore.createDerivedArtifact({
          id: " derived_fixed ",
          kind: "readableRendition",
          body: "Replacement note",
          sourceArtifactIds: [source.id],
        }),
      /duplicate derived artifact id: derived_fixed/,
    );

    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.derivedArtifacts[derived.id].body, "Clean note");
    assert.deepEqual(workspace.sourceArtifacts[source.id].derivedArtifactIds, [derived.id]);
  } finally {
    cleanup();
  }
});

test("workspace store item linkage ignores inherited comment and proposal id getters", () => {
  withCleanPrototypeWorkspaceLinks(() => {
    const { notesStore, stateStore, cleanup } = tempNotesStore();
    let agentCommentGetterCount = 0;
    let proposalGetterCount = 0;
    try {
      const item = notesStore.createItem({ id: "item_malformed_links", type: "note", title: "Inbox", body: "Call Sam" });
      stateStore.update((state) => {
        delete state.notesBackbone.items[item.id].agentCommentIds;
        delete state.notesBackbone.items[item.id].proposalIds;
      });
      Object.defineProperty(Object.prototype, "agentCommentIds", {
        configurable: true,
        get() {
          agentCommentGetterCount += 1;
          return ["inherited_comment"];
        },
      });
      Object.defineProperty(Object.prototype, "proposalIds", {
        configurable: true,
        get() {
          proposalGetterCount += 1;
          return ["inherited_proposal"];
        },
      });

      const comment = notesStore.createComment({
        id: "comment_malformed_item_link",
        targetId: item.id,
        body: "This has one clear follow-up.",
        sourceItemIds: [item.id],
      });
      const proposal = notesStore.createProposal({
        id: "proposal_malformed_item_link",
        kind: "todo",
        title: "Call Sam",
        body: "Ask about demo timing.",
        sourceItemIds: [item.id],
      });

      const stored = notesStore.getItem(item.id);

      assert.equal(agentCommentGetterCount, 0);
      assert.equal(proposalGetterCount, 0);
      assert.deepEqual(stored.agentCommentIds, [comment.id]);
      assert.deepEqual(stored.proposalIds, [proposal.id]);
    } finally {
      cleanup();
    }
  });
});

test("workspace store rejects unsafe run ids", () => {
  for (const unsafeId of UNSAFE_IDS) {
    withTempNotesStore((notesStore) => {
      assert.throws(
        () => notesStore.upsertRun({ id: unsafeId, status: "started", createdAt: "2026-06-14T18:00:00.000Z" }),
        new RegExp(`unsafe state map key: ${unsafeId}`),
      );

      const workspace = notesStore.readWorkspace();

      assert.equal(Object.hasOwn(workspace.runs, unsafeId), false);
      assert.deepEqual(workspace.runOrder, []);
    });
  }
});

test("workspace store upserts runs without duplicating run order", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    notesStore.upsertRun({ id: "run_1", status: "started", createdAt: "2026-06-14T18:00:00.000Z" });
    notesStore.upsertRun({ id: "run_1", status: "finished", createdAt: "2026-06-14T18:00:00.000Z" });

    const workspace = notesStore.readWorkspace();

    assert.equal(workspace.runs.run_1.status, "finished");
    assert.deepEqual(workspace.runOrder, ["run_1"]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects missing and blank run ids", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    assert.throws(
      () => notesStore.upsertRun({ status: "started", createdAt: "2026-06-14T18:00:00.000Z" }),
      /run id is required/,
    );
    assert.throws(
      () => notesStore.upsertRun({ id: "   ", status: "started", createdAt: "2026-06-14T18:00:00.000Z" }),
      /run id is required/,
    );

    const workspace = notesStore.readWorkspace();

    assert.equal(Object.hasOwn(workspace.runs, "undefined"), false);
    assert.equal(Object.hasOwn(workspace.runs, ""), false);
    assert.deepEqual(workspace.runOrder, []);
  } finally {
    cleanup();
  }
});

test("workspace store seeds default handwriting profile and prompt", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const workspace = notesStore.readWorkspace();

    assert.equal(
      workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].id,
      DEFAULT_HANDWRITING_PROFILE_ID,
    );
    assert.equal(workspace.handwritingPrompts[DEFAULT_HANDWRITING_PROMPT_ID].id, DEFAULT_HANDWRITING_PROMPT_ID);
    assert.deepEqual(workspace.handwritingSampleOrder, []);
    assert.deepEqual(workspace.handwritingPromptOrder, [DEFAULT_HANDWRITING_PROMPT_ID]);
  } finally {
    cleanup();
  }
});

test("workspace store creates handwriting samples linked to source artifacts", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({
      id: "src_hw_sample",
      kind: "image",
      body: "handwriting calibration sample",
      media: {
        schemaVersion: 1,
        files: [
          {
            kind: "image",
            name: "sample.png",
            mimeType: "image/png",
            sizeBytes: 100,
            workspacePath: "notes-captures/sample.png",
          },
        ],
      },
    });

    const prompt = createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" });
    const sample = notesStore.createHandwritingSample({
      id: "hw_sample_1",
      profileId: DEFAULT_HANDWRITING_PROFILE_ID,
      prompt,
      sourceArtifactId: source.id,
      image: source.media.files[0],
    });

    const workspace = notesStore.readWorkspace();
    assert.equal(sample.referenceText, prompt.referenceText);
    assert.equal(workspace.handwritingSamples.hw_sample_1.sourceArtifactId, "src_hw_sample");
    assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, ["hw_sample_1"]);
    assert.deepEqual(workspace.handwritingSampleOrder, ["hw_sample_1"]);
  } finally {
    cleanup();
  }
});

test("workspace store toggles handwriting sample active state", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const source = notesStore.createSourceArtifact({
      id: "src_hw_sample",
      kind: "image",
      media: {
        schemaVersion: 1,
        files: [
          {
            kind: "image",
            name: "sample.png",
            mimeType: "image/png",
            sizeBytes: 100,
            workspacePath: "notes-captures/sample.png",
          },
        ],
      },
    });
    const prompt = createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" });
    notesStore.createHandwritingSample({
      id: "hw_sample_1",
      profileId: DEFAULT_HANDWRITING_PROFILE_ID,
      prompt,
      sourceArtifactId: source.id,
      image: source.media.files[0],
    });

    notesStore.toggleHandwritingSample("hw_sample_1", { active: false });
    let workspace = notesStore.readWorkspace();
    assert.equal(workspace.handwritingSamples.hw_sample_1.active, false);
    assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);

    notesStore.toggleHandwritingSample("hw_sample_1", { active: true });
    workspace = notesStore.readWorkspace();
    assert.equal(workspace.handwritingSamples.hw_sample_1.active, true);
    assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, ["hw_sample_1"]);
  } finally {
    cleanup();
  }
});

test("workspace store rejects unsafe explicit handwriting prompt ids with inline prompts", () => {
  withTempNotesStore((notesStore) => {
    const source = createHandwritingImageSource(notesStore);
    const prompt = createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" });

    assert.throws(
      () =>
        notesStore.createHandwritingSample({
          id: "hw_sample_unsafe_prompt",
          profileId: DEFAULT_HANDWRITING_PROFILE_ID,
          promptId: "__proto__",
          prompt,
          sourceArtifactId: source.id,
          image: source.media.files[0],
        }),
      /unsafe state map key: __proto__/,
    );

    const workspace = notesStore.readWorkspace();
    assert.equal(Object.hasOwn(workspace.handwritingSamples, "hw_sample_unsafe_prompt"), false);
    assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);
    assert.deepEqual(workspace.handwritingSampleOrder, []);
  });
});

test("workspace store rejects unsafe inline handwriting prompt ids", () => {
  withTempNotesStore((notesStore) => {
    const source = createHandwritingImageSource(notesStore);
    const prompt = {
      ...createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" }),
      id: "__proto__",
    };

    assert.throws(
      () =>
        notesStore.createHandwritingSample({
          id: "hw_sample_unsafe_inline_prompt",
          profileId: DEFAULT_HANDWRITING_PROFILE_ID,
          prompt,
          sourceArtifactId: source.id,
          image: source.media.files[0],
        }),
      /unsafe state map key: __proto__/,
    );

    const workspace = notesStore.readWorkspace();
    assert.equal(Object.hasOwn(workspace.handwritingSamples, "hw_sample_unsafe_inline_prompt"), false);
    assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);
    assert.deepEqual(workspace.handwritingSampleOrder, []);
  });
});

test("workspace store rejects explicitly blank handwriting prompt ids with inline prompts", () => {
  withTempNotesStore((notesStore) => {
    const source = createHandwritingImageSource(notesStore);
    const prompt = createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" });

    assert.throws(
      () =>
        notesStore.createHandwritingSample({
          id: "hw_sample_blank_prompt",
          profileId: DEFAULT_HANDWRITING_PROFILE_ID,
          promptId: "",
          prompt,
          sourceArtifactId: source.id,
          image: source.media.files[0],
        }),
      /handwriting prompt id is required/,
    );

    const workspace = notesStore.readWorkspace();
    assert.equal(Object.hasOwn(workspace.handwritingSamples, "hw_sample_blank_prompt"), false);
    assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);
    assert.deepEqual(workspace.handwritingSampleOrder, []);
  });
});

test("workspace store rejects unsafe handwriting sample ids and references", () => {
  for (const { label, input } of [
    { label: "sample", input: { id: "__proto__" } },
    { label: "profile", input: { id: "hw_sample_unsafe_profile", profileId: "__proto__" } },
    { label: "source", input: { id: "hw_sample_unsafe_source", sourceArtifactId: "__proto__" } },
  ]) {
    withTempNotesStore((notesStore) => {
      const source = createHandwritingImageSource(notesStore);
      const prompt = createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" });

      assert.throws(
        () =>
          notesStore.createHandwritingSample({
            id: `hw_sample_unsafe_${label}`,
            profileId: DEFAULT_HANDWRITING_PROFILE_ID,
            prompt,
            sourceArtifactId: source.id,
            image: source.media.files[0],
            ...input,
          }),
        /unsafe state map key: __proto__/,
      );

      const workspace = notesStore.readWorkspace();
      assert.equal(Object.hasOwn(workspace.handwritingSamples, input.id || `hw_sample_unsafe_${label}`), false);
      assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);
      assert.deepEqual(workspace.handwritingSampleOrder, []);
    });
  }
});

test("workspace store rejects inherited handwriting profiles when creating samples", () => {
  withObjectPrototypeRecords(
    {
      profile_inherited: {
        id: "profile_inherited",
        label: "Inherited profile",
        activeSampleIds: [],
        lexicon: [],
        createdAt: "2026-06-14T18:00:00.000Z",
        updatedAt: "2026-06-14T18:00:00.000Z",
      },
    },
    () => {
      withTempNotesStore((notesStore) => {
        const source = notesStore.createSourceArtifact({
          id: "src_hw_sample",
          kind: "image",
          media: {
            schemaVersion: 1,
            files: [
              {
                kind: "image",
                name: "sample.png",
                mimeType: "image/png",
                sizeBytes: 100,
                workspacePath: "notes-captures/sample.png",
              },
            ],
          },
        });
        const prompt = createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" });

        assert.throws(
          () =>
            notesStore.createHandwritingSample({
              id: "hw_sample_inherited_profile",
              profileId: "profile_inherited",
              prompt,
              sourceArtifactId: source.id,
              image: source.media.files[0],
            }),
          /unknown handwriting profile: profile_inherited/,
        );

        const workspace = notesStore.readWorkspace();
        assert.equal(Object.hasOwn(workspace.handwritingProfiles, "profile_inherited"), false);
        assert.equal(Object.hasOwn(workspace.handwritingSamples, "hw_sample_inherited_profile"), false);
        assert.deepEqual(workspace.handwritingSampleOrder, []);
      });
    },
  );
});

test("workspace store rejects inherited handwriting prompts when creating samples", () => {
  withObjectPrototypeRecords(
    {
      hw_prompt_inherited: {
        ...createDefaultHandwritingPrompt({ createdAt: "2026-06-14T18:00:00.000Z" }),
        id: "hw_prompt_inherited",
      },
    },
    () => {
      withTempNotesStore((notesStore) => {
        const source = notesStore.createSourceArtifact({
          id: "src_hw_sample",
          kind: "image",
          media: {
            schemaVersion: 1,
            files: [
              {
                kind: "image",
                name: "sample.png",
                mimeType: "image/png",
                sizeBytes: 100,
                workspacePath: "notes-captures/sample.png",
              },
            ],
          },
        });

        assert.throws(
          () =>
            notesStore.createHandwritingSample({
              id: "hw_sample_inherited_prompt",
              profileId: DEFAULT_HANDWRITING_PROFILE_ID,
              promptId: "hw_prompt_inherited",
              sourceArtifactId: source.id,
              image: source.media.files[0],
            }),
          /unknown handwriting prompt: hw_prompt_inherited/,
        );

        const workspace = notesStore.readWorkspace();
        assert.equal(Object.hasOwn(workspace.handwritingPrompts, "hw_prompt_inherited"), false);
        assert.equal(Object.hasOwn(workspace.handwritingSamples, "hw_sample_inherited_prompt"), false);
        assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);
        assert.deepEqual(workspace.handwritingSampleOrder, []);
      });
    },
  );
});

test("workspace store rejects inherited handwriting samples when toggling", () => {
  withObjectPrototypeRecords(
    {
      hw_sample_inherited: {
        id: "hw_sample_inherited",
        profileId: DEFAULT_HANDWRITING_PROFILE_ID,
        promptId: DEFAULT_HANDWRITING_PROMPT_ID,
        sourceArtifactId: "src_hw_sample",
        image: {
          kind: "image",
          name: "sample.png",
          mimeType: "image/png",
          sizeBytes: 100,
          workspacePath: "notes-captures/sample.png",
        },
        referenceText: "Inherited sample",
        coverage: {},
        active: false,
        createdAt: "2026-06-14T18:00:00.000Z",
        updatedAt: "2026-06-14T18:00:00.000Z",
      },
    },
    () => {
      withTempNotesStore((notesStore) => {
        assert.throws(
          () => notesStore.toggleHandwritingSample("hw_sample_inherited", { active: true }),
          /unknown handwriting sample: hw_sample_inherited/,
        );

        const workspace = notesStore.readWorkspace();
        assert.equal(Object.hasOwn(workspace.handwritingSamples, "hw_sample_inherited"), false);
        assert.deepEqual(workspace.handwritingProfiles[DEFAULT_HANDWRITING_PROFILE_ID].activeSampleIds, []);
      });
    },
  );
});

test("workspace store rejects inherited handwriting profiles when toggling samples", () => {
  withObjectPrototypeRecords(
    {
      profile_inherited_toggle: {
        id: "profile_inherited_toggle",
        label: "Inherited profile",
        activeSampleIds: [],
        lexicon: [],
        createdAt: "2026-06-14T18:00:00.000Z",
        updatedAt: "2026-06-14T18:00:00.000Z",
      },
    },
    () => {
      withTempNotesStore((notesStore, stateStore) => {
        notesStore.createSourceArtifact({
          id: "src_hw_sample",
          kind: "image",
          media: {
            schemaVersion: 1,
            files: [
              {
                kind: "image",
                name: "sample.png",
                mimeType: "image/png",
                sizeBytes: 100,
                workspacePath: "notes-captures/sample.png",
              },
            ],
          },
        });
        stateStore.update((state) => {
          state.notesBackbone.handwritingSamples.hw_sample_inherited_profile = {
            id: "hw_sample_inherited_profile",
            profileId: "profile_inherited_toggle",
            promptId: DEFAULT_HANDWRITING_PROMPT_ID,
            sourceArtifactId: "src_hw_sample",
            image: {
              kind: "image",
              name: "sample.png",
              mimeType: "image/png",
              sizeBytes: 100,
              workspacePath: "notes-captures/sample.png",
            },
            referenceText: "Sample with inherited profile",
            coverage: {},
            active: false,
            createdAt: "2026-06-14T18:00:00.000Z",
            updatedAt: "2026-06-14T18:00:00.000Z",
          };
          state.notesBackbone.handwritingSampleOrder.push("hw_sample_inherited_profile");
        });

        assert.throws(
          () => notesStore.toggleHandwritingSample("hw_sample_inherited_profile", { active: true }),
          /unknown handwriting profile: profile_inherited_toggle/,
        );

        const workspace = notesStore.readWorkspace();
        assert.equal(Object.hasOwn(workspace.handwritingProfiles, "profile_inherited_toggle"), false);
        assert.equal(workspace.handwritingSamples.hw_sample_inherited_profile.active, false);
        assert.deepEqual(workspace.handwritingSampleOrder, ["hw_sample_inherited_profile"]);
      });
    },
  );
});

test("workspace store read returns a clone", () => {
  const { notesStore, cleanup } = tempNotesStore();
  try {
    const item = notesStore.createItem({ type: "note", title: "Inbox", body: "Call Sam" });
    const workspace = notesStore.readWorkspace();

    workspace.items[item.id].body = "changed through alias";
    workspace.itemOrder.push("fake_item");

    const reread = notesStore.readWorkspace();

    assert.equal(reread.items[item.id].body, "Call Sam");
    assert.deepEqual(reread.itemOrder, [item.id]);
  } finally {
    cleanup();
  }
});
