import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validateCodexAuthFile } from "../runtime/src/codex-auth-file.mjs";

const rootDir = new URL("..", import.meta.url).pathname;
const validatorScript = join(rootDir, "scripts/validate-codex-auth.mjs");

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "beep-codex-auth-file-test-"));
  return {
    dir,
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

test("Codex auth validation fails clearly when auth.json is missing", () => {
  const auth = tempDir();
  try {
    assert.throws(
      () => validateCodexAuthFile(auth.authPath),
      (error) => {
        assert.equal(error.code, "CODEX_AUTH_MISSING");
        assert.match(error.message, /Codex auth preflight failed: auth file not found/u);
        assert.match(error.message, /Run \.\/scripts\/codex-runtime-login\.sh/u);
        return true;
      },
    );
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation fails clearly when auth.json is empty", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, "");
    assert.throws(
      () => validateCodexAuthFile(auth.authPath),
      (error) => {
        assert.equal(error.code, "CODEX_AUTH_EMPTY");
        assert.match(error.message, /auth file is empty/u);
        assert.doesNotMatch(error.message, /Unexpected end of JSON input/u);
        assert.match(error.message, /Run \.\/scripts\/codex-runtime-login\.sh/u);
        return true;
      },
    );
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation fails clearly when auth.json is malformed", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, "{");
    assert.throws(
      () => validateCodexAuthFile(auth.authPath),
      (error) => {
        assert.equal(error.code, "CODEX_AUTH_INVALID_JSON");
        assert.match(error.message, /auth file is not valid JSON/u);
        assert.match(error.message, /Run \.\/scripts\/codex-runtime-login\.sh/u);
        return true;
      },
    );
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation fails clearly when auth.json has no usable credential", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, JSON.stringify({ tokens: {} }));
    assert.throws(
      () => validateCodexAuthFile(auth.authPath),
      (error) => {
        assert.equal(error.code, "CODEX_AUTH_MISSING_CREDENTIAL");
        assert.match(error.message, /tokens\.refresh_token, tokens\.access_token, OPENAI_API_KEY, or apiKey/u);
        assert.match(error.message, /Run \.\/scripts\/codex-runtime-login\.sh/u);
        return true;
      },
    );
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation accepts OAuth tokens without exposing secrets", () => {
  const auth = tempDir();
  try {
    write(
      auth.authPath,
      JSON.stringify({
        tokens: {
          access_token: "access-secret-value",
          refresh_token: "refresh-secret-value",
        },
      }),
    );

    const result = validateCodexAuthFile(auth.authPath);
    assert.deepEqual(result.presence, {
      tokensAccessToken: true,
      tokensRefreshToken: true,
      openaiApiKey: false,
      apiKey: false,
    });

    const cli = spawnSync(process.execPath, [validatorScript, auth.authPath], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Codex auth preflight ok/u);
    assert.match(cli.stdout, /tokens\.access_token=present/u);
    assert.match(cli.stdout, /tokens\.refresh_token=present/u);
    assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /access-secret-value|refresh-secret-value/u);
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation keeps sidecar preflight broad for refresh-token-only auth", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, JSON.stringify({ tokens: { refresh_token: "refresh-secret-value" } }));

    const result = validateCodexAuthFile(auth.authPath);
    assert.deepEqual(result.presence, {
      tokensAccessToken: false,
      tokensRefreshToken: true,
      openaiApiKey: false,
      apiKey: false,
    });
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation accepts explicit API key auth without exposing secrets", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, JSON.stringify({ OPENAI_API_KEY: "sk-secret-value" }));

    const result = validateCodexAuthFile(auth.authPath);
    assert.deepEqual(result.presence, {
      tokensAccessToken: false,
      tokensRefreshToken: false,
      openaiApiKey: true,
      apiKey: false,
    });

    const cli = spawnSync(process.execPath, [validatorScript, auth.authPath], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /OPENAI_API_KEY=present/u);
    assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /sk-secret-value/u);
  } finally {
    auth.cleanup();
  }
});

test("Codex auth validation can require tokens.access_token for direct runtime smokes", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, JSON.stringify({ tokens: { refresh_token: "refresh-secret-value" } }));

    assert.throws(
      () => validateCodexAuthFile(auth.authPath, { requireTokensAccessToken: true, usage: "Hindsight LCM smoke" }),
      (error) => {
        assert.equal(error.code, "CODEX_AUTH_MISSING_ACCESS_TOKEN");
        assert.match(error.message, /Hindsight LCM smoke requires tokens\.access_token/u);
        assert.match(error.message, /Run \.\/scripts\/codex-runtime-login\.sh/u);
        return true;
      },
    );
  } finally {
    auth.cleanup();
  }
});

test("Codex auth CLI can require tokens.access_token without exposing secrets", () => {
  const auth = tempDir();
  try {
    write(auth.authPath, JSON.stringify({ OPENAI_API_KEY: "sk-secret-value" }));

    const cli = spawnSync(process.execPath, [validatorScript, "--require-tokens-access-token", auth.authPath], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /requires tokens\.access_token/u);
    assert.doesNotMatch(`${cli.stdout}${cli.stderr}`, /sk-secret-value/u);
  } finally {
    auth.cleanup();
  }
});
