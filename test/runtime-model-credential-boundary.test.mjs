import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCodexAccessToken } from "../runtime/src/codex-auth-for-pi.mjs";

test("runtime model credential resolver fetches gateway credential with scoped capability token", async () => {
  const seen = [];
  const token = await resolveCodexAccessToken("/codex-home-is-not-used", {
    provider: "openai-codex",
    model: "gpt-5.5",
    runtimeSessionId: "sess_gateway_1",
    env: {
      BEEP_MODEL_GATEWAY_CREDENTIAL_URL: "http://model-gateway.test/internal/model/credential",
      BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN: "model-capability-token",
      BEEP_ALLOW_RUNTIME_CODEX_AUTH: "0",
    },
    fetchImpl: async (url, options = {}) => {
      seen.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          apiKey: "gateway-api-key",
          source: "control-plane-codex-auth",
          expiresAt: "2026-06-01T20:00:00.000Z",
        }),
        text: async () => "",
      };
    },
  });

  assert.equal(token, "gateway-api-key");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://model-gateway.test/internal/model/credential");
  assert.equal(seen[0].options.method, "POST");
  assert.equal(seen[0].options.headers.authorization, "Bearer model-capability-token");
  assert.equal(seen[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0].options.body), {
    provider: "openai-codex",
    model: "gpt-5.5",
    runtimeSessionId: "sess_gateway_1",
  });
});

test("runtime model credential resolver fails closed when durable Codex auth is disabled and no gateway is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "beep-runtime-codex-auth-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "durable-token-that-must-not-be-used" } }),
  );

  await assert.rejects(
    () =>
      resolveCodexAccessToken(codexHome, {
        provider: "openai-codex",
        model: "gpt-5.5",
        runtimeSessionId: "sess_no_gateway",
        env: {
          BEEP_ALLOW_RUNTIME_CODEX_AUTH: "0",
          BEEP_MODEL_GATEWAY_CREDENTIAL_URL: "",
          BEEP_MODEL_GATEWAY_CAPABILITY_TOKEN: "",
        },
        fetchImpl: async () => {
          throw new Error("gateway fetch should not run when no gateway is configured");
        },
      }),
    /runtime codex auth is disabled/i,
  );
});
