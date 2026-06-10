import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const rootDir = new URL("..", import.meta.url).pathname;

function scriptSource(scriptName) {
  return readFileSync(join(rootDir, "scripts", scriptName), "utf8");
}

function curlBlocks(source) {
  const starts = [...source.matchAll(/^curl -fsS(?:\s|\\)/gmu)].map((match) => match.index);
  return starts.map((start, index) => source.slice(start, starts[index + 1] ?? source.length));
}

test("Hindsight runtime smoke preflights Codex auth before starting Hindsight", () => {
  const source = scriptSource("hindsight-runtime-smoke.sh");
  const preflightIndex = source.indexOf("scripts/validate-codex-auth.mjs");
  const startIndex = source.indexOf('up -d --wait hindsight');

  assert.notEqual(preflightIndex, -1, "script should call the Codex auth preflight helper");
  assert.doesNotMatch(source.slice(preflightIndex, startIndex), /--require-tokens-access-token/u);
  assert.notEqual(startIndex, -1, "script should still start Hindsight");
  assert.ok(preflightIndex < startIndex, "Codex auth preflight should run before Hindsight starts");
});

test("Hindsight LCM smoke preflights Codex auth before compose startup", () => {
  const source = scriptSource("smoke-test-hindsight-lcm.sh");
  const preflightIndex = source.indexOf("scripts/validate-codex-auth.mjs");
  const startIndex = source.indexOf('up --build -d hindsight beep-runtime-api');

  assert.notEqual(preflightIndex, -1, "script should call the Codex auth preflight helper");
  assert.match(source.slice(preflightIndex, startIndex), /--require-tokens-access-token/u);
  assert.notEqual(startIndex, -1, "script should still start the smoke services");
  assert.ok(preflightIndex < startIndex, "Codex auth preflight should run before compose startup");
});

test("Hindsight LCM smoke explicitly enables local direct runtime Codex auth before compose startup", () => {
  const source = scriptSource("smoke-test-hindsight-lcm.sh");
  const enableIndex = source.indexOf("export BEEP_ALLOW_RUNTIME_CODEX_AUTH=1");
  const startIndex = source.indexOf('up --build -d hindsight beep-runtime-api');

  assert.notEqual(enableIndex, -1, "direct runtime smoke should enable mounted CODEX_HOME auth");
  assert.notEqual(startIndex, -1, "script should still start the smoke services");
  assert.ok(enableIndex < startIndex, "BEEP_ALLOW_RUNTIME_CODEX_AUTH must be exported before compose startup");
});

test("Hindsight LCM smoke sends runtime API bearer token to protected endpoints", () => {
  const source = scriptSource("smoke-test-hindsight-lcm.sh");

  assert.match(source, /export BEEP_RUNTIME_API_TOKEN=/u);
  assert.match(source, /authorization: Bearer \$BEEP_RUNTIME_API_TOKEN/u);

  const protectedBlocks = curlBlocks(source).filter((block) => /http:\/\/127\.0\.0\.1:8787\/agent\//u.test(block));
  assert.deepEqual(
    protectedBlocks.map((block) => block.match(/http:\/\/127\.0\.0\.1:8787(\/agent\/[^\s\\]+)/u)?.[1]),
    ["/agent/submit", "/agent/lcm/compact", "/agent/submit", "/agent/summary"],
  );

  protectedBlocks.forEach((block, index) => {
    const authIndex = block.indexOf('"${runtime_api_auth[@]}"');
    const protectedUrlIndex = block.indexOf("http://127.0.0.1:8787/agent/");

    assert.ok(authIndex !== -1, `protected curl block ${index + 1} should include runtime_api_auth array`);
    assert.ok(authIndex < protectedUrlIndex, `protected curl block ${index + 1} should pass runtime_api_auth before the URL`);
  });
});
