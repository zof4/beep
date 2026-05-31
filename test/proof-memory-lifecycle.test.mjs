import test from "node:test";
import assert from "node:assert/strict";
import { buildExternalMemoryHints, renderExternalMemoryHintsAsMessages } from "../runtime/src/external-memory-hints.mjs";
import { messagesWithExternalMemoryHints, summarizeCanonicalMessages } from "../runtime/src/lcm-service.mjs";

test("Hindsight canary is model-visible but excluded from canonical summary", () => {
  const canonical = [{ role: "user", content: "Continue the Beep work." }];
  const hints = buildExternalMemoryHints({
    bankId: "beep:local:ash:beep2",
    query: "Continue the Beep work.",
    recall: {
      results: [{ id: "canary", text: "HINDSIGHT_CANARY_LOCAL_ONLY", type: "world" }],
    },
  });
  const assembly = messagesWithExternalMemoryHints(canonical, hints);
  const rendered = renderExternalMemoryHintsAsMessages(hints)[0].content[0].text;
  const summary = summarizeCanonicalMessages(canonical);

  assert.match(rendered, /HINDSIGHT_CANARY_LOCAL_ONLY/);
  assert.equal(summary.byRole.user, 1);
  assert.doesNotMatch(summary.assistantFinalText, /HINDSIGHT_CANARY_LOCAL_ONLY/);
  assert.equal(assembly[0].beepEphemeralContext.persist, false);
});

test("Hindsight failure leaves canonical LCM-only messages untouched", () => {
  const canonical = [{ role: "user", content: "Continue without memory." }];
  const assembly = messagesWithExternalMemoryHints(canonical, null);
  assert.deepEqual(assembly, canonical);
});
