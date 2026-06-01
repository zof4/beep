import assert from "node:assert/strict";
import test from "node:test";
import { sendJson } from "../src/http-utils.mjs";

test("control-plane JSON responses do not allow wildcard CORS by default", () => {
  let headers = null;
  const response = {
    writeHead(_status, nextHeaders) {
      headers = nextHeaders;
    },
    end() {},
  };

  sendJson(response, 200, { ok: true });

  assert.equal(headers["access-control-allow-origin"], "http://127.0.0.1:8788");
  assert.notEqual(headers["access-control-allow-origin"], "*");
  assert.equal(headers.vary, "Origin");
});
