import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalProxyOptions } from "../src/proxy-utils.mjs";

test("local preview proxy ignores absolute-form request origins", () => {
  const options = buildLocalProxyOptions(
    {
      method: "GET",
      url: "http://attacker.invalid/steal?token=abc",
      headers: {
        host: "attacker.invalid",
      },
    },
    13042,
    "site/index.html",
  );

  assert.equal(options.protocol, "http:");
  assert.equal(options.hostname, "127.0.0.1");
  assert.equal(options.port, "13042");
  assert.equal(options.path, "/site/index.html?token=abc");
  assert.equal(options.headers.host, "127.0.0.1:13042");
});

test("local preview proxy strips credentials and hop-by-hop headers", () => {
  const options = buildLocalProxyOptions(
    {
      method: "GET",
      url: "/app",
      headers: {
        authorization: "Bearer operator-token",
        cookie: "session=secret",
        "proxy-authorization": "Basic secret",
        connection: "keep-alive, x-debug-hop",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        te: "trailers",
        trailer: "expires",
        upgrade: "websocket",
        "x-debug-hop": "drop-me",
        "x-request-id": "safe",
        accept: "text/html",
      },
    },
    13042,
    "",
  );

  const names = new Set(Object.keys(options.headers).map((name) => name.toLowerCase()));
  for (const stripped of [
    "authorization",
    "cookie",
    "proxy-authorization",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "x-debug-hop",
  ]) {
    assert.equal(names.has(stripped), false, `${stripped} should not be forwarded`);
  }
  assert.equal(options.headers.host, "127.0.0.1:13042");
  assert.equal(options.headers["x-request-id"], "safe");
  assert.equal(options.headers.accept, "text/html");
});
