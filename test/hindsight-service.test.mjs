import test from "node:test";
import assert from "node:assert/strict";
import {
  HindsightService,
  deriveHindsightBankId,
  loadHindsightConfig,
} from "../runtime/src/hindsight-service.mjs";

test("loadHindsightConfig reads local-only defaults and env overrides", () => {
  const config = loadHindsightConfig({
    BEEP_HINDSIGHT_ENABLED: "1",
    BEEP_HINDSIGHT_API_URL: "http://hindsight:8888",
    BEEP_HINDSIGHT_API_TOKEN: "secret",
    BEEP_HINDSIGHT_BANK_ID_PREFIX: "beep",
    BEEP_HINDSIGHT_DEPLOYMENT_ID: "oracle-a",
    BEEP_HINDSIGHT_USER_ID: "ash",
    BEEP_HINDSIGHT_PROJECT_ID: "beep2",
    BEEP_HINDSIGHT_RECALL_BUDGET: "high",
    BEEP_HINDSIGHT_RECALL_MAX_TOKENS: "8192",
    BEEP_HINDSIGHT_TIMEOUT_MS: "2500",
  });

  assert.equal(config.enabled, true);
  assert.equal(config.apiUrl, "http://hindsight:8888");
  assert.equal(config.apiToken, "secret");
  assert.equal(config.bankIdPrefix, "beep");
  assert.equal(config.deploymentId, "oracle-a");
  assert.equal(config.userId, "ash");
  assert.equal(config.projectId, "beep2");
  assert.equal(config.recallBudget, "high");
  assert.equal(config.recallMaxTokens, 8192);
  assert.equal(config.timeoutMs, 2500);
});

test("deriveHindsightBankId sanitizes stable deployment user project scope", () => {
  const config = loadHindsightConfig({
    BEEP_HINDSIGHT_BANK_ID_PREFIX: "beep",
    BEEP_HINDSIGHT_DEPLOYMENT_ID: "Oracle Prod",
    BEEP_HINDSIGHT_USER_ID: "Ash/User",
    BEEP_HINDSIGHT_PROJECT_ID: "Beep 2",
  });

  assert.equal(deriveHindsightBankId(config), "beep:oracle-prod:ash-user:beep-2");
});

test("HindsightService recall sends strict tag filters to the local API", async () => {
  const calls = [];
  const service = new HindsightService(
    loadHindsightConfig({
      BEEP_HINDSIGHT_API_URL: "http://hindsight:8888",
      BEEP_HINDSIGHT_API_TOKEN: "secret",
    }),
    {
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ results: [{ id: "m1", text: "Remember this", type: "world" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  const result = await service.recall({
    bankId: "beep:local:user:project",
    query: "What should I remember?",
    tags: ["deployment:local", "project:beep2"],
  });

  assert.equal(result.results[0].text, "Remember this");
  assert.equal(calls[0].url, "http://hindsight:8888/v1/default/banks/beep%3Alocal%3Auser%3Aproject/memories/recall");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    query: "What should I remember?",
    budget: "high",
    max_tokens: 4096,
    trace: false,
    types: ["world", "experience", "observation"],
    tags: ["deployment:local", "project:beep2"],
    tags_match: "all_strict",
  });
});
