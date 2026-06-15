import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const apiSource = readFileSync(new URL("../runtime/src/beep-runtime-api.mjs", import.meta.url), "utf8");
const piNativeSessionUrl = new URL("../runtime/src/pi-native-session.mjs", import.meta.url);
const piNativeSource = existsSync(piNativeSessionUrl) ? readFileSync(piNativeSessionUrl, "utf8") : "";
const lcmContextExtensionSource = readFileSync(
  new URL("../runtime/pi-extensions/lcm-context-extension.mjs", import.meta.url),
  "utf8",
);
const sandboxPortalRuntimeSource = readFileSync(
  new URL("../runtime/pi-extensions/sandbox-tool-portal-runtime.mjs", import.meta.url),
  "utf8",
);

test("internal LCM context route calls MemoryCoordinator before LCM assemble", () => {
  const recallIndex = apiSource.indexOf("defaultMemoryCoordinator.recallForContext");
  const assembleIndex = apiSource.indexOf("defaultLcmService.assembleMessages");
  assert.ok(recallIndex > 0, "recallForContext call should exist");
  assert.ok(assembleIndex > 0, "assembleMessages call should exist");
  assert.ok(recallIndex < assembleIndex, "Hindsight recall must happen before LCM assemble");
});

test("session summaries include Hindsight memory telemetry", () => {
  assert.match(piNativeSource, /hindsightMemoryPath/);
  assert.match(piNativeSource, /recordHindsightMemory/);
  assert.match(piNativeSource, /hindsightMemory:/);
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

test("Pi native session can load control-plane tools extension independently from LCM context extension", () => {
  const lcmPathIndex = apiSource.indexOf("const LCM_CONTEXT_EXTENSION_PATH");
  const toolsPathIndex = apiSource.indexOf("const CONTROL_PLANE_TOOLS_EXTENSION_PATH");
  const lcmLoadedIndex = piNativeSource.indexOf("const lcmContextExtensionAvailable");
  const toolsLoadedIndex = piNativeSource.indexOf("const controlPlaneToolsExtensionAvailable");
  const lcmConfigIndex = piNativeSource.indexOf("lcmContext: {");
  const toolsConfigIndex = piNativeSource.indexOf("controlPlaneTools: {");

  assert.ok(lcmPathIndex > 0, "LCM context extension constant should exist");
  assert.ok(toolsPathIndex > 0, "control-plane tools extension constant should exist");
  assert.ok(lcmLoadedIndex > 0, "LCM context extension availability guard should exist");
  assert.ok(toolsLoadedIndex > 0, "control-plane tools extension availability guard should exist");
  assert.ok(lcmConfigIndex > lcmLoadedIndex, "Pi native run config should record LCM context extension after its guard");
  assert.ok(toolsConfigIndex > toolsLoadedIndex, "Pi native run config should record control-plane tools extension after its guard");
});

test("control-plane tool env is scoped for Pi without changing Hindsight memory order", () => {
  const toolsEnabledEnvIndex = piNativeSource.indexOf("BEEP_CONTROL_PLANE_TOOLS_ENABLED");
  const recallIndex = apiSource.indexOf("defaultMemoryCoordinator.recallForContext");
  const assembleIndex = apiSource.indexOf("defaultLcmService.assembleMessages");

  assert.ok(toolsEnabledEnvIndex > 0, "control-plane tools enabled env should be passed to Pi");
  assert.ok(piNativeSource.includes("BEEP_CONTROL_PLANE_TOOLS_EXTENSION_PATH"), "control-plane tools path env should be scoped for Pi");
  assert.ok(piNativeSource.includes("BEEP_CONTROL_PLANE_URL"), "control-plane URL env should be scoped for Pi");
  assert.ok(piNativeSource.includes("BEEP_CONTROL_PLANE_RUNTIME_TOKEN"), "control-plane runtime token env should be scoped for Pi");
  assert.ok(recallIndex > 0, "Hindsight recall should still exist");
  assert.ok(assembleIndex > 0, "LCM assemble should still exist");
  assert.ok(recallIndex < assembleIndex, "Hindsight recall must still happen before LCM assemble");
});

test("control-plane tools are fail closed by default and Pi native env is sanitized", () => {
  assert.match(
    apiSource,
    /process\.env\.BEEP_CONTROL_PLANE_TOOLS_ENABLED\s*\|\|\s*"0"/,
    "runtime control-plane tools should default disabled",
  );
  assert.match(piNativeSource, /function buildPiNativeExtensionEnv\(/, "Pi native env should be built through a sanitizer");
  assert.doesNotMatch(piNativeSource, /\.\.\.process\.env/, "Pi native env must not inherit the full runtime environment");
  assert.match(piNativeSource, /delete env\.BEEP_MODEL_GATEWAY_CREDENTIAL_URL/);
  assert.match(piNativeSource, /delete env\.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN/);
  assert.match(piNativeSource, /delete env\.BEEP_RUNTIME_API_TOKEN/);
  assert.match(piNativeSource, /delete env\.BEEP_CONTROL_PLANE_OPERATOR_TOKEN/);
  assert.doesNotMatch(
    piNativeSource,
    /BEEP_CONTROL_PLANE_RUNTIME_TOKEN:\s*CONTROL_PLANE_RUNTIME_TOKEN/,
    "Pi native env should only receive the runtime tool token when the tool extension is loaded",
  );
  assert.match(
    piNativeSource,
    /if \(controlPlaneToolsExtensionAvailable\) \{[\s\S]*env\.BEEP_CONTROL_PLANE_RUNTIME_TOKEN = CONTROL_PLANE_RUNTIME_TOKEN/,
    "runtime tool token should be assigned inside the control-plane tools availability guard",
  );
});

test("trusted Pi loop can load the sandbox tool portal extension", () => {
  assert.match(apiSource, /const SANDBOX_TOOL_PORTAL_ENABLED\s*=/);
  assert.match(apiSource, /const SANDBOX_TOOL_PORTAL_EXTENSION_PATH\s*=/);
  assert.match(apiSource, /process\.env\.BEEP_SANDBOX_TOOL_PORTAL_ENABLED\s*\|\|\s*"1"/);
  assert.match(
    apiSource,
    /process\.env\.BEEP_SANDBOX_TOOL_PORTAL_EXTENSION_PATH\s*\|\|\s*"\/runtime\/pi-extensions\/sandbox-tool-portal-extension\.mjs"/,
  );
  assert.match(
    apiSource,
    /const SANDBOX_TOOL_PORTAL_URL\s*=[\s\S]*`http:\/\/127\.0\.0\.1:\$\{API_PORT\}\/internal\/sandbox\/tools\/call`/,
  );
  assert.match(
    apiSource,
    /const SANDBOX_TOOL_PORTAL_TIMEOUT_MS\s*=\s*process\.env\.BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS\s*\|\|\s*"60000"/,
  );
  assert.match(
    piNativeSource,
    /function buildPiNativeExtensionEnv\(session, \{ lcmContextExtensionAvailable, codexWebSearchExtensionAvailable, controlPlaneToolsExtensionAvailable, sandboxToolPortalExtensionAvailable \}\)/,
  );
  assert.match(
    piNativeSource,
    /BEEP_SANDBOX_TOOL_PORTAL_ENABLED:\s*sandboxToolPortalExtensionAvailable \? "1" : "0"/,
  );
  assert.match(
    piNativeSource,
    /if \(sandboxToolPortalExtensionAvailable\) \{[\s\S]*env\.BEEP_SANDBOX_TOOL_PORTAL_URL = SANDBOX_TOOL_PORTAL_URL[\s\S]*env\.BEEP_SANDBOX_TOOL_PORTAL_TOKEN = RUNTIME_API_TOKEN[\s\S]*env\.BEEP_SANDBOX_TOOL_PORTAL_TIMEOUT_MS = SANDBOX_TOOL_PORTAL_TIMEOUT_MS[\s\S]*\}/,
    "portal URL, token, and timeout should only be assigned when the portal extension is available for loading",
  );
  assert.doesNotMatch(
    piNativeSource,
    /BEEP_SANDBOX_TOOL_PORTAL_TOKEN:\s*RUNTIME_API_TOKEN/,
    "runtime API token must not be unconditionally exposed to Pi",
  );

  const lcmLoadedIndex = piNativeSource.indexOf("const lcmContextExtensionAvailable");
  const portalLoadedIndex = piNativeSource.indexOf("const sandboxToolPortalExtensionAvailable");
  const toolsLoadedIndex = piNativeSource.indexOf("const controlPlaneToolsExtensionAvailable");
  const lcmConfigIndex = piNativeSource.indexOf("lcmContext: {");
  const portalConfigIndex = piNativeSource.indexOf("sandboxToolPortal: {");
  const toolsConfigIndex = piNativeSource.indexOf("controlPlaneTools: {");

  assert.ok(portalLoadedIndex > lcmLoadedIndex, "sandbox portal extension loading should happen after LCM");
  assert.ok(toolsLoadedIndex > portalLoadedIndex, "control-plane tools loading should happen after sandbox portal");
  assert.ok(portalConfigIndex > lcmConfigIndex, "sandbox portal run config should be recorded after LCM");
  assert.ok(toolsConfigIndex > portalConfigIndex, "control-plane tools run config should be recorded after sandbox portal");
  assert.match(
    piNativeSource,
    /const sandboxToolPortalExtensionAvailable =[\s\S]*SANDBOX_TOOL_PORTAL_ENABLED &&[\s\S]*Boolean\(RUNTIME_API_TOKEN\) &&[\s\S]*existsSync\(SANDBOX_TOOL_PORTAL_EXTENSION_PATH\)/,
  );
  assert.match(piNativeSource, /additionalExtensionPaths\.push\(SANDBOX_TOOL_PORTAL_EXTENSION_PATH\)/);
  assert.match(
    piNativeSource,
    /sandboxToolPortal: \{[\s\S]*enabled: SANDBOX_TOOL_PORTAL_ENABLED[\s\S]*extensionPath: SANDBOX_TOOL_PORTAL_EXTENSION_PATH[\s\S]*extensionAvailable: sandboxToolPortalExtensionAvailable[\s\S]*extensionLoaded: loadedExtensionPaths\.has\(SANDBOX_TOOL_PORTAL_EXTENSION_PATH\)[\s\S]*url: SANDBOX_TOOL_PORTAL_URL[\s\S]*timeoutMs: Number\(SANDBOX_TOOL_PORTAL_TIMEOUT_MS\)/,
  );
  assert.match(
    piNativeSource,
    /buildPiNativeExtensionEnv\(this, \{[\s\S]*sandboxToolPortalExtensionAvailable[\s\S]*\}\)/,
    "Pi native session should pass the portal availability guard into the env builder",
  );
  assert.match(piNativeSource, /delete env\.BEEP_RUNTIME_API_TOKEN/);
  assert.doesNotMatch(piNativeSource, /delete env\.BEEP_SANDBOX_TOOL_PORTAL_TOKEN/);
  assert.match(sandboxPortalRuntimeSource, /delete process\.env\.BEEP_SANDBOX_TOOL_PORTAL_TOKEN/);
});

test("trusted Pi loop wires the hosted Codex web-search extension into spawn, env, and run config", () => {
  assert.match(apiSource, /const CODEX_WEB_SEARCH_EXTENSION_ENABLED\s*=/);
  assert.match(apiSource, /const CODEX_WEB_SEARCH_ENABLED\s*=/);
  assert.match(apiSource, /const CODEX_WEB_SEARCH_EXTENSION_PATH\s*=/);
  assert.match(apiSource, /const CODEX_WEB_SEARCH_MODE\s*=\s*process\.env\.BEEP_CODEX_WEB_SEARCH_MODE\s*\|\|\s*"live"/);
  assert.match(apiSource, /const CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS\s*=\s*\[/);
  assert.match(
    apiSource,
    /process\.env\.BEEP_CODEX_WEB_SEARCH_EXTENSION_PATH\s*\|\|\s*"\/runtime\/pi-extensions\/codex-web-search-extension\.mjs"/,
  );
  assert.match(
    piNativeSource,
    /function buildPiNativeExtensionEnv\(session, \{ lcmContextExtensionAvailable, codexWebSearchExtensionAvailable, controlPlaneToolsExtensionAvailable, sandboxToolPortalExtensionAvailable \}\)/,
  );
  assert.match(
    piNativeSource,
    /BEEP_CODEX_WEB_SEARCH_ENABLED:\s*codexWebSearchExtensionAvailable && CODEX_WEB_SEARCH_ENABLED \? "1" : "0"/,
  );
  assert.match(
    piNativeSource,
    /if \(codexWebSearchExtensionAvailable && CODEX_WEB_SEARCH_ENABLED\) \{[\s\S]*env\.BEEP_CODEX_WEB_SEARCH_MODE = CODEX_WEB_SEARCH_MODE[\s\S]*for \(const key of CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS\) \{[\s\S]*const value = process\.env\[key\][\s\S]*if \(value\) env\[key\] = value[\s\S]*\}/,
    "web-search mode and optional env keys should only be copied through an explicit whitelist",
  );
  assert.doesNotMatch(piNativeSource, /\.\.\.process\.env/, "Pi native env must remain sanitized");

  const lcmLoadedIndex = piNativeSource.indexOf("const lcmContextExtensionAvailable");
  const webSearchLoadedIndex = piNativeSource.indexOf("const codexWebSearchExtensionAvailable");
  const portalLoadedIndex = piNativeSource.indexOf("const sandboxToolPortalExtensionAvailable");
  const toolsLoadedIndex = piNativeSource.indexOf("const controlPlaneToolsExtensionAvailable");
  const lcmConfigIndex = piNativeSource.indexOf("lcmContext: {");
  const webSearchConfigIndex = piNativeSource.indexOf("codexWebSearch: {");
  const portalConfigIndex = piNativeSource.indexOf("sandboxToolPortal: {");
  const toolsConfigIndex = piNativeSource.indexOf("controlPlaneTools: {");

  assert.ok(webSearchLoadedIndex > lcmLoadedIndex, "web-search extension loading should happen after LCM");
  assert.ok(portalLoadedIndex > webSearchLoadedIndex, "sandbox portal loading should happen after web-search");
  assert.ok(toolsLoadedIndex > portalLoadedIndex, "control-plane tools loading should happen after sandbox portal");
  assert.ok(webSearchConfigIndex > lcmConfigIndex, "web-search run config should be recorded after LCM");
  assert.ok(portalConfigIndex > webSearchConfigIndex, "sandbox portal run config should be recorded after web-search");
  assert.ok(toolsConfigIndex > portalConfigIndex, "control-plane tools run config should be recorded after sandbox portal");
  assert.match(
    piNativeSource,
    /const codexWebSearchExtensionAvailable = CODEX_WEB_SEARCH_EXTENSION_ENABLED && existsSync\(CODEX_WEB_SEARCH_EXTENSION_PATH\)/,
  );
  assert.match(piNativeSource, /additionalExtensionPaths\.push\(CODEX_WEB_SEARCH_EXTENSION_PATH\)/);
  assert.match(
    piNativeSource,
    /codexWebSearch: \{[\s\S]*enabled: CODEX_WEB_SEARCH_ENABLED[\s\S]*extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED[\s\S]*extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH[\s\S]*extensionAvailable: codexWebSearchExtensionAvailable[\s\S]*extensionLoaded: loadedExtensionPaths\.has\(CODEX_WEB_SEARCH_EXTENSION_PATH\)[\s\S]*effectiveEnabled: CODEX_WEB_SEARCH_ENABLED && loadedExtensionPaths\.has\(CODEX_WEB_SEARCH_EXTENSION_PATH\)[\s\S]*mode: CODEX_WEB_SEARCH_MODE[\s\S]*allowedDomainsConfigured: Boolean\(process\.env\.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS\)[\s\S]*contextSizeConfigured: Boolean\(process\.env\.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE\)[\s\S]*contentTypesConfigured: Boolean\(process\.env\.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES\)[\s\S]*userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS\.some\(\(key\) => key\.startsWith\("BEEP_CODEX_WEB_SEARCH_LOCATION_"\) && Boolean\(process\.env\[key\]\)\)/,
  );
  assert.match(
    piNativeSource,
    /buildPiNativeExtensionEnv\(this, \{[\s\S]*codexWebSearchExtensionAvailable[\s\S]*\}\)/,
    "Pi native session should pass the web-search availability guard into the env builder",
  );
});

test("runtime uses native Pi sessions instead of Pi RPC", () => {
  assert.match(apiSource, /import \{ PiNativeSession \} from "\.\/pi-native-session\.mjs"/);
  assert.match(apiSource, /transport:\s*"pi-native"/);
  assert.doesNotMatch(apiSource, /class PiRpcSession/);
  assert.doesNotMatch(apiSource, /--mode",\s*"rpc"/);
  assert.doesNotMatch(apiSource, /type:\s*"prompt",\s*message/);
});

test("runtime routes require native input instead of message prompt shims", () => {
  assert.match(apiSource, /normalizeBeepInput\(body\.input/);
  assert.match(apiSource, /enqueuePrompt\(\{\s*input:/);
  assert.match(apiSource, /session\.prompt\(request\.input/);
  assert.doesNotMatch(apiSource, /body\.message\s*\|\|\s*body\.prompt/);
});

test("native Pi run config reports actual SDK extension loader results", () => {
  const createIndex = piNativeSource.indexOf("result = await sdk.codingAgent.createAgentSession");
  const loaderResultIndex = piNativeSource.indexOf("result.extensionsResult", createIndex);
  const loadedPathsIndex = piNativeSource.indexOf("loadedExtensionPaths", loaderResultIndex);
  const errorsIndex = piNativeSource.indexOf("extensionLoaderErrors", loaderResultIndex);
  const runConfigRewriteIndex = piNativeSource.indexOf('writeJsonFile(join(this.rootDir, "run-config.json"), this.runConfig)', loaderResultIndex);

  assert.ok(createIndex > 0, "Pi native session should create through the SDK");
  assert.ok(loaderResultIndex > createIndex, "run config should inspect result.extensionsResult after SDK creation");
  assert.ok(loadedPathsIndex > loaderResultIndex, "run config should derive loaded extension paths from SDK results");
  assert.ok(errorsIndex > loaderResultIndex, "run config should expose extension loader errors");
  assert.ok(runConfigRewriteIndex > loaderResultIndex, "run-config.json should be written after loader results are known");
  assert.match(piNativeSource, /extensionLoaded:\s*loadedExtensionPaths\.has\(LCM_CONTEXT_EXTENSION_PATH\)/);
  assert.match(piNativeSource, /extensionLoaded:\s*loadedExtensionPaths\.has\(CODEX_WEB_SEARCH_EXTENSION_PATH\)/);
  assert.match(piNativeSource, /extensionLoaded:\s*loadedExtensionPaths\.has\(SANDBOX_TOOL_PORTAL_EXTENSION_PATH\)/);
  assert.match(piNativeSource, /extensionLoaded:\s*loadedExtensionPaths\.has\(CONTROL_PLANE_TOOLS_EXTENSION_PATH\)/);
});

test("native Pi extension env is scoped to serialized SDK loading", () => {
  assert.match(piNativeSource, /async function withProcessEnvCriticalSection\(env, callback\)/);
  assert.match(piNativeSource, /await withProcessEnvCriticalSection\(env, async \(\) => \{/);
  assert.match(piNativeSource, /BEEP_PI_EXTENSION_CONFIG_ID: session\.extensionConfigId/);
  assert.doesNotMatch(piNativeSource, /withExtensionEnv/);
  assert.doesNotMatch(piNativeSource, /BEEP_LCM_CONTEXT_TOKEN:\s*LCM_CONTEXT_TOKEN/);
  assert.doesNotMatch(piNativeSource, /BEEP_LCM_RUNTIME_SESSION_ID:\s*session\.id/);
});

test("runtime scrubs sensitive process env after capturing constants", () => {
  assert.match(apiSource, /function scrubSensitiveRuntimeEnv\(\)/);
  assert.match(apiSource, /delete process\.env\.BEEP_RUNTIME_API_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_CONTROL_PLANE_OPERATOR_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_OPERATOR_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_MODEL_GATEWAY_CREDENTIAL_URL/);
  assert.match(apiSource, /delete process\.env\.BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_MODEL_CREDENTIAL_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_MODEL_GATEWAY_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_CONTROL_PLANE_RUNTIME_TOKEN/);
  assert.match(apiSource, /delete process\.env\.BEEP_LCM_CONTEXT_TOKEN/);
  assert.match(apiSource, /scrubSensitiveRuntimeEnv\(\)/);
});

test("LCM context extension captures explicit config instead of reading env per event", () => {
  assert.match(lcmContextExtensionSource, /function readBeepExtensionConfig\(\)/);
  assert.match(lcmContextExtensionSource, /const config = readBeepExtensionConfig\(\)\.lcmContext \|\| \{\}/);
  assert.doesNotMatch(lcmContextExtensionSource, /process\.env\.BEEP_LCM_RUNTIME_SESSION_ID/);
  assert.doesNotMatch(lcmContextExtensionSource, /process\.env\.BEEP_LCM_CONTEXT_TOKEN/);
  assert.doesNotMatch(lcmContextExtensionSource, /positiveIntegerEnv/);
});

test("native prompt timeout aborts and nonblocking prompts are accepted asynchronously", () => {
  assert.match(piNativeSource, /async runPromptWithTimeout\(input, options, timeoutMs\)/);
  assert.match(piNativeSource, /Promise\.race\(\[nativePrompt, timeoutPromise\]\)/);
  assert.match(piNativeSource, /await this\.abort\(\)/);
  assert.match(piNativeSource, /Timed out waiting for Pi native prompt in session \$\{this\.id\}/);
  assert.match(piNativeSource, /if \(!waitForCompletion\) \{/);
  assert.match(piNativeSource, /this\.trackBackgroundPrompt\(promptPromise\)/);
  assert.match(piNativeSource, /this\.activePrompt/);
});

test("native open and stop clean up resources", () => {
  const catchIndex = piNativeSource.indexOf("} catch (error) {");
  const closeIndex = piNativeSource.indexOf("this.closeStreams();", catchIndex);
  const unregisterIndex = piNativeSource.indexOf("this.unregisterExtensionConfig?.();", catchIndex);
  const stopIndex = piNativeSource.indexOf("async stop()");
  const abortIndex = piNativeSource.indexOf("await this.abort()", stopIndex);
  const disposeIndex = piNativeSource.indexOf("this.piSession?.dispose?.()", stopIndex);

  assert.ok(catchIndex > 0, "open catch should exist");
  assert.ok(closeIndex > catchIndex, "open failure should close streams");
  assert.ok(unregisterIndex > catchIndex, "open failure should unregister extension config");
  assert.ok(stopIndex > 0, "stop should exist");
  assert.ok(abortIndex > stopIndex, "stop should abort active work");
  assert.ok(disposeIndex > abortIndex, "stop should abort before dispose");
});

test("runtime capabilities surface high-level Codex web-search status", () => {
  assert.match(
    apiSource,
    /codexWebSearch: \{[\s\S]*enabled: CODEX_WEB_SEARCH_ENABLED[\s\S]*extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED[\s\S]*extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH[\s\S]*extensionAvailable: CODEX_WEB_SEARCH_EXTENSION_ENABLED && existsSync\(CODEX_WEB_SEARCH_EXTENSION_PATH\)[\s\S]*effectiveEnabled: CODEX_WEB_SEARCH_ENABLED && CODEX_WEB_SEARCH_EXTENSION_ENABLED && existsSync\(CODEX_WEB_SEARCH_EXTENSION_PATH\)[\s\S]*mode: CODEX_WEB_SEARCH_MODE[\s\S]*allowedDomainsConfigured: Boolean\(process\.env\.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS\)[\s\S]*contextSizeConfigured: Boolean\(process\.env\.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE\)[\s\S]*contentTypesConfigured: Boolean\(process\.env\.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES\)[\s\S]*userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS\.some\(\(key\) => key\.startsWith\("BEEP_CODEX_WEB_SEARCH_LOCATION_"\) && Boolean\(process\.env\[key\]\)\)/,
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
