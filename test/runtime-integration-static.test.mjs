import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const apiSource = readFileSync(new URL("../runtime/src/beep-runtime-api.mjs", import.meta.url), "utf8");

test("internal LCM context route calls MemoryCoordinator before LCM assemble", () => {
  const recallIndex = apiSource.indexOf("defaultMemoryCoordinator.recallForContext");
  const assembleIndex = apiSource.indexOf("defaultLcmService.assembleMessages");
  assert.ok(recallIndex > 0, "recallForContext call should exist");
  assert.ok(assembleIndex > 0, "assembleMessages call should exist");
  assert.ok(recallIndex < assembleIndex, "Hindsight recall must happen before LCM assemble");
});

test("session summaries include Hindsight memory telemetry", () => {
  assert.match(apiSource, /hindsightMemoryPath/);
  assert.match(apiSource, /recordHindsightMemory/);
  assert.match(apiSource, /hindsightMemory:/);
});

test("Hindsight memory telemetry uses a best-effort helper", () => {
  assert.match(apiSource, /function safeRecordHindsightMemory\(session, event\)/);
  assert.match(apiSource, /telemetryDropped:\s*true/);
});

test("internal LCM context records Hindsight safely before LCM assemble", () => {
  const internalRouteIndex = apiSource.indexOf("async function handleInternalRoute");
  const safeRecordIndex = apiSource.indexOf("safeRecordHindsightMemory(session", internalRouteIndex);
  const assembleIndex = apiSource.indexOf("defaultLcmService.assembleMessages", internalRouteIndex);
  const rawRecordIndex = apiSource.indexOf(".recordHindsightMemory(", internalRouteIndex);

  assert.ok(internalRouteIndex > 0, "internal route should exist");
  assert.ok(safeRecordIndex > internalRouteIndex, "internal route should record Hindsight through the safe helper");
  assert.ok(assembleIndex > internalRouteIndex, "internal route should assemble LCM messages");
  assert.ok(safeRecordIndex < assembleIndex, "Hindsight recall telemetry should be recorded before LCM assemble");
  assert.ok(
    rawRecordIndex === -1 || rawRecordIndex > assembleIndex,
    "internal route must not call recordHindsightMemory directly before LCM assemble",
  );
});

test("raw Hindsight memory telemetry writes only occur inside the safe helper", () => {
  const matches = [...apiSource.matchAll(/\.recordHindsightMemory\(/g)];
  const helperStart = apiSource.indexOf("function safeRecordHindsightMemory(session, event)");
  const helperEnd = apiSource.indexOf("\n}\n", helperStart);

  assert.ok(helperStart > 0, "safeRecordHindsightMemory helper should exist");
  assert.equal(matches.length, 1, "raw recordHindsightMemory calls should be confined to the safe helper");
  assert.ok(matches[0].index > helperStart, "raw recordHindsightMemory call should be inside the safe helper");
  assert.ok(matches[0].index < helperEnd, "raw recordHindsightMemory call should be inside the safe helper");
});

test("agent request records LCM before Hindsight retain", () => {
  const lcmIndex = apiSource.indexOf("request.lcm = await session.recordLcm");
  const retainIndex = apiSource.indexOf("defaultMemoryCoordinator.retainPiSessionSpan");
  assert.ok(lcmIndex > 0, "LCM record call should exist");
  assert.ok(retainIndex > 0, "Hindsight retain call should exist");
  assert.ok(lcmIndex < retainIndex, "LCM ingest must happen before Hindsight retain");
});
