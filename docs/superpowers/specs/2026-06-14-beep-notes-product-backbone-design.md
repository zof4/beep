# Beep Notes Product Backbone Design

## Purpose

This design defines the first rebuild slice for a Beep-backed note, todo,
calendar, research, and planning product. The first implementation should be a
demo-grade local web product that proves the backbone behavior while remaining
disposable before the eventual SwiftUI app.

The existing SwiftUI note branch is useful as domain and behavior reference,
but its product design and client-owned architecture should not be revived.
The new direction is server-owned workspace state, Beep-backed workflows, and a
product demo UI that maps cleanly to Apple platform patterns later.

## Product Direction

The product is a unified workspace for notes, todos, calendar drafts, research,
planner conversations, reminders, and agent-authored suggestions. The user can
create normal notes and todos directly, then ask Beep to read allowed context
and add comments, questions, extracted tasks, estimates, research packets, and
draft schedule blocks.

The app should feel like a productivity workspace first, not a developer
console. Photo or handwritten-note processing is one capture path, not the
boundary of the product. The same backbone must also support typed notes,
manual todos, calendar planning, recurring reminders, research, semantic
search, privacy locks, and long-running Beep memory.

The chosen first direction is a local web product demo backed by reusable
domain, pipeline, gateway, and schema modules. The web UI is a real product
demo, but it is not the final client architecture.

## Approved Approach

The selected approach is a local web product demo over the real backbone.

Benefits:

- Fastest path to test the Beep-backed product behavior.
- Can be opened from the laptop and phone browser during local development.
- Lets the team inspect runs, artifacts, proposals, and privacy behavior.
- Avoids repeating the SwiftUI prototype mistake before the backbone is solid.
- Keeps backend APIs, schemas, tests, and gateway contracts reusable for the
  later SwiftUI app.

Alternatives considered:

- Minimal SwiftUI shell first. This would test iPhone feel earlier, but would
  slow iteration and pull attention back into app-shell design.
- Dual thin clients. This would prove API independence, but creates too many
  moving parts before the product backbone is stable.

## Product Demo Role

The local web demo should serve as a believable product demo and a test harness.
It should not open as a raw run console. The first screen should show a useful
workspace with notes, todos, calendar drafts, research, and agent suggestions.

The demo must support:

- Creating notes.
- Creating todos.
- Selecting workspace items.
- Asking Beep to read selected or scoped context.
- Viewing Beep comments attached to notes, todos, and calendar drafts.
- Viewing proposed todos, schedule blocks, research packets, and estimates.
- Accepting, editing, rejecting, and rerunning proposals.
- Inspecting source links and run details when needed.
- Exercising Step Review, First Read Checkpoint, and Autopilot modes.

Debugging details should be available through an Agent Runs area and inspector
details, but they should not dominate the default product surface.

## Apple HIG Direction

The demo should follow Apple Human Interface Guidelines
(https://developer.apple.com/design/human-interface-guidelines/) as the
platform style reference: clear navigation, native-feeling controls, direct
manipulation, progressive disclosure, clear state, restrained visual language,
and predictable toolbar and inspector patterns.

The web UI should map later to SwiftUI concepts:

- Sidebar maps to `NavigationSplitView`.
- Content pane maps to the selected workspace area or item detail.
- Inspector maps to item metadata, Beep comments, proposals, source links, and
  run status.
- Toolbar maps to primary actions such as New Note, New Todo, Ask Beep,
  Process Note, Draft Schedule, and Research This.

The visual direction is restrained and productivity-focused. Use dense but calm
layouts, standard controls, clear selection states, useful empty states, and no
decorative glass or marketing hero composition.

## Workspace Model

The backbone is a workspace graph. Notes, todos, calendar blocks, research
packets, derived artifacts, Beep comments, and proposals are linked objects
rather than separate app silos.

Core records:

- `WorkspaceItem`: user-facing object with facets such as note, todo, calendar
  block, and research packet.
- `SourceArtifact`: immutable original input such as typed text, image capture,
  imported note, or later transcript.
- `DerivedArtifact`: readable rendition, formatted note, summary, extracted
  structure, or other additive transformation.
- `AgentComment`: Beep-authored question, observation, ambiguity note, or
  planning comment attached to an item or artifact.
- `Proposal`: draft todo, draft calendar block, draft research packet, suggested
  edit, duration estimate, priority order, or dependency.
- `Relationship`: graph edge such as came-from, linked-to, depends-on,
  scheduled-from, follow-up-for, or related-to.
- `PipelineRun`: Beep workflow with inputs, stages, outputs, review policy,
  status, validation state, and error records.
- `AccessPolicy`: lock state, allowed visibility, temporary grants, and audit
  history.

User-created objects and Beep-created objects must share the graph. For example,
a user-created note can receive Beep comments, produce proposed todos, link to a
research packet, and produce draft schedule blocks. A user-created todo can
receive Beep comments, estimates, dependencies, and suggested time blocks.

## Source Preservation

Agent output is additive and linked. It never overwrites the original.

For captures, the original note, image, or transcript is stored as a source
artifact. Beep can create a readable rendition, formatted note, comments,
proposals, and research packets. Those outputs are separate artifacts with
source links. If the readable rendition is wrong, the user can edit or rerun
that layer without mutating the source.

For normal user-created notes and todos, Beep comments and proposals attach in a
secondary layer. The user can promote a proposal into a first-class workspace
item, but Beep does not silently mutate the original item.

## Beep Workflows

Every Beep action runs as a structured workflow, even when the user sees one
command.

The note-processing workflow contains these stages:

1. Readable rendition: create a legible reconstruction from the source.
2. Formatted note: create a cleaned note that preserves meaning.
3. Agent commentary: add observations, questions, organization ideas, and
   ambiguity notes.
4. Draft extraction: propose todos, research packets, references, definitions,
   and schedule blocks.
5. Planner pass: estimate duration, order tasks, flag constraints, and produce
   a draft schedule when asked.

General `Ask Beep` workflows can be shorter:

1. Read allowed context.
2. Add comments.
3. Optionally create proposals linked to the source item or linked cluster.

The implementation can test whether these stages should run as separate model
turns or one larger turn. That choice is an implementation detail. The
observable product model stays the same: stages, artifacts, validation, and
links are recorded separately.

## Review Policies

The workflow engine supports three review policies. These are not separate code
paths. They are the same pipeline with different pause points.

- `stepReview`: pause after every stage. This is best for prompt tuning,
  schema debugging, and careful review.
- `firstReadCheckpoint`: pause after readable rendition or first
  interpretation, then continue if approved. This is the best early default.
- `autopilot`: run all stages and return an organized result bundle. This is
  best once behavior is trusted.

The user-facing product can expose this as a per-run setting and a global
preference.

## Beep Gateway And Tools

The app must not give Beep direct database access or uncontrolled UI mutation
access. Beep interacts through typed tools exposed by the gateway. The gateway
owns authorization, privacy checks, schema validation, audit records, and the
distinction between comments, proposals, and committed workspace items.

Initial tool families:

- `workspace.search`: text and semantic search over allowed items.
- `workspace.readItem`: read a specific unlocked item plus safe metadata.
- `workspace.readLinkedCluster`: read an item and approved linked context.
- `comment.create`: attach Beep commentary to a workspace item or artifact.
- `proposal.create`: create a typed draft output with source links.
- `todo.propose`: propose todos extracted from notes, comments, or clusters.
- `calendar.proposeBlock`: propose draft schedule blocks.
- `research.createPacket`: create source-backed research notes.
- `privacy.requestAccess`: ask the user for temporary access to locked content.
- `pipeline.reportProgress`: update visible run status.

Beep writes should be stored as structured events with type, source item IDs,
source artifact IDs, body, uncertainty fields when useful, validation state, and
approval state. Accepted proposals become normal workspace items. Rejected
proposals remain in audit and history but stop appearing as active suggestions.

For the first local demo, these tools can route to the local Beep session on the
laptop. Later, the same contracts can move behind Oracle-hosted Beep.

## Privacy Model

Locked items are metadata-visible but content-hidden. Beep can know a locked
item exists if that helps the user understand context gaps, but it cannot read,
index, summarize, or use locked contents in memory without an explicit grant.

Privacy rules:

- Lock state overrides global agent mode and review policy.
- Search results for locked items return safe metadata only.
- Beep can request temporary access with a clear reason and scope.
- Access grants are logged, revocable, and time or run scoped.
- Locked content is excluded from semantic memory and derived artifacts unless
  granted.

## Long Memory, Reminders, And Planner Mode

The first demo should establish the contracts for these capabilities, even if
some implementations start as local or replayed behavior.

Long memory:

- Beep can search and recall allowed notes, todos, comments, research packets,
  and transcripts.
- Agent answers should cite source items and artifacts.
- Locked content is excluded unless access is granted.

Planner mode:

- Beep can discuss priorities, order, dependencies, constraints, estimates, and
  draft schedules with the user.
- Planner outputs should be comments and proposals first.
- Estimated durations can later learn from repeated task names and completion
  history.

Recurring reminders and heartbeat:

- Scheduled runs can prepare comments, research, summaries, or draft schedule
  changes before an item is due.
- The first product behavior should be draft generation, not autonomous
  external action.
- Later trusted actions must still route through the gateway and approvals.

Location flags:

- Location-aware behavior is outside the first implementation, but the model
  should allow future reminder facets and tool policy for location triggers.

## Branch Salvage Rules

The existing `codex/note-workspace-stability` branch should be mined, not
merged. It predates the current control-plane and runtime boundary and would
delete newer backend work if merged directly.

Keep or adapt:

- Universal item plus facet vocabulary.
- Todo bucketing: Active, Scheduled, Future, Archive.
- Reminder lifecycle: scheduled, fired, snoozed, acknowledged.
- Relationship graph vocabulary.
- Reducer and command behavior.
- Domain tests that describe behavior without depending on SwiftUI.
- Local JSON persistence as a dev-store or client-cache reference.

Reference only:

- `WorkspaceAppModel` as a list of client actions and state transitions.
- Notification scheduling as future client behavior.
- Calendar layout math as possible later reference.
- Note formatting tests as possible future native editor reference.
- Existing note specs as historical context.

Discard:

- Current SwiftUI product design.
- Liquid Glass styling experiments.
- Large mixed-responsibility view files.
- Client-owned source-of-truth assumptions.
- Any product direction where the agent UI dominates normal note, todo, and
  calendar use.

## Implementation Boundaries

The first build should split code into durable backbone modules and a disposable
demo UI.

Durable modules:

- `workspace-domain`: models, schemas, reducers or event appliers,
  relationships, privacy rules, and proposal acceptance.
- `pipeline-engine`: stages, review policies, run state, validation, retry, and
  rerun behavior.
- `beep-gateway`: local Beep client, tool contract adapters, structured output
  validation, and audit events.

Disposable but demo-grade module:

- `demo-web`: Apple HIG-inspired product demo UI that consumes the backbone
  APIs.

Supporting artifact:

- `salvage-audit`: short document classifying old branch files into
  keep/adapt, reference, or discard.

## Verification Strategy

The first implementation should be testable without relying on live model calls
for every check.

Required verification:

- Domain unit tests for source immutability, relationships, proposal acceptance,
  proposal rejection, and privacy locks.
- Unit tests proving `stepReview`, `firstReadCheckpoint`, and `autopilot` use
  the same pipeline with different pause points.
- Contract tests for gateway tool schemas and structured output validation.
- Replay tests using canned Beep responses for the note-processing workflow and
  general `Ask Beep` workflow.
- Live smoke against local Beep for one happy path: create a note, ask Beep,
  receive comments and proposals, accept a todo.
- Browser smoke for the product demo: create note, create todo, select item,
  view Beep comments, accept and reject drafts, inspect source links.

## First Slice Scope

Included:

- Server-owned workspace graph.
- Manual note and todo creation in the web demo.
- Beep comments on selected allowed notes and todos.
- Proposal creation for todos, research packets, estimates, and draft schedule
  blocks.
- Note-processing pipeline for source-preserved captures.
- Review policies and run inspection.
- Privacy lock behavior at the domain and gateway level.
- Branch salvage audit.

Deferred:

- Final SwiftUI app.
- External calendar sync and commit.
- Real location triggers.
- Audio recording and transcription UI.
- Full rich text or handwritten selection UI.
- Production Oracle deployment.
- Autonomous external actions.

## Success Criteria

The design is successful when a local demo can show this path:

1. User creates a note and a todo.
2. User selects a note and asks Beep for comments.
3. Beep reads only allowed context through the gateway.
4. Beep attaches comments and proposes todos, estimates, research, or schedule
   blocks.
5. User accepts one proposal, rejects another, and can inspect source links.
6. Original user-authored content remains unchanged.
7. The same run can be replayed or stepped through under different review
   policies.

The web demo may be thrown away later. The backbone contracts, schemas, tests,
and behavior should survive the SwiftUI rebuild.
