import test from "node:test";
import assert from "node:assert/strict";
import { MemoryCoordinator } from "../runtime/src/memory-coordinator.mjs";

test("MemoryCoordinator recalls Hindsight and returns external memory hints", async () => {
  const calls = [];
  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        recallBudget: "high",
        recallMaxTokens: 4096,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
      recall: async (request) => {
        calls.push(request);
        return { results: [{ id: "m1", text: "Use Pi context hook.", type: "experience" }] };
      },
    },
    now: () => "2026-05-31T10:00:00.000Z",
  });

  const result = await coordinator.recallForContext({
    runtimeSessionId: "agent_beep",
    prompt: "Continue the integration",
    messages: [{ role: "user", content: "Remember: use Pi context hook." }],
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].bankId, "beep:local:ash:beep2");
  assert.match(calls[0].query, /Continue the integration/);
  assert.equal(result.externalMemoryHints.memories[0].text, "Use Pi context hook.");
});
