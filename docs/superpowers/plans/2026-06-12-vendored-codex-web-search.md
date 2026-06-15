# Vendored Codex Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add default-on hosted Codex `web_search` to Beep's Pi-backed runtime using vendored Codex as the source-of-truth contract.

**Architecture:** Build a small pure runtime module that normalizes Beep env config into a Responses `web_search` tool object, then load a Pi `before_provider_request` extension that injects that hosted tool into OpenAI Codex Responses payloads. Keep the existing `web.run` broker implementation for explicit legacy/internal use, but hide it from the normal public tool manifest so Pi sees native hosted search instead of the older brokered function tool.

**Tech Stack:** Node.js ESM, `node:test`, Pi extensions, Beep runtime API, Beep control-plane tool registry, vendored OpenAI Codex Rust source parsing for drift detection.

---

## File Structure

- Create `runtime/src/codex-web-search-tool.mjs`: pure config normalization, hosted web-search tool construction, payload detection, and idempotent tool injection.
- Create `runtime/pi-extensions/codex-web-search-extension.mjs`: Pi extension that reads env once at extension setup and registers `before_provider_request`.
- Create `test/codex-web-search-tool.test.mjs`: focused unit tests for config, builder, and injection behavior.
- Create `test/codex-web-search-extension.test.mjs`: focused unit tests for the Pi provider hook behavior.
- Create `test/codex-web-search-vendor-drift.test.mjs`: parse vendored Codex web-search structs and compare them to Beep's acknowledged field lists.
- Modify `runtime/src/beep-runtime-api.mjs`: load the new extension, pass whitelisted web-search env into the Pi child process, and report status in run config and capabilities.
- Modify `test/runtime-integration-static.test.mjs`: static assertions for extension load ordering, env whitelisting, and capability reporting.
- Modify `control-plane/src/tool-manifest.mjs`: add a legacy manifest gate for `web.run`.
- Modify `control-plane/src/tool-registry.mjs`: filter public manifest output while keeping broker lookup intact.
- Modify `control-plane/test/tool-registry.test.mjs`: prove `web.run` is hidden by default and visible only with the legacy env flag.
- Modify `package.json` and `test/vendor-codex-sync-script.test.mjs`: include the drift test in `test:tools`.

## Task 1: Hosted Web Search Contract Module

**Files:**
- Create: `runtime/src/codex-web-search-tool.mjs`
- Create: `test/codex-web-search-tool.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `test/codex-web-search-tool.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexWebSearchTool,
  injectCodexWebSearchTool,
  readCodexWebSearchConfig,
} from "../runtime/src/codex-web-search-tool.mjs";

function codexPayload(extra = {}) {
  return {
    model: "gpt-5.5",
    store: false,
    stream: true,
    instructions: "You are Beep.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "search now" }] }],
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...extra,
  };
}

test("default config enables live hosted web search", () => {
  const config = readCodexWebSearchConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "live");
  assert.deepEqual(buildCodexWebSearchTool(config), {
    type: "web_search",
    external_web_access: true,
  });
});

test("cached mode disables external web access", () => {
  const config = readCodexWebSearchConfig({ BEEP_CODEX_WEB_SEARCH_MODE: "cached" });
  assert.deepEqual(buildCodexWebSearchTool(config), {
    type: "web_search",
    external_web_access: false,
  });
});

test("disabled config omits hosted web search", () => {
  assert.equal(buildCodexWebSearchTool(readCodexWebSearchConfig({ BEEP_CODEX_WEB_SEARCH_ENABLED: "0" })), null);
  assert.equal(buildCodexWebSearchTool(readCodexWebSearchConfig({ BEEP_CODEX_WEB_SEARCH_MODE: "disabled" })), null);
});

test("domains, context size, content types, and user location map to Responses shape", () => {
  const config = readCodexWebSearchConfig({
    BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS: "https://openai.com/, docs.openai.com,openai.com",
    BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE: "high",
    BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES: "text,image",
    BEEP_CODEX_WEB_SEARCH_LOCATION_COUNTRY: "US",
    BEEP_CODEX_WEB_SEARCH_LOCATION_REGION: "CA",
    BEEP_CODEX_WEB_SEARCH_LOCATION_CITY: "San Francisco",
    BEEP_CODEX_WEB_SEARCH_LOCATION_TIMEZONE: "America/Los_Angeles",
  });

  assert.deepEqual(buildCodexWebSearchTool(config), {
    type: "web_search",
    external_web_access: true,
    filters: { allowed_domains: ["openai.com", "docs.openai.com"] },
    user_location: {
      type: "approximate",
      country: "US",
      region: "CA",
      city: "San Francisco",
      timezone: "America/Los_Angeles",
    },
    search_context_size: "high",
    search_content_types: ["text", "image"],
  });
});

test("invalid config fails with readable errors", () => {
  assert.throws(
    () => readCodexWebSearchConfig({ BEEP_CODEX_WEB_SEARCH_MODE: "internet" }),
    /BEEP_CODEX_WEB_SEARCH_MODE must be one of live, cached, disabled/u,
  );
  assert.throws(
    () => readCodexWebSearchConfig({ BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE: "giant" }),
    /BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE must be one of low, medium, high/u,
  );
  assert.throws(
    () => readCodexWebSearchConfig({ BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES: "text, bad value" }),
    /BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES contains invalid value/u,
  );
});

test("injector preserves existing tools and appends exactly one web_search tool", () => {
  const payload = codexPayload({
    tools: [
      { type: "function", name: "demo_echo" },
      { type: "web_search", external_web_access: false },
    ],
  });
  const tool = buildCodexWebSearchTool(readCodexWebSearchConfig({}));
  const result = injectCodexWebSearchTool(payload, tool);

  assert.equal(result.changed, true);
  assert.equal(result.injected, true);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.payload.tools, [
    { type: "function", name: "demo_echo" },
    { type: "web_search", external_web_access: true },
  ]);
  assert.deepEqual(payload.tools, [
    { type: "function", name: "demo_echo" },
    { type: "web_search", external_web_access: false },
  ]);
});

test("injector creates tools array for Codex payloads without existing tools", () => {
  const payload = codexPayload();
  const tool = buildCodexWebSearchTool(readCodexWebSearchConfig({}));
  const result = injectCodexWebSearchTool(payload, tool);

  assert.equal(result.changed, true);
  assert.deepEqual(result.payload.tools, [{ type: "web_search", external_web_access: true }]);
  assert.equal("tools" in payload, false);
});

test("injector removes existing web_search when config is disabled", () => {
  const payload = codexPayload({
    tools: [{ type: "function", name: "demo_echo" }, { type: "web_search", external_web_access: true }],
  });
  const result = injectCodexWebSearchTool(payload, null);

  assert.equal(result.changed, true);
  assert.equal(result.injected, false);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.payload.tools, [{ type: "function", name: "demo_echo" }]);
});

test("injector ignores non-Codex payload shapes", () => {
  const payload = { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] };
  const tool = buildCodexWebSearchTool(readCodexWebSearchConfig({}));
  const result = injectCodexWebSearchTool(payload, tool);

  assert.equal(result.changed, false);
  assert.equal(result.payload, payload);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/codex-web-search-tool.test.mjs
```

Expected: FAIL with an import error for `runtime/src/codex-web-search-tool.mjs`.

- [ ] **Step 3: Implement the contract module**

Create `runtime/src/codex-web-search-tool.mjs`:

```javascript
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const WEB_SEARCH_MODES = new Set(["live", "cached", "disabled"]);
const CONTEXT_SIZES = new Set(["low", "medium", "high"]);
const CONTENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]*$/u;

export const CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS = Object.freeze([
  "type",
  "external_web_access",
  "filters",
  "user_location",
  "search_context_size",
  "search_content_types",
]);

export const CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS = Object.freeze(["allowed_domains"]);

export const CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS = Object.freeze([
  "type",
  "country",
  "region",
  "city",
  "timezone",
]);

function boolConfig(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`Boolean config value must be one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}`);
}

function stringList(value) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeMode(value) {
  const mode = String(value || "live").trim().toLowerCase();
  if (!WEB_SEARCH_MODES.has(mode)) {
    throw new Error("BEEP_CODEX_WEB_SEARCH_MODE must be one of live, cached, disabled");
  }
  return mode;
}

function normalizeContextSize(value) {
  if (value === undefined || value === null || value === "") return null;
  const contextSize = String(value).trim().toLowerCase();
  if (!CONTEXT_SIZES.has(contextSize)) {
    throw new Error("BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE must be one of low, medium, high");
  }
  return contextSize;
}

function normalizeContentTypes(value) {
  const values = stringList(value);
  const seen = new Set();
  const output = [];
  for (const entry of values) {
    const normalized = entry.toLowerCase();
    if (!CONTENT_TYPE_PATTERN.test(normalized)) {
      throw new Error(`BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES contains invalid value: ${entry}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

function normalizeDomain(entry) {
  const trimmed = String(entry || "").trim();
  if (!trimmed) return null;
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.toLowerCase();
  } catch {
    return trimmed.split("/")[0].trim().toLowerCase() || null;
  }
}

function normalizeAllowedDomains(value) {
  const seen = new Set();
  const output = [];
  for (const entry of stringList(value)) {
    const normalized = normalizeDomain(entry);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

function readLocation(env) {
  const location = {
    type: "approximate",
    country: env.BEEP_CODEX_WEB_SEARCH_LOCATION_COUNTRY?.trim(),
    region: env.BEEP_CODEX_WEB_SEARCH_LOCATION_REGION?.trim(),
    city: env.BEEP_CODEX_WEB_SEARCH_LOCATION_CITY?.trim(),
    timezone: env.BEEP_CODEX_WEB_SEARCH_LOCATION_TIMEZONE?.trim(),
  };
  for (const [key, value] of Object.entries(location)) {
    if (value === undefined || value === "") delete location[key];
  }
  return Object.keys(location).length > 1 ? location : null;
}

export function readCodexWebSearchConfig(env = process.env) {
  const enabled = boolConfig(env.BEEP_CODEX_WEB_SEARCH_ENABLED, true);
  const mode = enabled ? normalizeMode(env.BEEP_CODEX_WEB_SEARCH_MODE || "live") : "disabled";
  return {
    enabled,
    mode,
    allowedDomains: normalizeAllowedDomains(env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
    contextSize: normalizeContextSize(env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
    searchContentTypes: normalizeContentTypes(env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
    userLocation: readLocation(env),
  };
}

export function buildCodexWebSearchTool(config) {
  if (!config?.enabled || config.mode === "disabled") return null;

  const tool = {
    type: "web_search",
    external_web_access: config.mode === "live",
  };
  if (config.allowedDomains?.length) {
    tool.filters = { allowed_domains: [...config.allowedDomains] };
  }
  if (config.userLocation) {
    tool.user_location = { ...config.userLocation };
  }
  if (config.contextSize) {
    tool.search_context_size = config.contextSize;
  }
  if (config.searchContentTypes?.length) {
    tool.search_content_types = [...config.searchContentTypes];
  }
  return tool;
}

export function isOpenAICodexResponsesPayload(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    typeof payload.model === "string" &&
    payload.stream === true &&
    Array.isArray(payload.input) &&
    (payload.tool_choice === "auto" || payload.parallel_tool_calls === true || Array.isArray(payload.include))
  );
}

function isHostedWebSearchTool(tool) {
  return tool && typeof tool === "object" && tool.type === "web_search";
}

export function injectCodexWebSearchTool(payload, webSearchTool) {
  if (!isOpenAICodexResponsesPayload(payload)) {
    return { payload, changed: false, injected: false, removed: 0 };
  }

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const keptTools = existingTools.filter((tool) => !isHostedWebSearchTool(tool));
  const removed = existingTools.length - keptTools.length;

  if (!webSearchTool) {
    if (!Array.isArray(payload.tools) || removed === 0) {
      return { payload, changed: false, injected: false, removed };
    }
    const nextPayload = { ...payload };
    if (keptTools.length > 0) {
      nextPayload.tools = keptTools;
    } else {
      delete nextPayload.tools;
    }
    return { payload: nextPayload, changed: true, injected: false, removed };
  }

  const nextTools = [...keptTools, webSearchTool];
  const changed = !Array.isArray(payload.tools) || removed > 0 || JSON.stringify(nextTools) !== JSON.stringify(existingTools);
  if (!changed) return { payload, changed: false, injected: true, removed };

  return {
    payload: {
      ...payload,
      tools: nextTools,
    },
    changed: true,
    injected: true,
    removed,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test test/codex-web-search-tool.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/codex-web-search-tool.mjs test/codex-web-search-tool.test.mjs
git commit -m "feat: build codex web search tool spec"
```

## Task 2: Pi Provider Hook Extension

**Files:**
- Create: `runtime/pi-extensions/codex-web-search-extension.mjs`
- Create: `test/codex-web-search-extension.test.mjs`

- [ ] **Step 1: Write the failing extension tests**

Create `test/codex-web-search-extension.test.mjs`:

```javascript
import test from "node:test";
import assert from "node:assert/strict";

const ENV_KEYS = [
  "BEEP_CODEX_WEB_SEARCH_ENABLED",
  "BEEP_CODEX_WEB_SEARCH_MODE",
  "BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS",
  "BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE",
  "BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_COUNTRY",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_REGION",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_CITY",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_TIMEZONE",
];

function codexPayload(extra = {}) {
  return {
    model: "gpt-5.5",
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "search" }] }],
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    ...extra,
  };
}

async function withEnv(env, callback) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function loadExtension() {
  const url = new URL("../runtime/pi-extensions/codex-web-search-extension.mjs", import.meta.url);
  url.searchParams.set("cache", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

async function runHook(env, payload) {
  return withEnv(env, async () => {
    const { default: extension } = await loadExtension();
    const handlers = [];
    const pi = {
      on(event, handler) {
        handlers.push({ event, handler });
      },
    };
    const result = extension(pi);
    assert.equal(result, undefined);
    assert.deepEqual(handlers.map((entry) => entry.event), ["before_provider_request"]);
    return handlers[0].handler({ type: "before_provider_request", payload }, pi);
  });
}

test("extension injects hosted web_search into Codex provider payload", async () => {
  const result = await runHook({}, codexPayload({ tools: [{ type: "function", name: "demo_echo" }] }));
  assert.deepEqual(result.tools, [
    { type: "function", name: "demo_echo" },
    { type: "web_search", external_web_access: true },
  ]);
});

test("extension replaces stale web_search entries instead of duplicating them", async () => {
  const result = await runHook(
    { BEEP_CODEX_WEB_SEARCH_MODE: "cached" },
    codexPayload({
      tools: [
        { type: "web_search", external_web_access: true },
        { type: "function", name: "demo_echo" },
      ],
    }),
  );
  assert.deepEqual(result.tools, [
    { type: "function", name: "demo_echo" },
    { type: "web_search", external_web_access: false },
  ]);
});

test("extension returns undefined when payload does not look like Codex Responses", async () => {
  const result = await runHook({}, { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] });
  assert.equal(result, undefined);
});

test("extension removes existing hosted search when disabled", async () => {
  const result = await runHook(
    { BEEP_CODEX_WEB_SEARCH_MODE: "disabled" },
    codexPayload({ tools: [{ type: "function", name: "demo_echo" }, { type: "web_search", external_web_access: true }] }),
  );
  assert.deepEqual(result.tools, [{ type: "function", name: "demo_echo" }]);
});

test("extension fails setup on invalid web-search config", async () => {
  await assert.rejects(
    () =>
      withEnv({ BEEP_CODEX_WEB_SEARCH_MODE: "public" }, async () => {
        const { default: extension } = await loadExtension();
        extension({ on() {} });
      }),
    /BEEP_CODEX_WEB_SEARCH_MODE must be one of live, cached, disabled/u,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/codex-web-search-extension.test.mjs
```

Expected: FAIL with an import error for `runtime/pi-extensions/codex-web-search-extension.mjs`.

- [ ] **Step 3: Implement the extension**

Create `runtime/pi-extensions/codex-web-search-extension.mjs`:

```javascript
import {
  buildCodexWebSearchTool,
  injectCodexWebSearchTool,
  readCodexWebSearchConfig,
} from "../src/codex-web-search-tool.mjs";

function statusText(result) {
  if (result.injected) return result.removed > 0 ? "replaced" : "injected";
  return result.removed > 0 ? "removed" : "unchanged";
}

export default function beepCodexWebSearchExtension(pi) {
  const config = readCodexWebSearchConfig();
  const webSearchTool = buildCodexWebSearchTool(config);
  let logged = false;

  pi.on("before_provider_request", (event) => {
    const result = injectCodexWebSearchTool(event?.payload, webSearchTool);
    if (!result.changed) return undefined;

    if (!logged) {
      logged = true;
      console.error(
        `[beep-codex-web-search] ${statusText(result)} hosted web_search mode=${config.mode} removed=${result.removed}`,
      );
    }
    return result.payload;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test test/codex-web-search-extension.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/pi-extensions/codex-web-search-extension.mjs test/codex-web-search-extension.test.mjs
git commit -m "feat: inject codex web search through pi hook"
```

## Task 3: Runtime Launcher Wiring

**Files:**
- Modify: `runtime/src/beep-runtime-api.mjs`
- Modify: `test/runtime-integration-static.test.mjs`

- [ ] **Step 1: Write the failing static tests**

Append these tests to `test/runtime-integration-static.test.mjs`:

```javascript
test("trusted Pi loop loads Codex web-search provider hook before sandbox and control-plane tools", () => {
  assert.match(apiSource, /const CODEX_WEB_SEARCH_EXTENSION_ENABLED\s*=/);
  assert.match(apiSource, /const CODEX_WEB_SEARCH_EXTENSION_PATH\s*=/);
  assert.match(
    apiSource,
    /process\.env\.BEEP_CODEX_WEB_SEARCH_EXTENSION_PATH\s*\|\|\s*"\/runtime\/pi-extensions\/codex-web-search-extension\.mjs"/,
  );
  assert.match(apiSource, /const CODEX_WEB_SEARCH_MODE = process\.env\.BEEP_CODEX_WEB_SEARCH_MODE \|\| "live"/);
  assert.match(apiSource, /const codexWebSearchExtensionLoaded =[\s\S]*CODEX_WEB_SEARCH_EXTENSION_ENABLED[\s\S]*existsSync\(CODEX_WEB_SEARCH_EXTENSION_PATH\)/);
  assert.match(apiSource, /args\.push\("--extension", CODEX_WEB_SEARCH_EXTENSION_PATH\)/);

  const lcmPushIndex = apiSource.indexOf('args.push("--extension", LCM_CONTEXT_EXTENSION_PATH)');
  const webSearchPushIndex = apiSource.indexOf('args.push("--extension", CODEX_WEB_SEARCH_EXTENSION_PATH)');
  const portalPushIndex = apiSource.indexOf('args.push("--extension", SANDBOX_TOOL_PORTAL_EXTENSION_PATH)');
  const toolsPushIndex = apiSource.indexOf('args.push("--extension", CONTROL_PLANE_TOOLS_EXTENSION_PATH)');

  assert.ok(lcmPushIndex > 0, "LCM extension should be loaded");
  assert.ok(webSearchPushIndex > lcmPushIndex, "Codex web-search extension should load after LCM");
  assert.ok(portalPushIndex > webSearchPushIndex, "sandbox portal should load after Codex web-search");
  assert.ok(toolsPushIndex > portalPushIndex, "control-plane tools should load after sandbox portal");
});

test("Codex web-search env is explicitly whitelisted for the Pi child", () => {
  assert.match(
    apiSource,
    /function buildPiChildEnv\(session, \{ lcmContextExtensionLoaded, codexWebSearchExtensionLoaded, controlPlaneToolsExtensionLoaded, sandboxToolPortalExtensionLoaded \}\)/,
  );
  assert.match(apiSource, /BEEP_CODEX_WEB_SEARCH_ENABLED:\s*codexWebSearchExtensionLoaded && CODEX_WEB_SEARCH_ENABLED \? "1" : "0"/);
  assert.match(apiSource, /if \(codexWebSearchExtensionLoaded\) \{[\s\S]*env\.BEEP_CODEX_WEB_SEARCH_MODE = CODEX_WEB_SEARCH_MODE/);
  assert.match(apiSource, /for \(const key of CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS\)/);
  assert.doesNotMatch(apiSource, /\.\.\.process\.env/, "Pi child env must remain a whitelist");
});

test("runtime status reports Codex web-search extension state", () => {
  assert.match(apiSource, /codexWebSearch: \{/);
  assert.match(
    apiSource,
    /codexWebSearch: \{[\s\S]*enabled: CODEX_WEB_SEARCH_ENABLED[\s\S]*extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH[\s\S]*mode: CODEX_WEB_SEARCH_MODE/,
  );
  assert.match(
    apiSource,
    /codexWebSearch: \{[\s\S]*extensionLoaded: codexWebSearchExtensionLoaded[\s\S]*mode: CODEX_WEB_SEARCH_MODE/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: FAIL on missing `CODEX_WEB_SEARCH_*` constants and runtime status fields.

- [ ] **Step 3: Wire the extension into `beep-runtime-api.mjs`**

Modify the constant section near the existing extension constants:

```javascript
const CODEX_WEB_SEARCH_EXTENSION_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_CODEX_WEB_SEARCH_EXTENSION_ENABLED || "1").toLowerCase());
const CODEX_WEB_SEARCH_ENABLED =
  !["0", "false", "no", "off"].includes(String(process.env.BEEP_CODEX_WEB_SEARCH_ENABLED || "1").toLowerCase());
const CODEX_WEB_SEARCH_EXTENSION_PATH =
  process.env.BEEP_CODEX_WEB_SEARCH_EXTENSION_PATH || "/runtime/pi-extensions/codex-web-search-extension.mjs";
const CODEX_WEB_SEARCH_MODE = process.env.BEEP_CODEX_WEB_SEARCH_MODE || "live";
const CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS = [
  "BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS",
  "BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE",
  "BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_COUNTRY",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_REGION",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_CITY",
  "BEEP_CODEX_WEB_SEARCH_LOCATION_TIMEZONE",
];
```

Change the `buildPiChildEnv` signature and body:

```javascript
function buildPiChildEnv(session, { lcmContextExtensionLoaded, codexWebSearchExtensionLoaded, controlPlaneToolsExtensionLoaded, sandboxToolPortalExtensionLoaded }) {
  const env = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || join(STATE_DIR, "home"),
    TMPDIR: process.env.TMPDIR || "/tmp",
    CODEX_HOME,
    BEEP_STATE_DIR: STATE_DIR,
    BEEP_WORKSPACE_DIR: WORKSPACE_DIR,
    PI_CODING_AGENT_DIR: join(session.rootDir, "pi-agent"),
    PI_CODING_AGENT_SESSION_DIR: session.sessionDir,
    BEEP_LCM_CONTEXT_ENABLED: lcmContextExtensionLoaded ? "1" : "0",
    BEEP_LCM_CONTEXT_URL: LCM_CONTEXT_URL,
    BEEP_LCM_CONTEXT_TOKEN: LCM_CONTEXT_TOKEN,
    BEEP_LCM_RUNTIME_SESSION_ID: session.id,
    BEEP_LCM_CONTEXT_TOKEN_BUDGET: LCM_CONTEXT_TOKEN_BUDGET,
    BEEP_LCM_CONTEXT_TIMEOUT_MS: LCM_CONTEXT_TIMEOUT_MS,
    BEEP_CODEX_WEB_SEARCH_ENABLED: codexWebSearchExtensionLoaded && CODEX_WEB_SEARCH_ENABLED ? "1" : "0",
    BEEP_CONTROL_PLANE_TOOLS_ENABLED: controlPlaneToolsExtensionLoaded ? "1" : "0",
    BEEP_SANDBOX_TOOL_PORTAL_ENABLED: sandboxToolPortalExtensionLoaded ? "1" : "0",
  };

  if (codexWebSearchExtensionLoaded) {
    env.BEEP_CODEX_WEB_SEARCH_MODE = CODEX_WEB_SEARCH_MODE;
    for (const key of CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS) {
      if (process.env[key] !== undefined && process.env[key] !== "") env[key] = process.env[key];
    }
  }
```

Keep the existing sandbox/control-plane token guards after that block. Do not add `...process.env`.

In `PiRpcSession.spawn`, load the extension after LCM and before sandbox/control-plane tools:

```javascript
const codexWebSearchExtensionLoaded = CODEX_WEB_SEARCH_EXTENSION_ENABLED && existsSync(CODEX_WEB_SEARCH_EXTENSION_PATH);
if (codexWebSearchExtensionLoaded) {
  args.push("--extension", CODEX_WEB_SEARCH_EXTENSION_PATH);
}
```

Add this object to the `run-config.json` payload:

```javascript
codexWebSearch: {
  enabled: CODEX_WEB_SEARCH_ENABLED,
  extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED,
  extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH,
  extensionLoaded: codexWebSearchExtensionLoaded,
  mode: CODEX_WEB_SEARCH_MODE,
  allowedDomainsConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
  contextSizeConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
  contentTypesConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
  userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS.some((key) => key.startsWith("BEEP_CODEX_WEB_SEARCH_LOCATION_") && Boolean(process.env[key])),
},
```

Pass the loaded flag into the child env builder:

```javascript
const env = buildPiChildEnv(this, {
  lcmContextExtensionLoaded,
  codexWebSearchExtensionLoaded,
  controlPlaneToolsExtensionLoaded,
  sandboxToolPortalExtensionLoaded,
});
```

Add the same high-level `codexWebSearch` status object to `handleCapabilities`:

```javascript
codexWebSearch: {
  enabled: CODEX_WEB_SEARCH_ENABLED,
  extensionEnabled: CODEX_WEB_SEARCH_EXTENSION_ENABLED,
  extensionPath: CODEX_WEB_SEARCH_EXTENSION_PATH,
  mode: CODEX_WEB_SEARCH_MODE,
  allowedDomainsConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_ALLOWED_DOMAINS),
  contextSizeConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTEXT_SIZE),
  contentTypesConfigured: Boolean(process.env.BEEP_CODEX_WEB_SEARCH_CONTENT_TYPES),
  userLocationConfigured: CODEX_WEB_SEARCH_OPTIONAL_ENV_KEYS.some((key) => key.startsWith("BEEP_CODEX_WEB_SEARCH_LOCATION_") && Boolean(process.env[key])),
},
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test test/runtime-integration-static.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/beep-runtime-api.mjs test/runtime-integration-static.test.mjs
git commit -m "feat: load codex web search extension"
```

## Task 4: Hide Legacy `web.run` From Normal Tool Manifest

**Files:**
- Modify: `control-plane/src/tool-manifest.mjs`
- Modify: `control-plane/src/tool-registry.mjs`
- Modify: `control-plane/test/tool-registry.test.mjs`

- [ ] **Step 1: Write the failing registry tests**

Replace the first test in `control-plane/test/tool-registry.test.mjs` with these two tests:

```javascript
test("registry hides built-in web.run from the public manifest by default", () => {
  const { store, cleanup } = tempStore();
  const previous = process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
  try {
    delete process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
    const registry = new ToolRegistry({ store });
    const manifest = registry.manifest();

    assert.equal(manifest.schemaVersion, 2);
    assert.ok(manifest.defaultAllowedScopes.includes("web.search"));
    assert.ok(manifest.defaultAllowedScopes.includes("sandbox.tool.execute"));
    assert.equal(manifest.tools.find((tool) => tool.action === "web.run"), undefined);
    assert.ok(registry.get("web.run"), "legacy web.run should remain available for explicit broker lookup");
    assert.ok(manifest.tools.find((tool) => tool.action === "preview.port.expose"));
  } finally {
    if (previous === undefined) delete process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
    else process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED = previous;
    cleanup();
  }
});

test("registry can expose built-in web.run when the legacy env flag is enabled", () => {
  const { store, cleanup } = tempStore();
  const previous = process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
  try {
    process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED = "1";
    const registry = new ToolRegistry({ store });
    const manifest = registry.manifest();

    assert.ok(manifest.tools.find((tool) => tool.action === "web.run"));
  } finally {
    if (previous === undefined) delete process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED;
    else process.env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED = previous;
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test control-plane/test/tool-registry.test.mjs
```

Expected: FAIL because `web.run` is still present in the public manifest by default.

- [ ] **Step 3: Add the manifest visibility gate**

Append these exports to `control-plane/src/tool-manifest.mjs` after `TOOL_MANIFEST`:

```javascript
export function legacyWebRunToolEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.BEEP_LEGACY_WEB_RUN_TOOL_ENABLED || "0").toLowerCase());
}

export function publicManifestTool(tool, env = process.env) {
  if (tool?.action === "web.run") return legacyWebRunToolEnabled(env);
  return true;
}
```

Modify `control-plane/src/tool-registry.mjs` imports:

```javascript
import { BUILTIN_TOOL_MANIFEST, DEFAULT_ALLOWED_SCOPES, publicManifestTool } from "./tool-manifest.mjs";
```

Modify `manifest()` in `control-plane/src/tool-registry.mjs`:

```javascript
manifest() {
  const manifest = {
    schemaVersion: 2,
    runtimeId: RUNTIME_ID,
    defaultAllowedScopes: DEFAULT_ALLOWED_SCOPES,
    tools: this.tools().filter((tool) => publicManifestTool(tool)).map((tool) => publicToolDefinition(tool)),
  };
  return {
    ...manifest,
    revision: manifestRevision(manifest),
  };
}
```

- [ ] **Step 4: Run related tests**

Run:

```bash
node --test control-plane/test/tool-registry.test.mjs control-plane/test/tool-broker.test.mjs test/runtime-control-plane-tools-extension.test.mjs
```

Expected: PASS. `tool-broker.test.mjs` should still pass because broker lookup still sees the legacy built-in. `runtime-control-plane-tools-extension.test.mjs` should still pass because it uses mocked manifests and proves the extension can execute any manifest-provided tool.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/tool-manifest.mjs control-plane/src/tool-registry.mjs control-plane/test/tool-registry.test.mjs
git commit -m "fix: hide legacy web run from default tools"
```

## Task 5: Vendored Codex Drift Test

**Files:**
- Create: `test/codex-web-search-vendor-drift.test.mjs`
- Modify: `package.json`
- Modify: `test/vendor-codex-sync-script.test.mjs`

- [ ] **Step 1: Write the drift test**

Create `test/codex-web-search-vendor-drift.test.mjs`:

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS,
  CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS,
  CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS,
} from "../runtime/src/codex-web-search-tool.mjs";

function rustStructBody(source, name) {
  const pattern = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`, "u");
  const match = source.match(pattern);
  assert.ok(match, `${name} should exist in vendored Codex`);
  return match[1];
}

function rustFields(body) {
  return [...body.matchAll(/^\s*pub\s+(?:r#)?([a-z_]+):/gmu)].map((match) => match[1]).sort();
}

test("Beep acknowledges every vendored Codex web_search top-level field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const variant = source.match(/WebSearch\s*\{([\s\S]*?)\n\s*\},/u);
  assert.ok(variant, "ToolSpec::WebSearch should exist in vendored Codex");

  const fields = [...variant[1].matchAll(/^\s*([a-z_]+):/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(["type", ...fields].sort(), [...CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS].sort());
});

test("Beep acknowledges every vendored Codex web_search filters field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const fields = rustFields(rustStructBody(source, "ResponsesApiWebSearchFilters"));
  assert.deepEqual(fields, [...CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS].sort());
});

test("Beep acknowledges every vendored Codex web_search user_location field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const fields = rustFields(rustStructBody(source, "ResponsesApiWebSearchUserLocation"));
  assert.deepEqual(fields, [...CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS].sort());
});
```

- [ ] **Step 2: Run test to verify it passes against current vendored Codex**

Run:

```bash
node --test test/codex-web-search-vendor-drift.test.mjs
```

Expected: PASS against the current `vendor/openai-codex` source. If it fails, inspect `vendor/openai-codex/codex-rs/tools/src/tool_spec.rs` and either expose the missing field in Task 1's builder or add it to the acknowledged list with a code comment explaining why Beep intentionally omits it from config.

- [ ] **Step 3: Add the drift test to `test:tools`**

Modify `package.json` so `test:tools` starts with the new drift test:

```json
"test:tools": "node --test test/codex-web-search-vendor-drift.test.mjs test/vendor-codex-sync-script.test.mjs control-plane/test/state-store.test.mjs control-plane/test/tool-broker.test.mjs test/dynamic-sandbox-cli-tool.test.mjs control-plane/test/tool-package-validator.test.mjs control-plane/test/tool-registry.test.mjs control-plane/test/openai-web-search.test.mjs control-plane/test/tool-package-routes.test.mjs test/runtime-control-plane-tools-extension.test.mjs test/full-stack-e2e-script.test.mjs"
```

Modify the expected string in `test/vendor-codex-sync-script.test.mjs` to match:

```javascript
assert.equal(
  pkg.scripts["test:tools"],
  "node --test test/codex-web-search-vendor-drift.test.mjs test/vendor-codex-sync-script.test.mjs control-plane/test/state-store.test.mjs control-plane/test/tool-broker.test.mjs test/dynamic-sandbox-cli-tool.test.mjs control-plane/test/tool-package-validator.test.mjs control-plane/test/tool-registry.test.mjs control-plane/test/openai-web-search.test.mjs control-plane/test/tool-package-routes.test.mjs test/runtime-control-plane-tools-extension.test.mjs test/full-stack-e2e-script.test.mjs",
);
```

- [ ] **Step 4: Run tool tests**

Run:

```bash
npm run test:tools
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/codex-web-search-vendor-drift.test.mjs package.json test/vendor-codex-sync-script.test.mjs
git commit -m "test: detect codex web search contract drift"
```

## Task 6: Full Verification

**Files:**
- Verify only; no file edits expected.

- [ ] **Step 1: Run focused web-search tests**

Run:

```bash
node --test test/codex-web-search-tool.test.mjs test/codex-web-search-extension.test.mjs test/codex-web-search-vendor-drift.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run runtime and control-plane affected tests**

Run:

```bash
node --test test/runtime-integration-static.test.mjs control-plane/test/tool-registry.test.mjs control-plane/test/tool-broker.test.mjs test/runtime-control-plane-tools-extension.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run tool suite**

Run:

```bash
npm run test:tools
```

Expected: PASS.

- [ ] **Step 4: Run default test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git diff --check
```

Expected: `git diff --check` prints no whitespace errors. The diff should only include the files listed in this plan plus any generated lockfile change caused by an already-approved vendor update.

- [ ] **Step 6: Final commit if verification required a small fix**

If Step 1-5 required a correction after the previous commits, commit only that correction:

```bash
git add runtime/src/codex-web-search-tool.mjs runtime/pi-extensions/codex-web-search-extension.mjs runtime/src/beep-runtime-api.mjs test/codex-web-search-tool.test.mjs test/codex-web-search-extension.test.mjs test/codex-web-search-vendor-drift.test.mjs test/runtime-integration-static.test.mjs control-plane/src/tool-manifest.mjs control-plane/src/tool-registry.mjs control-plane/test/tool-registry.test.mjs package.json test/vendor-codex-sync-script.test.mjs
git commit -m "fix: stabilize codex web search integration"
```

If no correction was needed, do not create an empty commit.

## Self-Review Notes

- Spec coverage: Tasks 1-2 implement hosted `web_search` construction and Pi payload injection; Task 3 wires the runtime and status; Task 4 hides `web_run` from default `/api/tools`; Task 5 detects vendored Codex drift; Task 6 verifies the affected surfaces.
- Scope check: The plan does not add managed search providers, per-query approvals, Codex app-server migration, sandbox changes, or dynamic tool installation.
- Type consistency: The same env names and exported function names are used across tests, implementation snippets, and runtime wiring.
