import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeJwtPayload, resolveCodexCredentialFromAuthPath } from "../src/codex-token.mjs";

function tempAuthFile(auth) {
  const dir = mkdtempSync(join(tmpdir(), "beep-codex-token-test-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  return {
    authPath,
    read: () => JSON.parse(readFileSync(authPath, "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function fakeJwt(exp, extra = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, ...extra })).toString("base64url");
  return `${header}.${payload}.signature`;
}

test("control-plane credential returns unexpired Codex token without refreshing", async () => {
  const nowMs = 1_700_000_000_000;
  const auth = tempAuthFile({
    tokens: {
      access_token: fakeJwt(Math.floor(nowMs / 1000) + 3600),
      refresh_token: "refresh-old",
    },
  });
  let fetchCalled = false;
  try {
    const credential = await resolveCodexCredentialFromAuthPath(auth.authPath, {
      nowMs,
      fetchImpl: async () => {
        fetchCalled = true;
        throw new Error("should not refresh");
      },
    });

    assert.equal(credential.source, "control-plane-codex-auth");
    assert.equal(decodeJwtPayload(credential.apiKey).exp, Math.floor(nowMs / 1000) + 3600);
    assert.equal(fetchCalled, false);
    assert.equal(auth.read().tokens.refresh_token, "refresh-old");
  } finally {
    auth.cleanup();
  }
});

test("control-plane credential refreshes near-expired Codex token and persists rotated tokens", async () => {
  const nowMs = 1_700_000_000_000;
  const nextAccessToken = fakeJwt(Math.floor(nowMs / 1000) + 7200);
  const auth = tempAuthFile({
    auth_mode: "chatgpt",
    tokens: {
      access_token: fakeJwt(Math.floor(nowMs / 1000) + 120),
      refresh_token: "refresh-old",
      id_token: "id-old",
    },
  });
  const requests = [];
  try {
    const credential = await resolveCodexCredentialFromAuthPath(auth.authPath, {
      nowMs,
      fetchImpl: async (url, request) => {
        requests.push({ url, request, body: request.body.toString() });
        return new Response(
          JSON.stringify({
            access_token: nextAccessToken,
            refresh_token: "refresh-new",
            id_token: "id-new",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    assert.equal(credential.apiKey, nextAccessToken);
    assert.equal(credential.source, "control-plane-codex-auth");
    assert.equal(credential.expiresAt, new Date((Math.floor(nowMs / 1000) + 7200) * 1000).toISOString());
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://auth.openai.com/oauth/token");
    assert.match(requests[0].body, /grant_type=refresh_token/u);
    assert.match(requests[0].body, /refresh_token=refresh-old/u);
    const stored = auth.read();
    assert.equal(stored.tokens.access_token, nextAccessToken);
    assert.equal(stored.tokens.refresh_token, "refresh-new");
    assert.equal(stored.tokens.id_token, "id-new");
    assert.match(stored.last_refresh, /^\d{4}-\d{2}-\d{2}T/u);
  } finally {
    auth.cleanup();
  }
});

test("control-plane credential preserves api-key fallback for explicit non-Codex auth files", async () => {
  const auth = tempAuthFile({ OPENAI_API_KEY: "sk-test" });
  try {
    const credential = await resolveCodexCredentialFromAuthPath(auth.authPath);
    assert.deepEqual(credential, {
      apiKey: "sk-test",
      source: "control-plane-api-key",
      expiresAt: null,
    });
  } finally {
    auth.cleanup();
  }
});
