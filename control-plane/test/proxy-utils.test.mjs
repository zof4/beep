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
