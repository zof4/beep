import assert from "node:assert/strict";
import test from "node:test";
import { isAgentBusy, shouldPromoteAgentSubmit } from "../scripts/beep-chat-page-logic.mjs";

test("idle agent status promotes queued or steered input into a normal send", () => {
  assert.equal(
    shouldPromoteAgentSubmit({
      ok: true,
      activeRequestId: null,
      queueDepth: 0,
      paused: false,
      session: { phase: "idle" },
    }),
    true,
  );
});

test("agent status with active work does not promote input", () => {
  assert.equal(isAgentBusy({ activeRequestId: "agent_req_123", queueDepth: 0, session: { phase: "idle" } }), true);
  assert.equal(isAgentBusy({ activeRequestId: null, queueDepth: 1, session: { phase: "idle" } }), true);
  assert.equal(isAgentBusy({ activeRequestId: null, queueDepth: 0, session: { phase: "agent_running" } }), true);
});

test("paused or unavailable agent status does not promote input", () => {
  assert.equal(shouldPromoteAgentSubmit({ ok: true, paused: true, queueDepth: 0, activeRequestId: null }), false);
  assert.equal(shouldPromoteAgentSubmit(null), false);
  assert.equal(shouldPromoteAgentSubmit({ ok: false, queueDepth: 0, activeRequestId: null }), false);
});
