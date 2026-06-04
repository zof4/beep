import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMemoryMessagesFromEntries,
  canonicalMessagesFromEntries,
} from "../runtime/src/lcm-service.mjs";

function entry(index, message) {
  return {
    lineIndex: index,
    entryId: `entry-${index}`,
    parentId: index > 0 ? `entry-${index - 1}` : null,
    timestamp: `2026-06-04T02:39:${String(index).padStart(2, "0")}.000Z`,
    message,
    rawSha256: `sha-${index}`,
  };
}

test("canonicalMemoryMessagesFromEntries drops successful no-output tool results", () => {
  const entries = [
    entry(1, { role: "user", content: "Research Thai restaurants." }),
    entry(2, {
      role: "toolResult",
      toolCallId: "call-empty",
      toolName: "bash",
      content: [{ type: "text", text: "(no output)" }],
      isError: false,
    }),
    entry(3, { role: "assistant", content: "Thai Bowl Cafe is the best pick." }),
  ];

  assert.equal(canonicalMessagesFromEntries(entries).length, 3);

  const memoryMessages = canonicalMemoryMessagesFromEntries(entries);

  assert.deepEqual(memoryMessages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(memoryMessages[0].beepSessionEntryId, "entry-1");
  assert.equal(memoryMessages[1].beepSessionEntryId, "entry-3");
});

test("canonicalMemoryMessagesFromEntries keeps meaningful and errored tool results", () => {
  const entries = [
    entry(1, {
      role: "toolResult",
      toolCallId: "call-output",
      toolName: "bash",
      content: [{ type: "text", text: "Thai Bowl Cafe" }],
      isError: false,
    }),
    entry(2, {
      role: "toolResult",
      toolCallId: "call-error",
      toolName: "bash",
      content: [{ type: "text", text: "(no output)" }],
      isError: true,
    }),
  ];

  const memoryMessages = canonicalMemoryMessagesFromEntries(entries);

  assert.equal(memoryMessages.length, 2);
  assert.deepEqual(memoryMessages.map((message) => message.toolCallId), ["call-output", "call-error"]);
});
