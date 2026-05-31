import test from "node:test";
import assert from "node:assert/strict";
import { messagesWithExternalMemoryHints } from "../runtime/src/lcm-service.mjs";

test("messagesWithExternalMemoryHints prepends non-persistable Hindsight context", () => {
  const messages = messagesWithExternalMemoryHints(
    [{ role: "user", content: "Continue." }],
    {
      source: "hindsight",
      persist: false,
      stripOnRetain: true,
      bankId: "beep:local:ash:beep2",
      query: "Continue.",
      generatedAt: "2026-05-31T10:00:00.000Z",
      memories: [{ id: "m1", text: "Use a local sidecar.", kind: "world" }],
    },
  );

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].beepEphemeralContext.persist, false);
  assert.equal(messages[1].role, "user");
});
