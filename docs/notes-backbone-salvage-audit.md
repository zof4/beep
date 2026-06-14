# Note Workspace Branch Salvage Audit

Source branch: `codex/note-workspace-stability`

Decision: mine the branch for domain vocabulary and tests. Do not merge it.

## Keep Or Adapt

- `apps/NoteWorkspace/NoteWorkspace/Domain/WorkspaceItem.swift`: adapt universal item plus facet vocabulary into the server-owned workspace domain.
- `apps/NoteWorkspace/NoteWorkspace/Domain/WorkspaceState.swift`: adapt normalized state and selectors into the server store projection.
- `apps/NoteWorkspace/NoteWorkspace/Domain/WorkspaceReducer.swift`: adapt command-style mutation into pure event appliers.
- `apps/NoteWorkspace/NoteWorkspace/Domain/TodoBuckets.swift`: adapt Active, Scheduled, Future, and Archive grouping after the first comments/proposals slice.
- `apps/NoteWorkspace/NoteWorkspace/Domain/DedupeSuggestionService.swift`: adapt as a cheap local heuristic after workspace search exists.
- `apps/NoteWorkspace/NoteWorkspaceTests/WorkspaceItemTests.swift`: use as behavioral reference for server-side item tests.
- `apps/NoteWorkspace/NoteWorkspaceTests/WorkspaceReducerTests.swift`: use as behavioral reference for server-side event applier tests.
- `apps/NoteWorkspace/NoteWorkspaceTests/TodoBucketsTests.swift`: use as behavioral reference for server-side grouping tests.
- `apps/NoteWorkspace/NoteWorkspaceTests/DedupeSuggestionServiceTests.swift`: use as behavioral reference for server-side dedupe heuristic tests.

## Reference Only

- `apps/NoteWorkspace/NoteWorkspace/App/WorkspaceAppModel.swift`: reference as a list of client actions.
- `apps/NoteWorkspace/NoteWorkspace/Persistence/WorkspaceRepository.swift`: reference local JSON persistence as a client cache pattern, not source of truth.
- `apps/NoteWorkspace/NoteWorkspace/Views/CalendarPageView.swift`: reference calendar lane math only when calendar drag scheduling is implemented.
- `apps/NoteWorkspace/NoteWorkspace/Views/NoteRichTextFormatter.swift`: reference implementation behavior only when native note editing is rebuilt.
- `apps/NoteWorkspace/NoteWorkspaceTests/NoteMarkdownFormatterTests.swift`: reference actual selection-formatting tests only when native note editing is rebuilt.
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
