import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExternalMemoryHints,
  renderExternalMemoryHintsAsMessages,
  stripInjectedHindsightMemory,
} from "../runtime/src/external-memory-hints.mjs";

test("buildExternalMemoryHints normalizes Hindsight recall results", () => {
  const hints = buildExternalMemoryHints({
    bankId: "beep:local:ash:beep2",
    query: "What did the user decide?",
    tags: ["project:beep2"],
    generatedAt: "2026-05-31T10:00:00.000Z",
    recall: {
      results: [
        {
          id: "mem_1",
          text: "Use a local Hindsight sidecar.",
          type: "world",
          document_id: "doc_1",
          tags: ["project:beep2"],
          mentioned_at: "2026-05-31T09:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(hints.persist, false);
  assert.equal(hints.stripOnRetain, true);
  assert.equal(hints.memories[0].documentId, "doc_1");
});

test("renderExternalMemoryHintsAsMessages creates non-persistable system context", () => {
  const messages = renderExternalMemoryHintsAsMessages({
    source: "hindsight",
    persist: false,
    stripOnRetain: true,
    bankId: "beep:local:ash:beep2",
    query: "deployment memory",
    generatedAt: "2026-05-31T10:00:00.000Z",
    memories: [{ id: "m1", text: "Everything must be local.", kind: "world" }],
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].beepEphemeralContext.source, "hindsight");
  assert.match(messages[0].content[0].text, /<hindsight_memories>/);
  assert.match(messages[0].content[0].text, /Everything must be local/);
});

test("stripInjectedHindsightMemory removes injected memory blocks before retain", () => {
  const cleaned = stripInjectedHindsightMemory(`User text
<hindsight_memories>
Injected memory
</hindsight_memories>
Assistant text`);

  assert.equal(cleaned, "User text\nAssistant text");
});
