import assert from "node:assert/strict";
import test from "node:test";
import { createWebRunExecutor } from "../src/openai-web-search.mjs";

test("web.run maps search_query to a Responses API web_search request", async () => {
  const seen = {};
  const executor = createWebRunExecutor({
    model: "gpt-test",
    credentialResolver: async () => ({ apiKey: "sk-test", source: "test" }),
    fetchImpl: async (url, options) => {
      seen.url = url;
      seen.options = options;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "resp_123",
          output_text: "Result summary",
          output: [],
        }),
      };
    },
  });

  const result = await executor.run({
    search_query: [{ q: "OpenClaw tools docs", domains: ["docs.openclaw.ai"] }],
    response_length: "short",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.text, "Result summary");
  assert.equal(result.result.responseId, "resp_123");
  assert.equal(result.result.source, "test");
  assert.equal(seen.url, "https://api.openai.com/v1/responses");
  assert.equal(seen.options.method, "POST");
  assert.equal(seen.options.headers.Authorization, "Bearer sk-test");
  assert.equal(seen.options.headers["Content-Type"], "application/json");
  const body = JSON.parse(seen.options.body);
  assert.equal(body.model, "gpt-test");
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.include, ["web_search_call.action.sources"]);
  assert.deepEqual(body.tools, [{ type: "web_search", filters: { allowed_domains: ["docs.openclaw.ai"] } }]);
  assert.match(body.input, /OpenClaw tools docs/u);
});

test("web.run returns a controlled error when OpenAI rejects the request", async () => {
  const executor = createWebRunExecutor({
    credentialResolver: async () => ({ apiKey: "sk-test", source: "test" }),
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({ error: { message: "bad key" } }),
    }),
  });

  await assert.rejects(
    () => executor.run({ search_query: [{ q: "anything" }] }),
    /OpenAI web search failed: 401 bad key/u,
  );
});

test("web.run extracts fallback text from output message content", async () => {
  const executor = createWebRunExecutor({
    credentialResolver: async () => ({ apiKey: "sk-test" }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "resp_fallback",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Fallback summary" }],
          },
        ],
      }),
    }),
  });

  const result = await executor.run({ search_query: [{ q: "fallback text" }] });

  assert.equal(result.ok, true);
  assert.equal(result.result.text, "Fallback summary");
});

test("web.run normalizes allowed domains by stripping protocol, trailing slash, and duplicates", async () => {
  const seen = {};
  const executor = createWebRunExecutor({
    credentialResolver: async () => ({ apiKey: "sk-test" }),
    fetchImpl: async (url, options) => {
      seen.body = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "resp_domains",
          output_text: "Domain summary",
          output: [],
        }),
      };
    },
  });

  await executor.run({
    search_query: [
      {
        q: "domain filters",
        domains: ["https://example.com/", "http://example.com", " docs.example.com/ ", "docs.example.com"],
      },
    ],
  });

  assert.deepEqual(seen.body.tools, [
    { type: "web_search", filters: { allowed_domains: ["example.com", "docs.example.com"] } },
  ]);
});
