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
