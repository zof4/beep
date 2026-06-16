# Beep Notes Product Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first server-owned Beep Notes backbone plus a demo-grade local web product surface for notes, todos, Beep comments, proposals, pipeline review modes, and source-preserving note processing.

**Architecture:** Add the product backbone under the existing `control-plane` authority boundary. Keep reusable domain, store, pipeline, and gateway modules separate from the disposable `demo-web` UI. Use deterministic replay tests for normal verification and a separate live-smoke script for local Beep proof.

**Tech Stack:** Node.js ES modules, `node:test`, existing control-plane HTTP helpers, file-backed `StateStore`, plain HTML/CSS/JavaScript for the local product demo, existing Beep runtime/control-plane APIs for optional live smoke.

---

## Scope Check

The approved spec covers one integrated first slice: server-owned workspace graph, pipeline engine, Beep gateway contracts, demo UI, and branch salvage audit. These pieces should be implemented together because each produces working, testable software only when the others can round-trip a note, Beep comment, proposal, and pipeline run.

Do not rebuild the SwiftUI app in this plan. Do not import the old note branch wholesale. Do not add external npm dependencies.

## File Structure

- Create `docs/notes-backbone-salvage-audit.md`: classifies the old note branch into keep/adapt, reference, and discard.
- Create `control-plane/src/notes/workspace-domain.mjs`: pure constructors, validators, selectors, proposal acceptance, privacy checks, and immutable source rules.
- Create `control-plane/src/notes/workspace-store.mjs`: persistence wrapper that stores the notes backbone under `state.notesBackbone` in the existing `StateStore`.
- Create `control-plane/src/notes/pipeline-engine.mjs`: pipeline stages, review policies, run progression, pause behavior, replay-friendly stage execution.
- Create `control-plane/src/notes/beep-gateway.mjs`: typed gateway tool contracts, replay client, local-agent client adapter, structured output validation.
- Create `control-plane/src/notes/routes.mjs`: `/api/notes/...` API routes for workspace items, comments, proposals, runs, and privacy locks.
- Create `control-plane/src/notes/demo-web.mjs`: product-demo HTML, CSS, and JavaScript served by the control plane.
- Modify `control-plane/src/server.mjs`: wire notes API and product demo routes.
- Modify `package.json`: add focused test scripts for the notes backbone.
- Create `scripts/smoke-test-beep-notes-backbone.sh`: deterministic local API smoke and optional live Beep smoke.
- Create `control-plane/test/notes-workspace-domain.test.mjs`: domain invariants.
- Create `control-plane/test/notes-workspace-store.test.mjs`: persistence behavior.
- Create `control-plane/test/notes-pipeline-engine.test.mjs`: review policies and artifact output.
- Create `control-plane/test/notes-beep-gateway.test.mjs`: schema validation and replay gateway behavior.
- Create `control-plane/test/notes-routes.test.mjs`: authenticated API routes.
- Create `control-plane/test/notes-demo-web.test.mjs`: product demo route and core markup.

## API Shape

Use operator auth for all `/api/notes/...` routes in this local first slice.

- `GET /notes`: product demo HTML.
- `GET /notes/app.js`: product demo JavaScript.
- `GET /notes/styles.css`: product demo CSS.
- `GET /api/notes/workspace`: full demo workspace projection.
- `POST /api/notes/items`: create note, todo, calendar block, or research item.
- `GET /api/notes/items/:itemId`: read one allowed item and attached layers.
- `POST /api/notes/items/:itemId/lock`: lock item content from Beep.
- `POST /api/notes/items/:itemId/unlock`: unlock item content.
- `POST /api/notes/items/:itemId/ask-beep`: run a short workflow that adds comments and proposals.
- `POST /api/notes/captures`: create immutable source artifact.
- `POST /api/notes/captures/:sourceArtifactId/process`: run the note-processing pipeline.
- `POST /api/notes/proposals/:proposalId/accept`: promote proposal into a normal workspace item.
- `POST /api/notes/proposals/:proposalId/reject`: mark proposal rejected.
- `GET /api/notes/runs/:runId`: inspect pipeline run details.

## Task 1: Branch Salvage Audit

**Files:**
- Create: `docs/notes-backbone-salvage-audit.md`

- [ ] **Step 1: Write the salvage audit document**

Create `docs/notes-backbone-salvage-audit.md` with this content:

```md
# Note Workspace Branch Salvage Audit

Source branch: `codex/note-workspace-stability`

Decision: mine the branch for domain vocabulary and tests. Do not merge it.

## Keep Or Adapt

- `apps/NoteWorkspace/NoteWorkspace/Domain/WorkspaceItem.swift`: adapt universal item plus facet vocabulary into the server-owned workspace domain.
- `apps/NoteWorkspace/NoteWorkspace/Domain/WorkspaceState.swift`: adapt normalized state and selectors into the server store projection.
- `apps/NoteWorkspace/NoteWorkspace/Domain/WorkspaceReducer.swift`: adapt command-style mutation into pure event appliers.
- `apps/NoteWorkspace/NoteWorkspace/Domain/TodoBuckets.swift`: adapt Active, Scheduled, Future, and Archive grouping after the first comments/proposals slice.
- `apps/NoteWorkspace/NoteWorkspace/Domain/DedupeSuggestionService.swift`: adapt as a cheap local heuristic after workspace search exists.
- `apps/NoteWorkspace/NoteWorkspaceTests/*Domain*.swift`: use as behavioral reference for server-side tests.

## Reference Only

- `apps/NoteWorkspace/NoteWorkspace/App/WorkspaceAppModel.swift`: reference as a list of client actions.
- `apps/NoteWorkspace/NoteWorkspace/Persistence/WorkspaceRepository.swift`: reference local JSON persistence as a client cache pattern, not source of truth.
- `apps/NoteWorkspace/NoteWorkspace/Views/CalendarPageView.swift`: reference calendar lane math only when calendar drag scheduling is implemented.
- `apps/NoteWorkspace/NoteWorkspace/Views/NoteRichTextFormatter.swift`: reference selection-formatting tests only when native note editing is rebuilt.
- `docs/superpowers/specs/2026-05-31-note-workspace-concept-map-design.md`: retain as historical context.
- `docs/superpowers/specs/2026-06-02-note-workspace-daily-flow-design.md`: retain as historical context.

## Discard

- SwiftUI product design and navigation.
- Liquid Glass styling experiments.
- Large mixed-responsibility view files.
- Client-owned source-of-truth assumptions.
- Any direction where the agent UI dominates basic note, todo, and calendar work.

## Reuse Rule

Port behavior into Node tests first, then implement against the server-owned backbone. Never copy SwiftUI view architecture into the web demo or future SwiftUI rebuild.
```

- [ ] **Step 2: Verify the document is present**

Run:

```bash
test -s docs/notes-backbone-salvage-audit.md
```

Expected: command exits with status `0`.

- [ ] **Step 3: Commit**

```bash
git add docs/notes-backbone-salvage-audit.md
git commit -m "docs: audit note workspace branch salvage"
```

## Task 2: Workspace Domain

**Files:**
- Create: `control-plane/src/notes/workspace-domain.mjs`
- Create: `control-plane/test/notes-workspace-domain.test.mjs`

- [ ] **Step 1: Write the failing domain tests**

Create `control-plane/test/notes-workspace-domain.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the domain tests and verify they fail**

Run:

```bash
node --test control-plane/test/notes-workspace-domain.test.mjs
```

Expected: FAIL with an import error for `control-plane/src/notes/workspace-domain.mjs`.

- [ ] **Step 3: Implement the workspace domain module**

Create `control-plane/src/notes/workspace-domain.mjs`:

```js
const ITEM_TYPES = new Set(["note", "todo", "calendarBlock", "research"]);
const PROPOSAL_KINDS = new Set(["todo", "calendarBlock", "research", "comment", "estimate", "plan"]);

function nowIso() {
  return new Date().toISOString();
}

function requiredString(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function cleanString(value) {
  return String(value || "").trim();
}

function cleanArray(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)).filter(Boolean) : [];
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
    body: String(input.body || ""),
    media: input.media || null,
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
    body: String(input.body || ""),
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
    body: String(input.body || ""),
    facets: facetsFor(type, input),
    sourceArtifactIds: cleanArray(input.sourceArtifactIds),
    derivedArtifactIds: cleanArray(input.derivedArtifactIds),
    agentCommentIds: cleanArray(input.agentCommentIds),
    proposalIds: cleanArray(input.proposalIds),
    relationships: Array.isArray(input.relationships) ? input.relationships : [],
    accessPolicy: input.accessPolicy || { locked: false, grants: [] },
    createdAt,
    updatedAt: createdAt,
  };
}

export function lockWorkspaceItem(item, { lockedAt = nowIso() } = {}) {
  return {
    ...item,
    accessPolicy: {
      ...(item.accessPolicy || {}),
      locked: true,
      lockedAt,
      grants: item.accessPolicy?.grants || [],
    },
    updatedAt: lockedAt,
  };
}

export function unlockWorkspaceItem(item, { unlockedAt = nowIso() } = {}) {
  return {
    ...item,
    accessPolicy: {
      ...(item.accessPolicy || {}),
      locked: false,
      unlockedAt,
      grants: item.accessPolicy?.grants || [],
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
    facets: item.facets,
    sourceArtifactIds: item.sourceArtifactIds,
    derivedArtifactIds: item.derivedArtifactIds,
    relationships: item.relationships,
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
    body: String(input.body || ""),
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
  const type = proposal.kind === "calendarBlock" ? "calendarBlock" : proposal.kind === "research" ? "research" : "todo";
  const item = createWorkspaceItem({
    id: requiredString(itemId, "accepted item id"),
    type,
    title: proposal.title,
    body: proposal.body,
    estimateMinutes: proposal.estimateMinutes,
    sourceArtifactIds: proposal.sourceArtifactIds,
    relationships: proposal.sourceItemIds.map((targetId) => ({ type: "cameFrom", targetId })),
    createdAt: acceptedAt,
  });
  return {
    proposal: {
      ...proposal,
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
    ...proposal,
    status: "rejected",
    rejectedAt,
    updatedAt: rejectedAt,
  };
}
```

- [ ] **Step 4: Run the domain tests and verify they pass**

Run:

```bash
node --test control-plane/test/notes-workspace-domain.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/workspace-domain.mjs control-plane/test/notes-workspace-domain.test.mjs
git commit -m "feat: add notes workspace domain"
```

## Task 3: Workspace Store

**Files:**
- Create: `control-plane/src/notes/workspace-store.mjs`
- Create: `control-plane/test/notes-workspace-store.test.mjs`

- [ ] **Step 1: Write the failing store tests**

Create `control-plane/test/notes-workspace-store.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";
import { NotesWorkspaceStore } from "../src/notes/workspace-store.mjs";

function tempNotesStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-notes-store-test-"));
  const stateStore = new StateStore(dir);
  const notesStore = new NotesWorkspaceStore({ store: stateStore, now: () => "2026-06-14T18:00:00.000Z" });
  return {
    notesStore,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
```

- [ ] **Step 2: Run the store tests and verify they fail**

Run:

```bash
node --test control-plane/test/notes-workspace-store.test.mjs
```

Expected: FAIL with an import error for `control-plane/src/notes/workspace-store.mjs`.

- [ ] **Step 3: Implement the workspace store**

Create `control-plane/src/notes/workspace-store.mjs`:

```js
import { randomBytes } from "node:crypto";
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

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
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
  };
}

function ensureNotesState(state) {
  if (!state.notesBackbone || typeof state.notesBackbone !== "object" || Array.isArray(state.notesBackbone)) {
    state.notesBackbone = initialNotesState();
  }
  const notes = state.notesBackbone;
  notes.items ||= {};
  notes.itemOrder ||= [];
  notes.sourceArtifacts ||= {};
  notes.sourceOrder ||= [];
  notes.derivedArtifacts ||= {};
  notes.comments ||= {};
  notes.proposals ||= {};
  notes.runs ||= {};
  notes.runOrder ||= [];
  return notes;
}

export class NotesWorkspaceStore {
  constructor({ store, now = nowIso } = {}) {
    if (!store) throw new Error("StateStore is required");
    this.store = store;
    this.now = now;
  }

  readWorkspace() {
    const state = this.store.readState();
    return structuredClone(ensureNotesState(state));
  }

  updateWorkspace(mutator) {
    return this.store.update((state) => {
      const notes = ensureNotesState(state);
      return mutator(notes);
    });
  }

  getItem(itemId) {
    return this.readWorkspace().items[itemId] || null;
  }

  createItem(input) {
    return this.updateWorkspace((workspace) => {
      const item = createWorkspaceItem({
        ...input,
        id: input.id || newId("item"),
        createdAt: input.createdAt || this.now(),
      });
      workspace.items[item.id] = item;
      workspace.itemOrder.push(item.id);
      return item;
    });
  }

  createSourceArtifact(input) {
    return this.updateWorkspace((workspace) => {
      const source = createSourceArtifact({
        ...input,
        id: input.id || newId("src"),
        createdAt: input.createdAt || this.now(),
      });
      workspace.sourceArtifacts[source.id] = source;
      workspace.sourceOrder.push(source.id);
      return source;
    });
  }

  createDerivedArtifact(input) {
    return this.updateWorkspace((workspace) => {
      const derived = createDerivedArtifactDomain({
        ...input,
        id: input.id || newId("derived"),
        createdAt: input.createdAt || this.now(),
      });
      workspace.derivedArtifacts[derived.id] = derived;
      for (const sourceId of derived.sourceArtifactIds) {
        const source = workspace.sourceArtifacts[sourceId];
        if (source) {
          source.derivedArtifactIds = [...new Set([...(source.derivedArtifactIds || []), derived.id])];
          source.updatedAt = derived.createdAt;
        }
      }
      return derived;
    });
  }

  createComment(input) {
    return this.updateWorkspace((workspace) => {
      const comment = createAgentComment({
        ...input,
        id: input.id || newId("comment"),
        createdAt: input.createdAt || this.now(),
      });
      workspace.comments[comment.id] = comment;
      const target = workspace.items[comment.targetId];
      if (target) {
        target.agentCommentIds = [...new Set([...(target.agentCommentIds || []), comment.id])];
        target.updatedAt = comment.createdAt;
      }
      return comment;
    });
  }

  createProposal(input) {
    return this.updateWorkspace((workspace) => {
      const proposal = createProposal({
        ...input,
        id: input.id || newId("proposal"),
        createdAt: input.createdAt || this.now(),
      });
      workspace.proposals[proposal.id] = proposal;
      for (const itemId of proposal.sourceItemIds) {
        const sourceItem = workspace.items[itemId];
        if (sourceItem) {
          sourceItem.proposalIds = [...new Set([...(sourceItem.proposalIds || []), proposal.id])];
          sourceItem.updatedAt = proposal.createdAt;
        }
      }
      return proposal;
    });
  }

  acceptProposal(proposalId) {
    return this.updateWorkspace((workspace) => {
      const proposal = workspace.proposals[proposalId];
      if (!proposal) throw new Error(`unknown proposal: ${proposalId}`);
      const accepted = acceptProposalDomain(proposal, { itemId: newId("item"), acceptedAt: this.now() });
      workspace.proposals[proposalId] = accepted.proposal;
      workspace.items[accepted.item.id] = accepted.item;
      workspace.itemOrder.push(accepted.item.id);
      return accepted;
    });
  }

  rejectProposal(proposalId) {
    return this.updateWorkspace((workspace) => {
      const proposal = workspace.proposals[proposalId];
      if (!proposal) throw new Error(`unknown proposal: ${proposalId}`);
      const rejected = rejectProposalDomain(proposal, { rejectedAt: this.now() });
      workspace.proposals[proposalId] = rejected;
      return rejected;
    });
  }

  lockItem(itemId) {
    return this.updateWorkspace((workspace) => {
      const item = workspace.items[itemId];
      if (!item) throw new Error(`unknown item: ${itemId}`);
      workspace.items[itemId] = lockWorkspaceItem(item, { lockedAt: this.now() });
      return workspace.items[itemId];
    });
  }

  unlockItem(itemId) {
    return this.updateWorkspace((workspace) => {
      const item = workspace.items[itemId];
      if (!item) throw new Error(`unknown item: ${itemId}`);
      workspace.items[itemId] = unlockWorkspaceItem(item, { unlockedAt: this.now() });
      return workspace.items[itemId];
    });
  }

  upsertRun(run) {
    return this.updateWorkspace((workspace) => {
      const exists = Boolean(workspace.runs[run.id]);
      workspace.runs[run.id] = run;
      if (!exists) workspace.runOrder.unshift(run.id);
      return run;
    });
  }
}
```

- [ ] **Step 4: Run the store tests and verify they pass**

Run:

```bash
node --test control-plane/test/notes-workspace-store.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/workspace-store.mjs control-plane/test/notes-workspace-store.test.mjs
git commit -m "feat: persist notes workspace backbone"
```

## Task 4: Pipeline Engine

**Files:**
- Create: `control-plane/src/notes/pipeline-engine.mjs`
- Create: `control-plane/test/notes-pipeline-engine.test.mjs`

- [ ] **Step 1: Write the failing pipeline tests**

Create `control-plane/test/notes-pipeline-engine.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createPipelineRun, runPipeline } from "../src/notes/pipeline-engine.mjs";

const NOW = "2026-06-14T18:00:00.000Z";

function fakeGateway() {
  return {
    async runStage(stage, context) {
      return {
        comments:
          stage === "agentCommentary"
            ? [{ targetId: context.targetItemId, body: "This note has two useful tasks.", sourceItemIds: [context.targetItemId] }]
            : [],
        proposals:
          stage === "draftExtraction"
            ? [{ kind: "todo", title: "Call Sam", body: "Ask about demo timing.", sourceItemIds: [context.targetItemId] }]
            : [],
        derivedArtifacts:
          stage === "readableRendition"
            ? [{ kind: "readableRendition", body: "Call Sam about demo timing." }]
            : [],
      };
    },
  };
}

test("stepReview pauses after the first completed stage", async () => {
  const run = createPipelineRun({
    id: "run_1",
    kind: "processNote",
    reviewPolicy: "stepReview",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "paused");
  assert.equal(result.currentStage, "formattedNote");
  assert.equal(result.stages[0].status, "completed");
  assert.equal(result.stages[1].status, "pending");
});

test("firstReadCheckpoint pauses after readable rendition", async () => {
  const run = createPipelineRun({
    id: "run_2",
    kind: "processNote",
    reviewPolicy: "firstReadCheckpoint",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "paused");
  assert.equal(result.pauseReason, "first_read_checkpoint");
  assert.equal(result.outputs.derivedArtifacts.length, 1);
});

test("autopilot completes all note-processing stages", async () => {
  const run = createPipelineRun({
    id: "run_3",
    kind: "processNote",
    reviewPolicy: "autopilot",
    targetItemId: "item_note",
    createdAt: NOW,
  });

  const result = await runPipeline(run, { gateway: fakeGateway(), now: () => NOW });

  assert.equal(result.status, "completed");
  assert.equal(result.stages.every((stage) => stage.status === "completed"), true);
  assert.equal(result.outputs.comments.length, 1);
  assert.equal(result.outputs.proposals.length, 1);
});

test("askBeep workflow uses a shorter stage list", () => {
  const run = createPipelineRun({
    id: "run_4",
    kind: "askBeep",
    reviewPolicy: "autopilot",
    targetItemId: "item_todo",
    createdAt: NOW,
  });

  assert.deepEqual(run.stages.map((stage) => stage.name), ["readContext", "agentCommentary", "draftExtraction"]);
});
```

- [ ] **Step 2: Run the pipeline tests and verify they fail**

Run:

```bash
node --test control-plane/test/notes-pipeline-engine.test.mjs
```

Expected: FAIL with an import error for `control-plane/src/notes/pipeline-engine.mjs`.

- [ ] **Step 3: Implement the pipeline engine**

Create `control-plane/src/notes/pipeline-engine.mjs`:

```js
const WORKFLOW_STAGES = {
  processNote: ["readableRendition", "formattedNote", "agentCommentary", "draftExtraction", "plannerPass"],
  askBeep: ["readContext", "agentCommentary", "draftExtraction"],
};

const REVIEW_POLICIES = new Set(["stepReview", "firstReadCheckpoint", "autopilot"]);

function nowIso() {
  return new Date().toISOString();
}

function stageRecords(kind) {
  const stages = WORKFLOW_STAGES[kind];
  if (!stages) throw new Error(`unsupported pipeline kind: ${kind}`);
  return stages.map((name) => ({ name, status: "pending", startedAt: null, completedAt: null, error: null }));
}

function nextPendingStage(run) {
  return run.stages.find((stage) => stage.status === "pending") || null;
}

function mergeOutputs(outputs, stageOutput = {}) {
  return {
    derivedArtifacts: [...outputs.derivedArtifacts, ...(stageOutput.derivedArtifacts || [])],
    comments: [...outputs.comments, ...(stageOutput.comments || [])],
    proposals: [...outputs.proposals, ...(stageOutput.proposals || [])],
  };
}

function shouldPause(run, completedStageName) {
  if (run.reviewPolicy === "stepReview") return { pause: true, reason: "step_review" };
  if (run.reviewPolicy === "firstReadCheckpoint" && completedStageName === "readableRendition") {
    return { pause: true, reason: "first_read_checkpoint" };
  }
  return { pause: false, reason: null };
}

export function createPipelineRun(input) {
  const createdAt = input.createdAt || nowIso();
  const reviewPolicy = input.reviewPolicy || "firstReadCheckpoint";
  if (!REVIEW_POLICIES.has(reviewPolicy)) throw new Error(`unsupported review policy: ${reviewPolicy}`);
  const stages = stageRecords(input.kind);
  return {
    schemaVersion: 1,
    id: input.id,
    kind: input.kind,
    reviewPolicy,
    targetItemId: input.targetItemId || null,
    sourceArtifactId: input.sourceArtifactId || null,
    status: "pending",
    currentStage: stages[0]?.name || null,
    pauseReason: null,
    stages,
    outputs: { derivedArtifacts: [], comments: [], proposals: [] },
    errors: [],
    createdAt,
    updatedAt: createdAt,
  };
}

export async function runPipeline(run, { gateway, now = nowIso, context = {} } = {}) {
  if (!gateway?.runStage) throw new Error("gateway.runStage is required");
  let nextRun = structuredClone(run);
  nextRun.status = "running";
  while (true) {
    const stage = nextPendingStage(nextRun);
    if (!stage) {
      nextRun.status = "completed";
      nextRun.currentStage = null;
      nextRun.updatedAt = now();
      return nextRun;
    }

    stage.status = "running";
    stage.startedAt = now();
    nextRun.currentStage = stage.name;
    nextRun.updatedAt = stage.startedAt;

    try {
      const stageOutput = await gateway.runStage(stage.name, {
        ...context,
        targetItemId: nextRun.targetItemId,
        sourceArtifactId: nextRun.sourceArtifactId,
        runId: nextRun.id,
        outputs: nextRun.outputs,
      });
      stage.status = "completed";
      stage.completedAt = now();
      nextRun.outputs = mergeOutputs(nextRun.outputs, stageOutput);
      const pause = shouldPause(nextRun, stage.name);
      if (pause.pause) {
        nextRun.status = "paused";
        nextRun.pauseReason = pause.reason;
        nextRun.currentStage = nextPendingStage(nextRun)?.name || null;
        nextRun.updatedAt = stage.completedAt;
        return nextRun;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stage.status = "failed";
      stage.error = message;
      nextRun.status = "failed";
      nextRun.errors.push({ stage: stage.name, message, at: now() });
      nextRun.updatedAt = now();
      return nextRun;
    }
  }
}
```

- [ ] **Step 4: Run the pipeline tests and verify they pass**

Run:

```bash
node --test control-plane/test/notes-pipeline-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/pipeline-engine.mjs control-plane/test/notes-pipeline-engine.test.mjs
git commit -m "feat: add notes pipeline engine"
```

## Task 5: Beep Gateway Replay And Schema Validation

**Files:**
- Create: `control-plane/src/notes/beep-gateway.mjs`
- Create: `control-plane/test/notes-beep-gateway.test.mjs`

- [ ] **Step 1: Write the failing gateway tests**

Create `control-plane/test/notes-beep-gateway.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { NotesBeepGateway, validateStageOutput } from "../src/notes/beep-gateway.mjs";

test("validateStageOutput accepts structured comments and proposals", () => {
  const output = validateStageOutput({
    comments: [{ targetId: "item_1", body: "Looks actionable.", sourceItemIds: ["item_1"] }],
    proposals: [{ kind: "todo", title: "Call Sam", body: "Ask about timing.", sourceItemIds: ["item_1"] }],
    derivedArtifacts: [{ kind: "readableRendition", body: "Call Sam." }],
  });

  assert.equal(output.comments.length, 1);
  assert.equal(output.proposals.length, 1);
  assert.equal(output.derivedArtifacts.length, 1);
});

test("validateStageOutput rejects malformed proposal kind", () => {
  assert.throws(
    () =>
      validateStageOutput({
        proposals: [{ kind: "externalEmail", title: "Send mail", body: "", sourceItemIds: ["item_1"] }],
      }),
    /unsupported proposal kind/,
  );
});

test("replay gateway returns stage-specific canned output", async () => {
  const gateway = new NotesBeepGateway({
    mode: "replay",
    replay: {
      agentCommentary: {
        comments: [{ targetId: "item_1", body: "This has a follow-up.", sourceItemIds: ["item_1"] }],
      },
    },
  });

  const output = await gateway.runStage("agentCommentary", { targetItemId: "item_1" });

  assert.equal(output.comments[0].body, "This has a follow-up.");
});

test("local agent gateway calls injected submitter with stage prompt", async () => {
  const calls = [];
  const gateway = new NotesBeepGateway({
    mode: "localAgent",
    submitToAgent: async (payload) => {
      calls.push(payload);
      return {
        finalText: JSON.stringify({
          comments: [{ targetId: "item_1", body: "Agent comment.", sourceItemIds: ["item_1"] }],
        }),
      };
    },
  });

  const output = await gateway.runStage("agentCommentary", { targetItemId: "item_1" });

  assert.equal(calls.length, 1);
  assert.match(calls[0].message, /Return JSON only/u);
  assert.equal(output.comments[0].body, "Agent comment.");
});
```

- [ ] **Step 2: Run the gateway tests and verify they fail**

Run:

```bash
node --test control-plane/test/notes-beep-gateway.test.mjs
```

Expected: FAIL with an import error for `control-plane/src/notes/beep-gateway.mjs`.

- [ ] **Step 3: Implement the gateway module**

Create `control-plane/src/notes/beep-gateway.mjs`:

```js
const PROPOSAL_KINDS = new Set(["todo", "calendarBlock", "research", "comment", "estimate", "plan"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseAgentJson(result) {
  const text = result?.finalText || result?.text || result?.message || "";
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`local agent returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cleanSourceIds(value) {
  return asArray(value).map((entry) => String(entry)).filter(Boolean);
}

export function validateStageOutput(raw = {}) {
  const comments = asArray(raw.comments).map((comment) => ({
    targetId: String(comment.targetId || ""),
    body: String(comment.body || "").trim(),
    sourceItemIds: cleanSourceIds(comment.sourceItemIds),
    sourceArtifactIds: cleanSourceIds(comment.sourceArtifactIds),
    uncertainty: String(comment.uncertainty || ""),
  }));
  for (const comment of comments) {
    if (!comment.targetId) throw new Error("comment targetId is required");
    if (!comment.body) throw new Error("comment body is required");
  }

  const proposals = asArray(raw.proposals).map((proposal) => {
    const kind = String(proposal.kind || "");
    if (!PROPOSAL_KINDS.has(kind)) throw new Error(`unsupported proposal kind: ${kind}`);
    return {
      kind,
      title: String(proposal.title || "").trim(),
      body: String(proposal.body || ""),
      sourceItemIds: cleanSourceIds(proposal.sourceItemIds),
      sourceArtifactIds: cleanSourceIds(proposal.sourceArtifactIds),
      estimateMinutes: Number.isFinite(proposal.estimateMinutes) ? proposal.estimateMinutes : null,
      confidence: Number.isFinite(proposal.confidence) ? proposal.confidence : null,
    };
  });
  for (const proposal of proposals) {
    if (!proposal.title) throw new Error("proposal title is required");
  }

  const derivedArtifacts = asArray(raw.derivedArtifacts).map((artifact) => ({
    kind: String(artifact.kind || "").trim(),
    body: String(artifact.body || ""),
    sourceArtifactIds: cleanSourceIds(artifact.sourceArtifactIds),
  }));
  for (const artifact of derivedArtifacts) {
    if (!artifact.kind) throw new Error("derived artifact kind is required");
  }

  return { comments, proposals, derivedArtifacts };
}

function stagePrompt(stage, context) {
  return [
    `You are running Beep Notes pipeline stage: ${stage}.`,
    `Target item: ${context.targetItemId || "none"}.`,
    `Source artifact: ${context.sourceArtifactId || "none"}.`,
    "Return JSON only with optional arrays: comments, proposals, derivedArtifacts.",
    "Do not mutate original user content. Create comments and proposals only.",
  ].join("\n");
}

export class NotesBeepGateway {
  constructor({ mode = "replay", replay = {}, submitToAgent = null } = {}) {
    this.mode = mode;
    this.replay = replay;
    this.submitToAgent = submitToAgent;
  }

  async runStage(stage, context = {}) {
    if (this.mode === "replay") {
      return validateStageOutput(this.replay[stage] || {});
    }
    if (this.mode === "localAgent") {
      if (!this.submitToAgent) throw new Error("submitToAgent is required for localAgent mode");
      const result = await this.submitToAgent({ message: stagePrompt(stage, context), stage, context });
      return validateStageOutput(parseAgentJson(result));
    }
    throw new Error(`unsupported Beep gateway mode: ${this.mode}`);
  }
}
```

- [ ] **Step 4: Run the gateway tests and verify they pass**

Run:

```bash
node --test control-plane/test/notes-beep-gateway.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/notes/beep-gateway.mjs control-plane/test/notes-beep-gateway.test.mjs
git commit -m "feat: add notes Beep gateway contract"
```

## Task 6: Notes API Routes

**Files:**
- Create: `control-plane/src/notes/routes.mjs`
- Modify: `control-plane/src/server.mjs`
- Create: `control-plane/test/notes-routes.test.mjs`

- [ ] **Step 1: Write the failing route tests**

Create `control-plane/test/notes-routes.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempHandler() {
  const dir = mkdtempSync(join(tmpdir(), "beep-notes-routes-test-"));
  const store = new StateStore(dir);
  const operatorToken = store.ensureOperatorToken();
  const handler = createControlPlaneHandler({
    store,
    runtimeManager: {
      status: async () => ({ runtimeId: "local", running: false }),
      ensureRuntime: async () => ({ runtimeId: "local", running: true }),
      proxyToRuntime: async () => ({ ok: true, finalText: "{}" }),
    },
    toolBroker: { manifest: () => ({ tools: [] }), call: async () => ({ ok: false }) },
    localPortProxy: async () => {
      throw new Error("local port proxy should not be called");
    },
  });
  return {
    handler,
    auth: { authorization: `Bearer ${operatorToken}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(method, url, body = null, headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
  return req;
}

function captureResponse() {
  let statusCode = 0;
  let body = "";
  return {
    response: {
      writeHead(status) {
        statusCode = status;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    json() {
      return { statusCode, payload: body ? JSON.parse(body) : null };
    },
  };
}

async function call(handler, method, url, body, headers) {
  const captured = captureResponse();
  await handler(request(method, url, body, { "content-type": "application/json", ...headers }), captured.response);
  return captured.json();
}

test("notes workspace route requires operator auth", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const result = await call(handler, "GET", "/api/notes/workspace", null, {});
    assert.equal(result.statusCode, 401);
  } finally {
    cleanup();
  }
});

test("notes routes create items and list workspace projection", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const workspace = await call(handler, "GET", "/api/notes/workspace", null, auth);

    assert.equal(created.statusCode, 200);
    assert.equal(created.payload.item.type, "note");
    assert.equal(workspace.payload.workspace.itemOrder.length, 1);
  } finally {
    cleanup();
  }
});

test("ask-beep route attaches replay comments and proposals", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const itemId = created.payload.item.id;
    const asked = await call(handler, "POST", `/api/notes/items/${itemId}/ask-beep`, { reviewPolicy: "autopilot" }, auth);

    assert.equal(asked.statusCode, 200);
    assert.equal(asked.payload.run.status, "completed");
    assert.equal(asked.payload.comments.length >= 1, true);
    assert.equal(asked.payload.proposals.length >= 1, true);
  } finally {
    cleanup();
  }
});

test("proposal accept route promotes a todo", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const created = await call(handler, "POST", "/api/notes/items", { type: "note", title: "Inbox", body: "Call Sam" }, auth);
    const asked = await call(handler, "POST", `/api/notes/items/${created.payload.item.id}/ask-beep`, {}, auth);
    const proposalId = asked.payload.proposals[0].id;
    const accepted = await call(handler, "POST", `/api/notes/proposals/${proposalId}/accept`, {}, auth);

    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.payload.item.type, "todo");
  } finally {
    cleanup();
  }
});

test("capture processing route materializes derived artifacts", async () => {
  const { handler, auth, cleanup } = tempHandler();
  try {
    const source = await call(handler, "POST", "/api/notes/captures", { kind: "text", body: "Call Sam" }, auth);
    const processed = await call(
      handler,
      "POST",
      `/api/notes/captures/${source.payload.source.id}/process`,
      { reviewPolicy: "autopilot" },
      auth,
    );

    assert.equal(processed.statusCode, 200);
    assert.equal(processed.payload.run.status, "completed");
    assert.equal(processed.payload.derivedArtifacts.length >= 1, true);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the route tests and verify they fail**

Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

Expected: FAIL because `/api/notes/...` routes are not wired.

- [ ] **Step 3: Implement notes routes**

Create `control-plane/src/notes/routes.mjs`:

```js
import { readJsonBody, sendJson } from "../http-utils.mjs";
import { NotesBeepGateway } from "./beep-gateway.mjs";
import { createPipelineRun, runPipeline } from "./pipeline-engine.mjs";
import { NotesWorkspaceStore } from "./workspace-store.mjs";

function replayFor(targetItemId) {
  return {
    agentCommentary: {
      comments: [
        {
          targetId: targetItemId,
          body: "Beep sees this as actionable and worth turning into a short follow-up list.",
          sourceItemIds: [targetItemId],
        },
      ],
    },
    draftExtraction: {
      proposals: [
        {
          kind: "todo",
          title: "Follow up from note",
          body: "Review the note and decide the next action.",
          sourceItemIds: [targetItemId],
          estimateMinutes: 20,
          confidence: 0.72,
        },
      ],
    },
  };
}

function replayForSource(sourceArtifactId) {
  return {
    readableRendition: {
      derivedArtifacts: [
        {
          kind: "readableRendition",
          body: "Readable reconstruction from source.",
          sourceArtifactIds: [sourceArtifactId],
        },
      ],
    },
    draftExtraction: {
      proposals: [
        {
          kind: "todo",
          title: "Review source capture",
          body: "Turn the capture into next actions.",
          sourceArtifactIds: [sourceArtifactId],
          estimateMinutes: 20,
          confidence: 0.7,
        },
      ],
    },
  };
}

function createGateway({ body, targetItemId, forwardRuntimeRequest }) {
  if (body?.beepMode === "localAgent") {
    return new NotesBeepGateway({
      mode: "localAgent",
      submitToAgent: async ({ message }) =>
        forwardRuntimeRequest("/agent/submit", {
          method: "POST",
          body: { message, waitForCompletion: true },
        }),
    });
  }
  return new NotesBeepGateway({ mode: "replay", replay: replayFor(targetItemId) });
}

function materializeOutputs(notesStore, run) {
  const derivedArtifacts = run.outputs.derivedArtifacts.map((artifact) => notesStore.createDerivedArtifact(artifact));
  const comments = run.outputs.comments.map((comment) => notesStore.createComment(comment));
  const proposals = run.outputs.proposals.map((proposal) => notesStore.createProposal(proposal));
  return { derivedArtifacts, comments, proposals };
}

export async function handleNotesRoute({
  request,
  response,
  pathname,
  store,
  requireOperatorAuth,
  forwardRuntimeRequest,
}) {
  requireOperatorAuth(request);
  const notesStore = new NotesWorkspaceStore({ store });

  if (request.method === "GET" && pathname === "/api/notes/workspace") {
    sendJson(response, 200, { ok: true, workspace: notesStore.readWorkspace() });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/notes/items") {
    const body = await readJsonBody(request);
    const item = notesStore.createItem({
      type: body.type,
      title: body.title,
      body: body.body || "",
      sourceArtifactIds: body.sourceArtifactIds || [],
    });
    sendJson(response, 200, { ok: true, item });
    return true;
  }

  const itemMatch = pathname.match(/^\/api\/notes\/items\/([^/]+)$/u);
  if (request.method === "GET" && itemMatch) {
    const item = notesStore.getItem(itemMatch[1]);
    if (!item) {
      sendJson(response, 404, { ok: false, error: `unknown item: ${itemMatch[1]}` });
      return true;
    }
    const workspace = notesStore.readWorkspace();
    sendJson(response, 200, {
      ok: true,
      item,
      comments: item.agentCommentIds.map((id) => workspace.comments[id]).filter(Boolean),
      proposals: item.proposalIds.map((id) => workspace.proposals[id]).filter(Boolean),
    });
    return true;
  }

  const lockMatch = pathname.match(/^\/api\/notes\/items\/([^/]+)\/(lock|unlock)$/u);
  if (request.method === "POST" && lockMatch) {
    const item = lockMatch[2] === "lock" ? notesStore.lockItem(lockMatch[1]) : notesStore.unlockItem(lockMatch[1]);
    sendJson(response, 200, { ok: true, item });
    return true;
  }

  const askMatch = pathname.match(/^\/api\/notes\/items\/([^/]+)\/ask-beep$/u);
  if (request.method === "POST" && askMatch) {
    const targetItemId = askMatch[1];
    if (!notesStore.getItem(targetItemId)) {
      sendJson(response, 404, { ok: false, error: `unknown item: ${targetItemId}` });
      return true;
    }
    const body = await readJsonBody(request);
    const run = createPipelineRun({
      id: `run_${Date.now().toString(36)}`,
      kind: "askBeep",
      reviewPolicy: body.reviewPolicy || "autopilot",
      targetItemId,
    });
    const completedRun = await runPipeline(run, {
      gateway: createGateway({ body, targetItemId, forwardRuntimeRequest }),
    });
    const outputs = materializeOutputs(notesStore, completedRun);
    notesStore.upsertRun(completedRun);
    sendJson(response, 200, { ok: true, run: completedRun, ...outputs });
    return true;
  }

  if (request.method === "POST" && pathname === "/api/notes/captures") {
    const body = await readJsonBody(request);
    const source = notesStore.createSourceArtifact({ kind: body.kind || "text", body: body.body || "", media: body.media || null });
    sendJson(response, 200, { ok: true, source });
    return true;
  }

  const processCaptureMatch = pathname.match(/^\/api\/notes\/captures\/([^/]+)\/process$/u);
  if (request.method === "POST" && processCaptureMatch) {
    const sourceArtifactId = processCaptureMatch[1];
    const workspace = notesStore.readWorkspace();
    if (!workspace.sourceArtifacts[sourceArtifactId]) {
      sendJson(response, 404, { ok: false, error: `unknown source artifact: ${sourceArtifactId}` });
      return true;
    }
    const body = await readJsonBody(request);
    const run = createPipelineRun({
      id: `run_${Date.now().toString(36)}`,
      kind: "processNote",
      reviewPolicy: body.reviewPolicy || "firstReadCheckpoint",
      sourceArtifactId,
    });
    const completedRun = await runPipeline(run, {
      gateway: new NotesBeepGateway({ mode: "replay", replay: replayForSource(sourceArtifactId) }),
    });
    const outputs = materializeOutputs(notesStore, completedRun);
    notesStore.upsertRun(completedRun);
    sendJson(response, 200, { ok: true, run: completedRun, ...outputs });
    return true;
  }

  const acceptMatch = pathname.match(/^\/api\/notes\/proposals\/([^/]+)\/accept$/u);
  if (request.method === "POST" && acceptMatch) {
    sendJson(response, 200, { ok: true, ...notesStore.acceptProposal(acceptMatch[1]) });
    return true;
  }

  const rejectMatch = pathname.match(/^\/api\/notes\/proposals\/([^/]+)\/reject$/u);
  if (request.method === "POST" && rejectMatch) {
    sendJson(response, 200, { ok: true, proposal: notesStore.rejectProposal(rejectMatch[1]) });
    return true;
  }

  const runMatch = pathname.match(/^\/api\/notes\/runs\/([^/]+)$/u);
  if (request.method === "GET" && runMatch) {
    const run = notesStore.readWorkspace().runs[runMatch[1]] || null;
    sendJson(response, run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: `unknown run: ${runMatch[1]}` });
    return true;
  }

  return false;
}
```

- [ ] **Step 4: Wire notes routes into the control-plane server**

Modify `control-plane/src/server.mjs`.

Add this import near the other route imports:

```js
import { handleNotesRoute } from "./notes/routes.mjs";
```

Add this route block before the existing `/api/agent` block:

```js
    if (pathname === "/api/notes" || pathname.startsWith("/api/notes/")) {
      const handled = await handleNotesRoute({
        request,
        response,
        pathname,
        store,
        requireOperatorAuth,
        forwardRuntimeRequest,
      });
      if (handled) return;
    }
```

- [ ] **Step 5: Run the route tests and verify they pass**

Run:

```bash
node --test control-plane/test/notes-routes.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/server.mjs control-plane/src/notes/routes.mjs control-plane/test/notes-routes.test.mjs
git commit -m "feat: add notes product API routes"
```

## Task 7: Demo Web Product Surface

**Files:**
- Create: `control-plane/src/notes/demo-web.mjs`
- Modify: `control-plane/src/server.mjs`
- Create: `control-plane/test/notes-demo-web.test.mjs`

- [ ] **Step 1: Write the failing demo route tests**

Create `control-plane/test/notes-demo-web.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createControlPlaneHandler } from "../src/server.mjs";
import { StateStore } from "../src/state-store.mjs";

function tempHandler() {
  const dir = mkdtempSync(join(tmpdir(), "beep-notes-demo-test-"));
  const store = new StateStore(dir);
  const handler = createControlPlaneHandler({
    store,
    runtimeManager: { status: async () => ({ runtimeId: "local", running: false }) },
    toolBroker: { manifest: () => ({ tools: [] }), call: async () => ({ ok: false }) },
    localPortProxy: async () => {
      throw new Error("local port proxy should not be called");
    },
  });
  return {
    handler,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function request(method, url) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = {};
  process.nextTick(() => req.end());
  return req;
}

function captureTextResponse() {
  let statusCode = 0;
  let headers = {};
  let body = "";
  return {
    response: {
      writeHead(status, nextHeaders = {}) {
        statusCode = status;
        headers = nextHeaders;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    result() {
      return { statusCode, headers, body };
    },
  };
}

test("notes demo page is served as product UI", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const captured = captureTextResponse();
    await handler(request("GET", "/notes"), captured.response);
    const result = captured.result();

    assert.equal(result.statusCode, 200);
    assert.match(result.headers["content-type"], /text\/html/u);
    assert.match(result.body, /Beep Notes/u);
    assert.match(result.body, /Ask Beep/u);
    assert.match(result.body, /Inspector/u);
  } finally {
    cleanup();
  }
});

test("notes demo assets are served", async () => {
  const { handler, cleanup } = tempHandler();
  try {
    const js = captureTextResponse();
    await handler(request("GET", "/notes/app.js"), js.response);
    assert.equal(js.result().statusCode, 200);
    assert.match(js.result().body, /loadWorkspace/u);

    const css = captureTextResponse();
    await handler(request("GET", "/notes/styles.css"), css.response);
    assert.equal(css.result().statusCode, 200);
    assert.match(css.result().body, /sidebar/u);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the demo route tests and verify they fail**

Run:

```bash
node --test control-plane/test/notes-demo-web.test.mjs
```

Expected: FAIL because `/notes` does not serve the demo.

- [ ] **Step 3: Implement the demo web module**

Create `control-plane/src/notes/demo-web.mjs`:

```js
function sendText(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

export function handleNotesDemoRoute({ request, response, pathname }) {
  if (request.method !== "GET") return false;
  if (pathname === "/notes") {
    sendText(
      response,
      200,
      "text/html; charset=utf-8",
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Beep Notes</title>
  <link rel="stylesheet" href="/notes/styles.css">
</head>
<body>
  <main class="shell">
    <aside class="sidebar" aria-label="Workspace navigation">
      <div class="brand">Beep Notes</div>
      <button class="nav-item selected" data-view="today">Today</button>
      <button class="nav-item" data-view="notes">Notes</button>
      <button class="nav-item" data-view="todos">Todos</button>
      <button class="nav-item" data-view="calendar">Calendar</button>
      <button class="nav-item" data-view="research">Research</button>
      <button class="nav-item" data-view="agent">Agent Runs</button>
    </aside>
    <section class="content" aria-label="Workspace content">
      <header class="toolbar">
        <div>
          <p class="eyebrow">Today</p>
          <h1>Notes, tasks, schedule drafts, and Beep suggestions</h1>
        </div>
        <div class="toolbar-actions">
          <button id="new-note">New Note</button>
          <button id="new-todo">New Todo</button>
          <button id="ask-beep">Ask Beep</button>
        </div>
      </header>
      <section class="composer" aria-label="Create workspace item">
        <label>Title <input id="item-title" value="Planning note"></label>
        <label>Body <textarea id="item-body">Call Sam and draft the demo order.</textarea></label>
      </section>
      <section class="workspace-grid">
        <div>
          <h2>Workspace Items</h2>
          <div id="items" class="list"></div>
        </div>
        <div>
          <h2>Drafts To Review</h2>
          <div id="proposals" class="list"></div>
        </div>
      </section>
    </section>
    <aside class="inspector" aria-label="Inspector">
      <h2>Inspector</h2>
      <div id="selected-detail" class="inspector-panel">Select an item to see Beep comments, proposals, source links, and privacy state.</div>
      <h3>Agent Activity</h3>
      <div id="comments" class="list"></div>
    </aside>
  </main>
  <script src="/notes/app.js"></script>
</body>
</html>`,
    );
    return true;
  }
  if (pathname === "/notes/styles.css") {
    sendText(
      response,
      200,
      "text/css; charset=utf-8",
      `:root{color-scheme:light;--bg:oklch(0.97 0.006 250);--panel:oklch(0.99 0.004 250);--line:oklch(0.86 0.01 250);--text:oklch(0.22 0.014 250);--muted:oklch(0.48 0.018 250);--accent:oklch(0.55 0.16 250)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}.shell{display:grid;grid-template-columns:220px minmax(420px,1fr) 340px;min-height:100vh}.sidebar,.inspector{background:oklch(0.94 0.008 250);border-right:1px solid var(--line);padding:18px}.inspector{border-right:0;border-left:1px solid var(--line)}.brand{font-weight:700;margin-bottom:18px}.nav-item,button{border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text);padding:8px 10px;font:inherit}.nav-item{display:block;width:100%;text-align:left;margin-bottom:8px}.selected,button:focus{border-color:var(--accent);outline:2px solid color-mix(in oklch,var(--accent),transparent 76%)}.content{padding:20px 22px}.toolbar{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:16px}.toolbar h1{font-size:22px;line-height:1.2;margin:2px 0 0}.eyebrow{margin:0;color:var(--muted);font-size:12px;text-transform:uppercase;font-weight:700}.toolbar-actions{display:flex;gap:8px;flex-wrap:wrap}.composer{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}.composer label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:650}input,textarea{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;font:inherit;color:var(--text)}textarea{min-height:84px;resize:vertical}.workspace-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.list{display:grid;gap:10px}.row,.inspector-panel{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px}.row.selected{border-color:var(--accent)}.row h3{font-size:14px;margin:0 0 4px}.row p{margin:0;color:var(--muted)}h2{font-size:15px;margin:0 0 10px}h3{font-size:13px;margin:18px 0 8px}@media(max-width:920px){.shell{grid-template-columns:1fr}.sidebar,.inspector{border:0;border-bottom:1px solid var(--line)}.composer,.workspace-grid{grid-template-columns:1fr}}`,
    );
    return true;
  }
  if (pathname === "/notes/app.js") {
    sendText(
      response,
      200,
      "application/javascript; charset=utf-8",
      `let selectedItemId=null;async function api(path,options={}){const token=localStorage.getItem("beepOperatorToken")||prompt("Operator token");if(token)localStorage.setItem("beepOperatorToken",token);const res=await fetch(path,{...options,headers:{"authorization":"Bearer "+token,"content-type":"application/json",...(options.headers||{})}});return res.json()}function row(title,body,id){const el=document.createElement("button");el.className="row"+(id===selectedItemId?" selected":"");el.innerHTML="<h3></h3><p></p>";el.querySelector("h3").textContent=title;el.querySelector("p").textContent=body||"";return el}async function loadWorkspace(){const data=await api("/api/notes/workspace");const ws=data.workspace||{};const items=document.getElementById("items");items.innerHTML="";for(const id of ws.itemOrder||[]){const item=ws.items[id];const el=row(item.title,item.body,id);el.onclick=()=>selectItem(id);items.appendChild(el)}const proposals=document.getElementById("proposals");proposals.innerHTML="";for(const proposal of Object.values(ws.proposals||{}).filter((p)=>p.status==="pending")){const el=row(proposal.title,proposal.body,proposal.id);el.onclick=async()=>{await api("/api/notes/proposals/"+proposal.id+"/accept",{method:"POST",body:"{}"});await loadWorkspace()};proposals.appendChild(el)}}async function selectItem(id){selectedItemId=id;const data=await api("/api/notes/items/"+id);document.getElementById("selected-detail").textContent=data.item.title+" | "+data.item.type+" | locked: "+Boolean(data.item.accessPolicy?.locked);const comments=document.getElementById("comments");comments.innerHTML="";for(const comment of data.comments||[]){comments.appendChild(row("Beep",comment.body,comment.id))}await loadWorkspace()}async function createItem(type){const title=document.getElementById("item-title").value;const body=document.getElementById("item-body").value;const data=await api("/api/notes/items",{method:"POST",body:JSON.stringify({type,title,body})});selectedItemId=data.item.id;await selectItem(data.item.id)}document.getElementById("new-note").onclick=()=>createItem("note");document.getElementById("new-todo").onclick=()=>createItem("todo");document.getElementById("ask-beep").onclick=async()=>{if(!selectedItemId)return;await api("/api/notes/items/"+selectedItemId+"/ask-beep",{method:"POST",body:JSON.stringify({reviewPolicy:"autopilot"})});await selectItem(selectedItemId)};loadWorkspace().catch((error)=>{document.getElementById("items").textContent=error.message});`,
    );
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Wire demo routes into the control-plane server**

Modify `control-plane/src/server.mjs`.

Add this import near the other imports:

```js
import { handleNotesDemoRoute } from "./notes/demo-web.mjs";
```

Add this route block before `/health`:

```js
    if (pathname === "/notes" || pathname.startsWith("/notes/")) {
      if (handleNotesDemoRoute({ request, response, pathname })) return;
    }
```

- [ ] **Step 5: Run the demo route tests and verify they pass**

Run:

```bash
node --test control-plane/test/notes-demo-web.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/server.mjs control-plane/src/notes/demo-web.mjs control-plane/test/notes-demo-web.test.mjs
git commit -m "feat: add Beep Notes demo web UI"
```

## Task 8: Package Scripts And Deterministic Smoke

**Files:**
- Modify: `package.json`
- Create: `scripts/smoke-test-beep-notes-backbone.sh`

- [ ] **Step 1: Add test scripts**

Modify `package.json` and add these entries inside `scripts`:

```json
"test:notes-backbone": "node --test control-plane/test/notes-*.test.mjs",
"test:notes-backbone-static": "node --test control-plane/test/notes-workspace-domain.test.mjs control-plane/test/notes-workspace-store.test.mjs control-plane/test/notes-pipeline-engine.test.mjs control-plane/test/notes-beep-gateway.test.mjs control-plane/test/notes-routes.test.mjs control-plane/test/notes-demo-web.test.mjs && bash -n scripts/smoke-test-beep-notes-backbone.sh"
```

Keep the existing scripts unchanged.

- [ ] **Step 2: Write the deterministic smoke script**

Create `scripts/smoke-test-beep-notes-backbone.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BEEP_NOTES_SMOKE_PORT:-18788}"
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beep-notes-backbone.XXXXXX")"
LOG_FILE="$STATE_DIR/control-plane.log"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

(
  cd "$ROOT_DIR"
  BEEP_CONTROL_PLANE_STATE_DIR="$STATE_DIR" \
  BEEP_CONTROL_PLANE_PORT="$PORT" \
  BEEP_CONTROL_PLANE_AUTOSTART=0 \
  node control-plane/src/server.mjs
) >"$LOG_FILE" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null
operator_token="$(tr -d '\n' < "$STATE_DIR/operator-token")"

note_json="$(curl -fsS "http://127.0.0.1:$PORT/api/notes/items" \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{"type":"note","title":"Planning note","body":"Call Sam and draft the demo order."}')"
note_id="$(node -e 'const fs=require("fs"); const payload=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(payload.item.id)' <<<"$note_json")"

ask_json="$(curl -fsS "http://127.0.0.1:$PORT/api/notes/items/$note_id/ask-beep" \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{"reviewPolicy":"autopilot"}')"
proposal_id="$(node -e 'const fs=require("fs"); const payload=JSON.parse(fs.readFileSync(0,"utf8")); if (!payload.proposals.length) process.exit(2); process.stdout.write(payload.proposals[0].id)' <<<"$ask_json")"

curl -fsS "http://127.0.0.1:$PORT/api/notes/proposals/$proposal_id/accept" \
  -H "authorization: Bearer $operator_token" \
  -H "content-type: application/json" \
  -d '{}' >/dev/null

workspace_json="$(curl -fsS "http://127.0.0.1:$PORT/api/notes/workspace" \
  -H "authorization: Bearer $operator_token")"

node -e '
const fs = require("fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const workspace = payload.workspace;
const items = Object.values(workspace.items);
if (!items.some((item) => item.type === "note")) throw new Error("missing note");
if (!items.some((item) => item.type === "todo")) throw new Error("missing accepted todo");
if (!Object.values(workspace.comments).length) throw new Error("missing Beep comment");
' <<<"$workspace_json"

echo "beep notes backbone smoke passed"
```

- [ ] **Step 3: Make the smoke script executable**

Run:

```bash
chmod +x scripts/smoke-test-beep-notes-backbone.sh
```

Expected: command exits with status `0`.

- [ ] **Step 4: Run static notes tests**

Run:

```bash
npm run test:notes-backbone-static
```

Expected: PASS.

- [ ] **Step 5: Run deterministic smoke**

Run:

```bash
./scripts/smoke-test-beep-notes-backbone.sh
```

Expected: prints `beep notes backbone smoke passed`.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/smoke-test-beep-notes-backbone.sh
git commit -m "test: add Beep Notes backbone smoke"
```

## Task 9: Optional Live Beep Smoke Hook

**Files:**
- Modify: `scripts/smoke-test-beep-notes-backbone.sh`

- [ ] **Step 1: Add live mode to the smoke script**

Modify `scripts/smoke-test-beep-notes-backbone.sh` so the `ask-beep` curl builds its JSON body from `BEEP_NOTES_LIVE`.

Replace:

```bash
  -d '{"reviewPolicy":"autopilot"}')"
```

With:

```bash
  -d "$([[ "${BEEP_NOTES_LIVE:-0}" == "1" ]] && printf '{"reviewPolicy":"autopilot","beepMode":"localAgent"}' || printf '{"reviewPolicy":"autopilot"}')")"
```

- [ ] **Step 2: Run shell syntax validation**

Run:

```bash
bash -n scripts/smoke-test-beep-notes-backbone.sh
```

Expected: PASS with no output.

- [ ] **Step 3: Run deterministic smoke again**

Run:

```bash
./scripts/smoke-test-beep-notes-backbone.sh
```

Expected: prints `beep notes backbone smoke passed`.

- [ ] **Step 4: Document live smoke command in the script header**

Add these comments after `set -euo pipefail`:

```bash
# Deterministic replay smoke:
#   ./scripts/smoke-test-beep-notes-backbone.sh
#
# Optional live local-Beep smoke:
#   BEEP_NOTES_LIVE=1 ./scripts/smoke-test-beep-notes-backbone.sh
#
# Live mode requires a working local Beep runtime and Codex auth. Replay mode is
# the normal CI-safe check.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-test-beep-notes-backbone.sh
git commit -m "test: add optional live Beep Notes smoke"
```

## Task 10: Final Verification

**Files:**
- Modify only files needed for compile or test fixes from earlier tasks.

- [ ] **Step 1: Run notes backbone tests**

Run:

```bash
npm run test:notes-backbone
```

Expected: PASS.

- [ ] **Step 2: Run full control-plane tests**

Run:

```bash
npm run test:control-plane
```

Expected: PASS.

- [ ] **Step 3: Run deterministic smoke**

Run:

```bash
./scripts/smoke-test-beep-notes-backbone.sh
```

Expected: prints `beep notes backbone smoke passed`.

- [ ] **Step 4: Check repository status**

Run:

```bash
git status --short
```

Expected: no unstaged or staged changes.

- [ ] **Step 5: Report final state**

Report:

- Latest commit hash.
- `npm run test:notes-backbone` result.
- `npm run test:control-plane` result.
- `./scripts/smoke-test-beep-notes-backbone.sh` result.
- Whether optional live mode was run.
