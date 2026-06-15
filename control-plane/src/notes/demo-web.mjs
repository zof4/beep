const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Beep Notes</title>
    <link rel="stylesheet" href="/notes/styles.css">
  </head>
  <body>
    <div class="app-shell">
      <aside class="sidebar" aria-label="Workspace">
        <header class="brand-row">
          <div>
            <p class="eyebrow">Beep Notes</p>
            <h1>Workspace</h1>
          </div>
          <button class="icon-button" id="refreshWorkspaceButton" type="button" title="Refresh workspace">R</button>
        </header>

        <section class="panel compact-panel" aria-labelledby="authTitle">
          <div class="panel-heading">
            <h2 id="authTitle">Operator</h2>
            <button id="clearTokenButton" type="button" class="ghost-button">Clear</button>
          </div>
          <label class="field-label" for="operatorTokenInput">Bearer token</label>
          <input id="operatorTokenInput" type="password" autocomplete="off" placeholder="Paste operator token">
        </section>

        <section class="panel compact-panel" aria-labelledby="modesTitle">
          <h2 id="modesTitle">Run settings</h2>
          <label class="field-label" for="reviewPolicySelect">Review mode</label>
          <select id="reviewPolicySelect" name="reviewPolicy">
            <option value="stepReview">stepReview</option>
            <option value="firstReadCheckpoint">firstReadCheckpoint</option>
            <option value="autopilot">autopilot</option>
          </select>
          <label class="field-label" for="beepModeSelect">Beep mode</label>
          <select id="beepModeSelect" name="beepMode">
            <option value="replay">replay</option>
            <option value="localAgent">localAgent</option>
          </select>
        </section>

        <nav class="item-list" aria-label="Notes and todos">
          <div class="list-heading">
            <span>Notes and todos</span>
            <span id="itemCount" class="count-badge">0</span>
          </div>
          <div id="itemList" class="scroll-list"></div>
        </nav>
      </aside>

      <main class="workspace" aria-label="Beep Notes workspace">
        <header class="toolbar">
          <div>
            <p class="eyebrow">Product demo</p>
            <h2>Capture, triage, ask</h2>
          </div>
          <div class="toolbar-actions">
            <button id="createNoteButton" type="button">New note</button>
            <button id="createTodoButton" type="button">New todo</button>
            <button id="askBeepButton" type="button" class="primary-button">Ask Beep</button>
          </div>
        </header>

        <section class="compose-grid" aria-label="Create workspace content">
          <form id="itemForm" class="entry-surface">
            <div class="section-heading">
              <h3>Create item</h3>
              <span id="itemTypeLabel">note</span>
            </div>
            <label class="field-label" for="itemTitleInput">Title</label>
            <input id="itemTitleInput" name="title" placeholder="Title" autocomplete="off">
            <label class="field-label" for="itemBodyInput">Body</label>
            <textarea id="itemBodyInput" name="body" placeholder="Write a note or todo"></textarea>
            <button type="submit">Add to workspace</button>
          </form>

          <form id="captureForm" class="entry-surface">
            <div class="section-heading">
              <h3>Original capture</h3>
              <span id="captureKindLabel">text</span>
            </div>
            <label class="field-label" for="captureKindSelect">Capture type</label>
            <select id="captureKindSelect" name="kind">
              <option value="text">Text</option>
              <option value="image">Image</option>
            </select>
            <label class="field-label" for="captureBodyInput">Capture text</label>
            <textarea id="captureBodyInput" name="body" placeholder="Captured notebook text, voice transcript, paste, or image caption"></textarea>
            <div id="imageCaptureFields" class="image-fields" hidden>
              <label class="field-label" for="imageCaptureInput">Image file</label>
              <input id="imageCaptureInput" name="image" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif">
              <div class="row-meta">HEIC/HEIF uploads convert to JPEG before Beep reads them.</div>
              <div id="imagePreview" class="image-preview empty-state">No image selected.</div>
            </div>
            <button id="processCaptureButton" type="submit">Create and process capture</button>
          </form>
        </section>

        <section class="layer-view" aria-labelledby="layerTitle">
          <div class="section-heading">
            <h3 id="layerTitle">Selected item</h3>
            <button id="lockToggleButton" type="button" class="ghost-button">Lock</button>
          </div>
          <div id="selectedItem" class="selected-item empty-state">Select or create an item.</div>
          <div class="layer-grid">
            <section>
              <h4>Original capture</h4>
              <div id="sourceLayer" class="layer-stack empty-state">No source selected.</div>
            </section>
            <section>
              <h4>Readable rendition</h4>
              <div id="derivedLayer" class="layer-stack empty-state">No derived rendition yet.</div>
            </section>
            <section>
              <h4>Comments/proposals</h4>
              <div id="secondaryLayer" class="layer-stack empty-state">Ask Beep to add secondary layer context.</div>
            </section>
          </div>
        </section>
      </main>

      <aside class="inspector" aria-label="Inspector">
        <header class="inspector-header">
          <p class="eyebrow">Inspector</p>
          <h2>Activity</h2>
        </header>
        <section>
          <h3>Status</h3>
          <p id="statusText" class="status-text">Ready.</p>
        </section>
        <section>
          <h3>Recent runs</h3>
          <div id="runList" class="run-list empty-state">No pipeline activity yet.</div>
        </section>
        <section>
          <h3>Pending proposals</h3>
          <div id="proposalList" class="proposal-list empty-state">No pending proposals.</div>
        </section>
      </aside>
    </div>
    <script type="module" src="/notes/app.js"></script>
  </body>
</html>
`;

const CSS = `:root {
  color-scheme: light;
  --surface: oklch(98% 0.006 248);
  --surface-muted: oklch(95.5% 0.008 248);
  --panel: oklch(99% 0.004 248);
  --panel-strong: oklch(92% 0.01 248);
  --line: oklch(87% 0.012 248);
  --text: oklch(22% 0.018 248);
  --muted: oklch(47% 0.018 248);
  --faint: oklch(63% 0.016 248);
  --accent: oklch(55% 0.14 235);
  --accent-strong: oklch(45% 0.15 235);
  --accent-soft: oklch(94% 0.035 235);
  --danger: oklch(52% 0.16 30);
  --radius: 8px;
  --shadow: 0 1px 2px oklch(20% 0.02 248 / 10%);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
  line-height: 1.4;
}

button,
input,
select,
textarea {
  font: inherit;
}

button,
select,
input,
textarea {
  border: 1px solid var(--line);
  border-radius: 7px;
}

button {
  min-height: 32px;
  padding: 0 12px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  box-shadow: var(--shadow);
}

button:hover {
  border-color: oklch(76% 0.03 248);
  background: oklch(97% 0.006 248);
}

button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid oklch(72% 0.1 235);
  outline-offset: 1px;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

input,
select,
textarea {
  width: 100%;
  background: var(--panel);
  color: var(--text);
  padding: 8px 9px;
}

textarea {
  min-height: 92px;
  resize: vertical;
}

h1,
h2,
h3,
h4,
p {
  margin: 0;
}

h1 {
  font-size: 20px;
  line-height: 1.15;
}

h2 {
  font-size: 17px;
  line-height: 1.2;
}

h3 {
  font-size: 13px;
  line-height: 1.2;
}

h4 {
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  margin: 0 0 8px;
}

.app-shell {
  display: grid;
  grid-template-columns: minmax(230px, 280px) minmax(420px, 1fr) minmax(260px, 320px);
  min-height: 100vh;
}

.sidebar,
.inspector {
  background: var(--surface-muted);
  border-color: var(--line);
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sidebar {
  border-right: 1px solid var(--line);
}

.inspector {
  border-left: 1px solid var(--line);
  gap: 18px;
  padding: 16px;
}

.workspace {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-width: 0;
  padding: 16px 18px 24px;
}

.brand-row,
.toolbar,
.inspector-header,
.panel,
.item-list {
  padding: 16px;
}

.brand-row,
.toolbar,
.panel-heading,
.section-heading,
.list-heading {
  align-items: center;
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.toolbar {
  border-bottom: 1px solid var(--line);
  margin: -16px -18px 0;
}

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}

.primary-button {
  background: var(--accent);
  border-color: var(--accent);
  color: oklch(99% 0.004 235);
}

.primary-button:hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}

.ghost-button,
.icon-button {
  box-shadow: none;
}

.icon-button {
  width: 32px;
  padding: 0;
}

.eyebrow,
.field-label,
.list-heading,
.section-heading span {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

.panel,
.item-list {
  border-top: 1px solid var(--line);
}

.compact-panel {
  display: grid;
  gap: 8px;
}

.scroll-list,
.run-list,
.proposal-list {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}

.item-button,
.record-row,
.proposal-row,
.run-row {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: grid;
  gap: 4px;
  padding: 10px;
  text-align: left;
  width: 100%;
}

.item-button[aria-current="true"] {
  background: var(--accent-soft);
  border-color: oklch(78% 0.07 235);
}

.row-title {
  font-weight: 700;
  min-width: 0;
  overflow-wrap: anywhere;
}

.row-body,
.row-meta,
.status-text {
  overflow-wrap: anywhere;
}

.row-meta,
.status-text,
.empty-state {
  color: var(--muted);
}

.count-badge,
.status-pill {
  align-items: center;
  background: var(--panel-strong);
  border-radius: 999px;
  color: var(--muted);
  display: inline-flex;
  font-size: 11px;
  font-weight: 700;
  min-height: 20px;
  padding: 0 7px;
}

.compose-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.entry-surface,
.layer-view {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  display: grid;
  gap: 10px;
  padding: 14px;
}

.image-fields {
  display: grid;
  gap: 8px;
}

.image-fields[hidden] {
  display: none;
}

.image-preview {
  align-items: center;
  background: var(--surface-muted);
  border: 1px dashed var(--line);
  border-radius: var(--radius);
  display: grid;
  min-height: 120px;
  overflow: hidden;
  padding: 8px;
}

.image-preview img,
.source-image {
  border-radius: 6px;
  max-height: 240px;
  object-fit: contain;
  width: 100%;
}

.selected-item {
  border-bottom: 1px solid var(--line);
  padding-bottom: 12px;
}

.layer-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.layer-stack {
  display: grid;
  gap: 8px;
}

.proposal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.danger-button {
  color: var(--danger);
}

@media (max-width: 980px) {
  .app-shell {
    grid-template-columns: minmax(220px, 270px) 1fr;
  }

  .inspector {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--line);
  }
}

@media (max-width: 760px) {
  .app-shell,
  .compose-grid,
  .layer-grid {
    grid-template-columns: 1fr;
  }

  .sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .toolbar-actions {
    justify-content: flex-start;
    width: 100%;
  }
}
`;

const JS = `const TOKEN_KEY = "beep-notes-operator-token";
const PROMOTABLE_PROPOSAL_KINDS = new Set(["todo", "calendarBlock", "research"]);
const HEIF_CAPTURE_MIME_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const IMAGE_CAPTURE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  ...HEIF_CAPTURE_MIME_TYPES,
]);
const MAX_IMAGE_CAPTURE_BYTES = 40 * 1024 * 1024;

const state = {
  workspace: null,
  selectedItemId: null,
  selectedSourceId: null,
  itemType: "note",
  captureKind: "text",
  captureImage: null,
};

const elements = {
  statusText: document.getElementById("statusText"),
  operatorTokenInput: document.getElementById("operatorTokenInput"),
  clearTokenButton: document.getElementById("clearTokenButton"),
  refreshWorkspaceButton: document.getElementById("refreshWorkspaceButton"),
  reviewPolicySelect: document.getElementById("reviewPolicySelect"),
  beepModeSelect: document.getElementById("beepModeSelect"),
  itemList: document.getElementById("itemList"),
  itemCount: document.getElementById("itemCount"),
  itemForm: document.getElementById("itemForm"),
  itemTitleInput: document.getElementById("itemTitleInput"),
  itemBodyInput: document.getElementById("itemBodyInput"),
  itemTypeLabel: document.getElementById("itemTypeLabel"),
  createNoteButton: document.getElementById("createNoteButton"),
  createTodoButton: document.getElementById("createTodoButton"),
  captureForm: document.getElementById("captureForm"),
  captureKindSelect: document.getElementById("captureKindSelect"),
  captureKindLabel: document.getElementById("captureKindLabel"),
  captureBodyInput: document.getElementById("captureBodyInput"),
  imageCaptureFields: document.getElementById("imageCaptureFields"),
  imageCaptureInput: document.getElementById("imageCaptureInput"),
  imagePreview: document.getElementById("imagePreview"),
  processCaptureButton: document.getElementById("processCaptureButton"),
  askBeepButton: document.getElementById("askBeepButton"),
  lockToggleButton: document.getElementById("lockToggleButton"),
  selectedItem: document.getElementById("selectedItem"),
  sourceLayer: document.getElementById("sourceLayer"),
  derivedLayer: document.getElementById("derivedLayer"),
  secondaryLayer: document.getElementById("secondaryLayer"),
  runList: document.getElementById("runList"),
  proposalList: document.getElementById("proposalList"),
};

function setStatus(message, isError = false) {
  elements.statusText.textContent = message;
  elements.statusText.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function token() {
  return elements.operatorTokenInput.value.trim();
}

function saveToken() {
  const nextToken = token();
  if (nextToken) localStorage.setItem(TOKEN_KEY, nextToken);
}

function ensureToken() {
  const current = token();
  if (current) return current;
  const prompted = window.prompt("Operator bearer token");
  if (prompted && prompted.trim()) {
    elements.operatorTokenInput.value = prompted.trim();
    saveToken();
    return prompted.trim();
  }
  throw new Error("Operator token is required for API calls.");
}

async function api(path, options = {}) {
  const headers = {
    authorization: \`Bearer \${ensureToken()}\`,
    ...options.headers,
  };
  let body = options.body;
  if (body && typeof body !== "string") {
    if (!(body instanceof FormData)) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(body);
    }
  }
  const response = await fetch(path, { ...options, headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || \`Request failed with \${response.status}\`);
  }
  return payload;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function text(tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value == null || value === "" ? "Untitled" : String(value);
  return node;
}

function empty(node, message) {
  clearChildren(node);
  node.className = node.className.includes("layer-stack") ? "layer-stack empty-state" : "empty-state";
  node.textContent = message;
}

function workspaceItem(id) {
  return state.workspace?.items?.[id] || null;
}

function selectedItem() {
  return workspaceItem(state.selectedItemId);
}

function selectedSource() {
  return state.workspace?.sourceArtifacts?.[state.selectedSourceId] || null;
}

function isPromotableProposal(proposal) {
  return PROMOTABLE_PROPOSAL_KINDS.has(proposal.kind);
}

function sortedRecords(records, order = []) {
  const seen = new Set(order);
  return [
    ...order.map((id) => records?.[id]).filter(Boolean),
    ...Object.values(records || {}).filter((record) => !seen.has(record.id)),
  ];
}

function shortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  return value >= 1024 * 1024 ? \`\${(value / (1024 * 1024)).toFixed(1)} MB\` : \`\${Math.max(1, Math.round(value / 1024))} KB\`;
}

function renderWorkspace() {
  const workspace = state.workspace;
  if (!workspace) return;
  const items = sortedRecords(workspace.items, workspace.itemOrder);
  if (!state.selectedItemId && items[0]) state.selectedItemId = items[0].id;
  renderItems(items);
  renderSelection();
  renderRuns();
  renderProposals();
}

function renderItems(items) {
  clearChildren(elements.itemList);
  elements.itemCount.textContent = String(items.length);
  if (!items.length) {
    empty(elements.itemList, "No notes or todos yet.");
    return;
  }
  elements.itemList.className = "scroll-list";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "item-button";
    button.setAttribute("aria-current", item.id === state.selectedItemId ? "true" : "false");
    button.append(text("span", item.title, "row-title"));
    button.append(text("span", \`\${item.type} | \${item.accessPolicy?.locked ? "locked" : "editable"}\`, "row-meta"));
    button.addEventListener("click", () => {
      state.selectedItemId = item.id;
      state.selectedSourceId = item.sourceArtifactIds?.[0] || null;
      renderWorkspace();
    });
    elements.itemList.append(button);
  }
}

function appendRecord(node, title, body, meta = "") {
  const row = document.createElement("article");
  row.className = "record-row";
  row.append(text("div", title, "row-title"));
  if (body) row.append(text("div", body, "row-body"));
  if (meta) row.append(text("div", meta, "row-meta"));
  node.append(row);
  return row;
}

function sourceImageFile(source) {
  return source?.kind === "image" && Array.isArray(source.media?.files) ? source.media.files[0] || null : null;
}

function renderSourceRecord(node, source) {
  const file = sourceImageFile(source);
  const title = file ? "Image capture" : "Original capture";
  const body = source.body || file?.name || "Empty capture";
  const row = appendRecord(node, title, body, shortDate(source.createdAt));
  const meta = [file?.mimeType, formatBytes(file?.sizeBytes), file?.workspacePath ? "stored in workspace" : ""]
    .filter(Boolean)
    .join(" | ");
  if (meta) row.append(text("div", meta, "row-meta"));
  return row;
}

function renderSelection() {
  const item = selectedItem();
  if (!item) {
    empty(elements.selectedItem, "Select or create an item.");
    const source = selectedSource();
    if (source) {
      clearChildren(elements.sourceLayer);
      elements.sourceLayer.className = "layer-stack";
      renderSourceRecord(elements.sourceLayer, source);
      const derived = (source.derivedArtifactIds || []).map((id) => state.workspace?.derivedArtifacts?.[id]).filter(Boolean);
      clearChildren(elements.derivedLayer);
      elements.derivedLayer.className = "layer-stack";
      if (derived.length) {
        for (const artifact of derived) appendRecord(elements.derivedLayer, artifact.kind, artifact.body, shortDate(artifact.createdAt));
      } else {
        empty(elements.derivedLayer, "No readable rendition yet.");
      }
    } else {
      empty(elements.sourceLayer, "No source selected.");
      empty(elements.derivedLayer, "No derived rendition yet.");
    }
    empty(elements.secondaryLayer, "Ask Beep to add secondary layer context.");
    elements.lockToggleButton.disabled = true;
    elements.askBeepButton.disabled = true;
    return;
  }

  elements.lockToggleButton.disabled = false;
  elements.askBeepButton.disabled = false;
  elements.lockToggleButton.textContent = item.accessPolicy?.locked ? "Unlock" : "Lock";
  clearChildren(elements.selectedItem);
  elements.selectedItem.className = "selected-item";
  elements.selectedItem.append(text("div", item.title, "row-title"));
  elements.selectedItem.append(text("div", item.body || "No body text.", "row-body"));
  elements.selectedItem.append(text("div", \`\${item.type} | \${item.accessPolicy?.locked ? "locked" : "editable"}\`, "row-meta"));

  const sourceIds = [...(item.sourceArtifactIds || [])];
  const source = sourceIds.includes(state.selectedSourceId)
    ? selectedSource()
    : state.workspace?.sourceArtifacts?.[sourceIds[0]] || null;
  clearChildren(elements.sourceLayer);
  elements.sourceLayer.className = "layer-stack";
  if (source) {
    state.selectedSourceId = source.id;
    renderSourceRecord(elements.sourceLayer, source);
  } else {
    empty(elements.sourceLayer, "This item has no original capture.");
  }

  const derived = [...(item.derivedArtifactIds || []), ...(source?.derivedArtifactIds || [])]
    .map((id) => state.workspace?.derivedArtifacts?.[id])
    .filter(Boolean);
  clearChildren(elements.derivedLayer);
  elements.derivedLayer.className = "layer-stack";
  if (derived.length) {
    for (const artifact of derived) appendRecord(elements.derivedLayer, artifact.kind, artifact.body, shortDate(artifact.createdAt));
  } else {
    empty(elements.derivedLayer, "No readable rendition yet.");
  }

  const comments = (item.agentCommentIds || []).map((id) => state.workspace?.comments?.[id]).filter(Boolean);
  const proposals = (item.proposalIds || []).map((id) => state.workspace?.proposals?.[id]).filter(Boolean);
  clearChildren(elements.secondaryLayer);
  elements.secondaryLayer.className = "layer-stack";
  if (!comments.length && !proposals.length) {
    empty(elements.secondaryLayer, "No Beep comments or proposals yet.");
    return;
  }
  for (const comment of comments) appendRecord(elements.secondaryLayer, "Beep comment", comment.body, shortDate(comment.createdAt));
  for (const proposal of proposals) {
    const row = appendRecord(elements.secondaryLayer, \`Proposal: \${proposal.title}\`, proposal.body, proposal.status);
    if (proposal.status === "pending") row.append(proposalActions(proposal));
  }
}

function proposalActions(proposal) {
  const actions = document.createElement("div");
  actions.className = "proposal-actions";
  if (isPromotableProposal(proposal)) {
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accept";
    accept.addEventListener("click", () => acceptProposal(proposal.id));
    actions.append(accept);
  }
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "danger-button";
  reject.textContent = "Reject";
  reject.addEventListener("click", () => rejectProposal(proposal.id));
  actions.append(reject);
  return actions;
}

function renderRuns() {
  const runs = sortedRecords(state.workspace?.runs, state.workspace?.runOrder).slice(0, 8);
  clearChildren(elements.runList);
  if (!runs.length) {
    empty(elements.runList, "No pipeline activity yet.");
    return;
  }
  elements.runList.className = "run-list";
  for (const run of runs) {
    appendRecord(elements.runList, run.kind, \`\${run.reviewPolicy} | \${run.status}\`, shortDate(run.updatedAt || run.createdAt));
  }
}

function renderProposals() {
  const proposals = Object.values(state.workspace?.proposals || {}).filter((proposal) => proposal.status === "pending");
  clearChildren(elements.proposalList);
  if (!proposals.length) {
    empty(elements.proposalList, "No pending proposals.");
    return;
  }
  elements.proposalList.className = "proposal-list";
  for (const proposal of proposals) {
    const row = appendRecord(elements.proposalList, proposal.title, proposal.body, proposal.kind);
    row.className = "proposal-row";
    row.append(proposalActions(proposal));
  }
}

async function loadWorkspace() {
  setStatus("Loading workspace...");
  const payload = await api("/api/notes/workspace");
  state.workspace = payload.workspace;
  renderWorkspace();
  setStatus("Workspace loaded.");
}

async function createItem(type) {
  const title = elements.itemTitleInput.value.trim();
  const body = elements.itemBodyInput.value.trim();
  if (!title) throw new Error("A title is required.");
  setStatus(\`Creating \${type}...\`);
  const payload = await api("/api/notes/items", {
    method: "POST",
    body: { type, title, body },
  });
  state.selectedItemId = payload.item.id;
  elements.itemTitleInput.value = "";
  elements.itemBodyInput.value = "";
  await loadWorkspace();
}

function renderImagePreview() {
  clearChildren(elements.imagePreview);
  if (!state.captureImage) {
    elements.imagePreview.className = "image-preview empty-state";
    elements.imagePreview.textContent = "No image selected.";
    return;
  }
  elements.imagePreview.className = "image-preview";
  if (HEIF_CAPTURE_MIME_TYPES.has(state.captureImage.mimeType)) {
    elements.imagePreview.append(text("div", "HEIC/HEIF selected. Preview appears after conversion.", "row-body"));
  } else {
    const image = document.createElement("img");
    image.src = state.captureImage.previewUrl;
    image.alt = state.captureImage.name || "Selected image";
    elements.imagePreview.append(image);
  }
  elements.imagePreview.append(text("div", \`\${state.captureImage.name} | \${formatBytes(state.captureImage.sizeBytes)}\`, "row-meta"));
}

function captureMimeType(file) {
  const browserMimeType = String(file.type || "").trim().toLowerCase();
  if (IMAGE_CAPTURE_MIME_TYPES.has(browserMimeType)) return browserMimeType;
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return browserMimeType;
}

async function updateCaptureImage() {
  const file = elements.imageCaptureInput.files?.[0] || null;
  if (!file) {
    clearCaptureImageSelection();
    return;
  }
  clearCaptureImageSelection();
  const mimeType = captureMimeType(file);
  if (!IMAGE_CAPTURE_MIME_TYPES.has(mimeType)) {
    throw new Error(\`Unsupported image type: \${mimeType || "unknown"}\`);
  }
  if (file.size > MAX_IMAGE_CAPTURE_BYTES) throw new Error("Image must be 40 MB or smaller.");
  state.captureImage = {
    file,
    name: file.name || "image",
    mimeType,
    sizeBytes: file.size,
    previewUrl: HEIF_CAPTURE_MIME_TYPES.has(mimeType) ? "" : URL.createObjectURL(file),
    detail: "auto",
  };
  renderImagePreview();
}

function clearCaptureImageSelection() {
  if (state.captureImage?.previewUrl) URL.revokeObjectURL(state.captureImage.previewUrl);
  state.captureImage = null;
  renderImagePreview();
}

function buildCapturePayload() {
  const body = elements.captureBodyInput.value.trim();
  if (state.captureKind === "image") {
    if (!state.captureImage) throw new Error("An image file is required.");
    const formData = new FormData();
    formData.set("kind", "image");
    formData.set("body", body);
    formData.set("detail", state.captureImage.detail || "auto");
    formData.set("image", state.captureImage.file, state.captureImage.name);
    return formData;
  }
  if (!body) throw new Error("Capture text is required.");
  return { kind: "text", body };
}

async function processCapture() {
  const capture = buildCapturePayload();
  setStatus("Creating original capture...");
  const created = await api("/api/notes/captures", {
    method: "POST",
    body: capture,
  });
  state.selectedSourceId = created.source.id;
  setStatus("Processing capture...");
  await api(\`/api/notes/captures/\${encodeURIComponent(created.source.id)}/process\`, {
    method: "POST",
    body: runOptions(),
  });
  elements.captureBodyInput.value = "";
  elements.imageCaptureInput.value = "";
  clearCaptureImageSelection();
  await loadWorkspace();
}

function runOptions() {
  return {
    reviewPolicy: elements.reviewPolicySelect.value,
    beepMode: elements.beepModeSelect.value,
  };
}

async function askBeep() {
  const item = selectedItem();
  if (!item) throw new Error("Select an item before asking Beep.");
  setStatus("Asking Beep...");
  await api(\`/api/notes/items/\${encodeURIComponent(item.id)}/ask-beep\`, {
    method: "POST",
    body: runOptions(),
  });
  await loadWorkspace();
}

async function toggleLock() {
  const item = selectedItem();
  if (!item) throw new Error("Select an item first.");
  const action = item.accessPolicy?.locked ? "unlock" : "lock";
  setStatus(\`\${action === "lock" ? "Locking" : "Unlocking"} item...\`);
  await api(\`/api/notes/items/\${encodeURIComponent(item.id)}/\${action}\`, { method: "POST", body: {} });
  await loadWorkspace();
}

async function acceptProposal(proposalId) {
  setStatus("Accepting proposal...");
  const payload = await api(\`/api/notes/proposals/\${encodeURIComponent(proposalId)}/accept\`, {
    method: "POST",
    body: {},
  });
  state.selectedItemId = payload.item?.id || state.selectedItemId;
  await loadWorkspace();
}

async function rejectProposal(proposalId) {
  setStatus("Rejecting proposal...");
  await api(\`/api/notes/proposals/\${encodeURIComponent(proposalId)}/reject\`, {
    method: "POST",
    body: {},
  });
  await loadWorkspace();
}

function bindAsync(node, eventName, callback) {
  node.addEventListener(eventName, async (event) => {
    event.preventDefault();
    try {
      saveToken();
      await callback(event);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
}

function setItemType(type) {
  state.itemType = type;
  elements.itemTypeLabel.textContent = type;
  elements.itemTitleInput.placeholder = type === "todo" ? "Todo title" : "Note title";
  elements.itemBodyInput.placeholder = type === "todo" ? "Todo details" : "Write a note";
}

function setCaptureKind(kind) {
  state.captureKind = kind === "image" ? "image" : "text";
  elements.captureKindSelect.value = state.captureKind;
  elements.captureKindLabel.textContent = state.captureKind;
  elements.imageCaptureFields.hidden = state.captureKind !== "image";
  elements.captureBodyInput.placeholder =
    state.captureKind === "image" ? "Optional caption, context, or instruction" : "Captured notebook text, voice transcript, or paste";
}

function init() {
  elements.operatorTokenInput.value = localStorage.getItem(TOKEN_KEY) || "";
  elements.operatorTokenInput.addEventListener("change", saveToken);
  elements.clearTokenButton.addEventListener("click", () => {
    elements.operatorTokenInput.value = "";
    localStorage.removeItem(TOKEN_KEY);
    setStatus("Operator token cleared.");
  });
  elements.createNoteButton.addEventListener("click", () => setItemType("note"));
  elements.createTodoButton.addEventListener("click", () => setItemType("todo"));
  elements.captureKindSelect.addEventListener("change", () => setCaptureKind(elements.captureKindSelect.value));
  elements.imageCaptureInput.addEventListener("change", async () => {
    try {
      await updateCaptureImage();
    } catch (error) {
      state.captureImage = null;
      renderImagePreview();
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
  bindAsync(elements.refreshWorkspaceButton, "click", loadWorkspace);
  bindAsync(elements.itemForm, "submit", () => createItem(state.itemType));
  bindAsync(elements.captureForm, "submit", processCapture);
  bindAsync(elements.askBeepButton, "click", askBeep);
  bindAsync(elements.lockToggleButton, "click", toggleLock);
  elements.askBeepButton.disabled = true;
  elements.lockToggleButton.disabled = true;
  setCaptureKind("text");
  renderImagePreview();
  if (token()) {
    loadWorkspace().catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
  }
}

init();
`;

function sendText(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendMethodNotAllowed(response) {
  response.writeHead(405, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify({ ok: false, error: "method not allowed" }, null, 2)}\n`);
}

export function handleNotesDemoRoute({ request, response, pathname }) {
  const routes = {
    "/notes": ["text/html", HTML],
    "/notes/app.js": ["text/javascript", JS],
    "/notes/styles.css": ["text/css", CSS],
  };
  const route = routes[pathname];
  if (!route) return false;
  if (request.method !== "GET") {
    sendMethodNotAllowed(response);
    return true;
  }
  sendText(response, 200, route[0], route[1]);
  return true;
}
