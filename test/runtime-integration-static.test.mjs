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

test("agent request records LCM before Hindsight retain", () => {
  const lcmIndex = apiSource.indexOf("request.lcm = await session.recordLcm");
  const retainIndex = apiSource.indexOf("defaultMemoryCoordinator.retainPiSessionSpan");
  assert.ok(lcmIndex > 0, "LCM record call should exist");
  assert.ok(retainIndex > 0, "Hindsight retain call should exist");
  assert.ok(lcmIndex < retainIndex, "LCM ingest must happen before Hindsight retain");
});
