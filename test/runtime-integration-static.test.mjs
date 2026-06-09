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

test("agent request preserves completed prompt when memory ingest fails", () => {
  const runRequestIndex = apiSource.indexOf("async runRequest(request)");
  const promptFinalIndex = apiSource.indexOf("request.finalText = promptResult.finalText || null", runRequestIndex);
  const lcmIndex = apiSource.indexOf("request.lcm = await session.recordLcm", promptFinalIndex);
  const memoryCatchIndex = apiSource.indexOf("catch (memoryError)", lcmIndex);
  const completedIndex = apiSource.indexOf('request.status = "completed"', lcmIndex);
  const failedIndex = apiSource.indexOf('request.status = "failed"', lcmIndex);

  assert.ok(runRequestIndex > 0, "agent request runner should exist");
  assert.ok(promptFinalIndex > runRequestIndex, "prompt final text should be stored before memory ingest");
  assert.ok(lcmIndex > promptFinalIndex, "LCM record call should happen after final text is stored");
  assert.ok(memoryCatchIndex > lcmIndex, "memory ingest should have its own catch block");
  assert.ok(memoryCatchIndex < completedIndex, "memory ingest catch should happen before completed status");
  assert.ok(completedIndex < failedIndex, "memory ingest failure should not skip directly to failed status");
  assert.match(apiSource, /request\.memoryError = memoryErrorMessage/);
  assert.match(apiSource, /request\.lcm = \{\s*ok: false,\s*error: memoryErrorMessage,\s*\}/);
});

test("Pi spawn can load control-plane tools extension independently from LCM context extension", () => {
  const lcmPathIndex = apiSource.indexOf("const LCM_CONTEXT_EXTENSION_PATH");
  const toolsPathIndex = apiSource.indexOf("const CONTROL_PLANE_TOOLS_EXTENSION_PATH");
  const lcmLoadedIndex = apiSource.indexOf("const lcmContextExtensionLoaded");
  const toolsLoadedIndex = apiSource.indexOf("const controlPlaneToolsExtensionLoaded");
  const lcmPushIndex = apiSource.indexOf('args.push("--extension", LCM_CONTEXT_EXTENSION_PATH)');
  const toolsPushIndex = apiSource.indexOf('args.push("--extension", CONTROL_PLANE_TOOLS_EXTENSION_PATH)');

  assert.ok(lcmPathIndex > 0, "LCM context extension constant should exist");
  assert.ok(toolsPathIndex > 0, "control-plane tools extension constant should exist");
  assert.ok(lcmLoadedIndex > 0, "LCM context extension loaded guard should exist");
  assert.ok(toolsLoadedIndex > 0, "control-plane tools extension loaded guard should exist");
  assert.ok(lcmPushIndex > lcmLoadedIndex, "Pi spawn should push LCM context extension after its guard");
  assert.ok(toolsPushIndex > toolsLoadedIndex, "Pi spawn should push control-plane tools extension after its guard");
});

test("control-plane tool env is passed to Pi without changing Hindsight memory order", () => {
  const toolsEnabledEnvIndex = apiSource.indexOf("BEEP_CONTROL_PLANE_TOOLS_ENABLED");
  const recallIndex = apiSource.indexOf("defaultMemoryCoordinator.recallForContext");
  const assembleIndex = apiSource.indexOf("defaultLcmService.assembleMessages");

  assert.ok(toolsEnabledEnvIndex > 0, "control-plane tools enabled env should be passed to Pi");
  assert.ok(apiSource.includes("BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH"), "control-plane tools path env should be passed to Pi");
  assert.ok(apiSource.includes("BEEP_CONTROL_PLANE_URL"), "control-plane URL env should be passed to Pi");
  assert.ok(apiSource.includes("BEEP_CONTROL_PLANE_RUNTIME_TOKEN"), "control-plane runtime token env should be passed to Pi");
  assert.ok(recallIndex > 0, "Hindsight recall should still exist");
  assert.ok(assembleIndex > 0, "LCM assemble should still exist");
  assert.ok(recallIndex < assembleIndex, "Hindsight recall must still happen before LCM assemble");
});

test("control-plane tools are fail closed by default and Pi env is sanitized", () => {
  assert.match(
    apiSource,
    /process\.env\.BEEP_CONTROL_PLANE_TOOLS_ENABLED\s*\|\|\s*"0"/,
    "runtime control-plane tools should default disabled",
  );
  assert.match(apiSource, /function buildPiChildEnv\(/, "Pi child env should be built through a sanitizer");
  assert.doesNotMatch(apiSource, /\.\.\.process\.env/, "Pi child env must not inherit the full runtime environment");
  assert.match(apiSource, /delete env\.BEEP_MODEL_GATEWAY_CREDENTIAL_URL/);
  assert.match(apiSource, /delete env\.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN/);
  assert.match(apiSource, /delete env\.BEEP_RUNTIME_API_TOKEN/);
  assert.match(apiSource, /delete env\.BEEP_CONTROL_PLANE_OPERATOR_TOKEN/);
  assert.doesNotMatch(
    apiSource,
    /BEEP_CONTROL_PLANE_RUNTIME_TOKEN:\s*CONTROL_PLANE_RUNTIME_TOKEN/,
    "Pi child env should only receive the runtime tool token when the tool extension is loaded",
  );
  assert.match(
    apiSource,
    /if \(controlPlaneToolsExtensionLoaded\) \{[\s\S]*env\.BEEP_CONTROL_PLANE_RUNTIME_TOKEN = CONTROL_PLANE_RUNTIME_TOKEN/,
    "runtime tool token should be assigned inside the control-plane tools loaded guard",
  );
});

test("runtime routes sandbox tools through Docker manager before LCM-only internal handling", () => {
  assert.match(apiSource, /import \{ DockerSandboxManager \} from "\.\/docker-sandbox-manager\.mjs"/);
  assert.match(apiSource, /import \{ executeSandboxTool \} from "\.\/sandbox-tool-executor\.mjs"/);
  assert.match(apiSource, /import \{ normalizeSandboxToolRequest \} from "\.\/sandbox-tool-protocol\.mjs"/);
  assert.match(apiSource, /const SANDBOX_TOOL_BACKEND = process\.env\.BEEP_SANDBOX_TOOL_BACKEND \|\| "docker"/);
  assert.match(apiSource, /const SANDBOX_DOCKER_WORKSPACE_ROOT = process\.env\.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT \|\| SANDBOX_WORKSPACE_ROOT/);
  assert.match(apiSource, /const defaultSandboxManager = new DockerSandboxManager\(\{[\s\S]*dockerWorkspaceRoot: SANDBOX_DOCKER_WORKSPACE_ROOT/);
  assert.match(
    apiSource,
    /sandboxTools: \{[\s\S]*backend: SANDBOX_TOOL_BACKEND[\s\S]*dockerWorkspaceRootConfigured: Boolean\(process\.env\.BEEP_SANDBOX_DOCKER_WORKSPACE_ROOT\)/,
  );
  assert.match(apiSource, /function sandboxRouteSessionId\(value\)/);
  assert.match(apiSource, /const status = error\?\.statusCode \|\| error\?\.status \|\| 500/);

  const internalRouteIndex = apiSource.indexOf("async function handleInternalRoute");
  const sandboxRouteIndex = apiSource.indexOf('resource === "sandbox" && action === "tools"', internalRouteIndex);
  const lcmOnlyIndex = apiSource.indexOf('resource !== "lcm" || action !== "context"', internalRouteIndex);
  assert.ok(internalRouteIndex > 0, "internal route handler should exist");
  assert.ok(sandboxRouteIndex > internalRouteIndex, "sandbox route should be handled inside internal route dispatch");
  assert.ok(lcmOnlyIndex > sandboxRouteIndex, "sandbox route should dispatch before LCM-only rejection");
});

test("sandbox image copies the tool runner without credentials", () => {
  const dockerfile = readFileSync(new URL("../docker/sandbox.Dockerfile", import.meta.url), "utf8");
  const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY runtime\/bin\/beep-sandbox-tool-runner/u);
  assert.match(dockerfile, /COPY runtime\/src\/sandbox-tool-/u);
  assert.match(dockerfile, /chmod 0555 \/runtime/u);
  assert.doesNotMatch(dockerfile, /chown -R beep:beep \/runtime/u);
  assert.doesNotMatch(dockerfile, /\bcurl\b/u);
  assert.match(dockerfile, /USER beep/u);
  assert.doesNotMatch(dockerfile, /CODEX_HOME|auth\.json|BEEP_RUNTIME_API_TOKEN|BEEP_CONTROL_PLANE_RUNTIME_TOKEN/u);
  assert.match(dockerignore, /^\.codex$/mu);
  assert.match(dockerignore, /^\.env\.\*$/mu);
  assert.match(dockerignore, /^auth\.json$/mu);
  assert.match(dockerignore, /^\*\*\/auth\.json$/mu);
  assert.match(dockerignore, /^\*\.pem$/mu);
});
