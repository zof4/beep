import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.deepEqual(calls[0].tags, ["deployment:local", "user:ash", "project:beep2"]);
  assert.match(calls[0].query, /Continue the integration/);
  assert.equal(result.externalMemoryHints.memories[0].text, "Use Pi context hook.");
});

test("MemoryCoordinator degrades to no hints when Hindsight recall fails", async () => {
  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
      recall: async () => {
        throw new Error("sidecar down");
      },
    },
  });

  const result = await coordinator.recallForContext({
    runtimeSessionId: "agent_beep",
    prompt: "Continue",
    messages: [{ role: "user", content: "Continue" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.externalMemoryHints, null);
  assert.equal(result.error, "sidecar down");
});

test("MemoryCoordinator retainPiSessionSpan strips injected Hindsight memory and uses stable document id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beep-hindsight-"));
  const sessionPath = join(dir, "session.jsonl");
  const retained = [];
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", id: "s1", cwd: "/workspace", timestamp: "2026-05-31T10:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-05-31T10:00:01.000Z",
        message: { role: "user", content: "Remember local-only." },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        timestamp: "2026-05-31T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "<hindsight_memories>Injected</hindsight_memories>\nConfirmed local-only.",
            },
          ],
        },
      }),
    ].join("\n") + "\n",
  );

  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
      retain: async (request) => {
        retained.push(request);
        return { success: true };
      },
    },
    now: () => "2026-05-31T10:00:03.000Z",
  });

  const result = await coordinator.retainPiSessionSpan({
    runtimeSessionId: "agent_beep",
    requestId: "agent_req_1",
    sessionPath,
    fromMessageEntry: 0,
    nextMessageEntryCount: 2,
    queuePath: join(dir, "retain-queue.jsonl"),
  });

  assert.equal(result.ok, true);
  assert.equal(retained[0].bankId, "beep:local:ash:beep2");
  assert.equal(retained[0].items[0].document_id, "beep-pi:agent_beep:0:2");
  assert.match(retained[0].items[0].content, /Remember local-only/);
  assert.match(retained[0].items[0].content, /Confirmed local-only/);
  assert.doesNotMatch(retained[0].items[0].content, /Injected/);
  assert.equal(existsSync(join(dir, "retain-queue.jsonl")), false);
});

test("MemoryCoordinator retainPiSessionSpan disabled does not require or create queue file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beep-hindsight-"));
  const queuePath = join(dir, "retain-queue.jsonl");
  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: { enabled: false },
    },
  });

  const result = await coordinator.retainPiSessionSpan({
    runtimeSessionId: "agent_beep",
    requestId: "agent_req_1",
    sessionPath: join(dir, "missing-session.jsonl"),
    fromMessageEntry: 0,
    nextMessageEntryCount: 1,
    queuePath,
  });

  assert.deepEqual(result, { ok: true, enabled: false, retained: false });
  assert.equal(existsSync(queuePath), false);
});

test("MemoryCoordinator retainPiSessionSpan treats stripped-only Hindsight memory as empty content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beep-hindsight-"));
  const sessionPath = join(dir, "session.jsonl");
  const retained = [];
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", id: "s1", cwd: "/workspace", timestamp: "2026-05-31T10:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-05-31T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "<hindsight_memories>Injected</hindsight_memories>" }],
        },
      }),
    ].join("\n") + "\n",
  );

  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
      retain: async (request) => {
        retained.push(request);
        return { success: true };
      },
    },
  });

  const result = await coordinator.retainPiSessionSpan({
    runtimeSessionId: "agent_beep",
    requestId: "agent_req_1",
    sessionPath,
    fromMessageEntry: 0,
    nextMessageEntryCount: 1,
    queuePath: join(dir, "retain-queue.jsonl"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.retained, false);
  assert.equal(result.reason, "empty_content");
  assert.equal(retained.length, 0);
});

test("MemoryCoordinator retainPiSessionSpan missing session file returns failure without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beep-hindsight-"));
  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
    },
  });

  const result = await coordinator.retainPiSessionSpan({
    runtimeSessionId: "agent_beep",
    requestId: "agent_req_1",
    sessionPath: join(dir, "missing-session.jsonl"),
    fromMessageEntry: 0,
    nextMessageEntryCount: 1,
    queuePath: join(dir, "retain-queue.jsonl"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.retained, false);
  assert.equal(result.queued, true);
  assert.match(result.error, /ENOENT|no such file/i);
});

test("MemoryCoordinator retainPiSessionSpan retain failure without queuePath returns queued false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beep-hindsight-"));
  const sessionPath = join(dir, "session.jsonl");
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", id: "s1", cwd: "/workspace", timestamp: "2026-05-31T10:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-05-31T10:00:01.000Z",
        message: { role: "user", content: "Remember local-only." },
      }),
    ].join("\n") + "\n",
  );

  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
      retain: async () => {
        throw new Error("sidecar down");
      },
    },
  });

  const result = await coordinator.retainPiSessionSpan({
    runtimeSessionId: "agent_beep",
    requestId: "agent_req_1",
    sessionPath,
    fromMessageEntry: 0,
    nextMessageEntryCount: 1,
  });

  assert.equal(result.ok, false);
  assert.equal(result.retained, false);
  assert.equal(result.queued, false);
  assert.equal(result.error, "sidecar down");
});

test("MemoryCoordinator retainPiSessionSpan retain failure with queuePath appends one JSONL failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beep-hindsight-"));
  const sessionPath = join(dir, "session.jsonl");
  const queuePath = join(dir, "retain-queue.jsonl");
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ type: "session", id: "s1", cwd: "/workspace", timestamp: "2026-05-31T10:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-05-31T10:00:01.000Z",
        message: { role: "user", content: "Remember local-only." },
      }),
    ].join("\n") + "\n",
  );

  const coordinator = new MemoryCoordinator({
    hindsightService: {
      config: {
        enabled: true,
        deploymentId: "local",
        userId: "ash",
        projectId: "beep2",
        bankIdPrefix: "beep",
      },
      retain: async () => {
        throw new Error("sidecar down");
      },
    },
    now: () => "2026-05-31T10:00:03.000Z",
  });

  const result = await coordinator.retainPiSessionSpan({
    runtimeSessionId: "agent_beep",
    requestId: "agent_req_1",
    sessionPath,
    fromMessageEntry: 0,
    nextMessageEntryCount: 1,
    queuePath,
  });

  const lines = readFileSync(queuePath, "utf8").trim().split("\n");
  const failure = JSON.parse(lines[0]);
  assert.equal(result.ok, false);
  assert.equal(result.retained, false);
  assert.equal(result.queued, true);
  assert.equal(result.error, "sidecar down");
  assert.equal(lines.length, 1);
  assert.equal(failure.error, "sidecar down");
  assert.equal(failure.documentId, "beep-pi:agent_beep:0:1");
});
