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
    assert.deepEqual(
      handlers.map((entry) => entry.event),
      ["before_provider_request"],
    );
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

test("extension returns undefined when hosted web_search is already correct", async () => {
  const result = await runHook({}, codexPayload({ tools: [{ type: "web_search", external_web_access: true }] }));
  assert.equal(result, undefined);
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
