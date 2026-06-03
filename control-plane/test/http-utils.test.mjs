import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestUrl, readJsonBody, sendJson, statusFromError } from "../src/http-utils.mjs";

async function* requestChunks(...chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

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

test("readJsonBody returns an empty object for empty bodies", async () => {
  assert.deepEqual(await readJsonBody(requestChunks()), {});
  assert.deepEqual(await readJsonBody(requestChunks(Buffer.from("   \n\t"))), {});
});

test("parseRequestUrl falls back when Host is malformed", () => {
  const url = parseRequestUrl({ url: "/health", headers: { host: "bad host" } });

  assert.equal(url.origin, "http://127.0.0.1:8788");
  assert.equal(url.pathname, "/health");
});

test("parseRequestUrl falls back when absolute request target is malformed", () => {
  const url = parseRequestUrl({ url: "http://[", headers: { host: "example.test" } });

  assert.equal(url.origin, "http://127.0.0.1:8788");
  assert.equal(url.pathname, "/");
});

test("readJsonBody rejects invalid JSON with a 400 status", async () => {
  await assert.rejects(readJsonBody(requestChunks(Buffer.from("{"))), {
    status: 400,
    message: /invalid JSON body/,
  });
});

test("readJsonBody enforces the byte limit before parsing", async () => {
  await assert.rejects(readJsonBody(requestChunks(Buffer.from('{"message":"too large"}')), 8), {
    status: 413,
    message: "request body too large",
  });
});

test("readJsonBody preserves UTF-8 characters split across chunks", async () => {
  const payload = Buffer.from(JSON.stringify({ message: "hello 🙂" }));
  const emoji = Buffer.from("🙂");
  const splitAt = payload.indexOf(emoji) + 1;

  const parsed = await readJsonBody(requestChunks(payload.subarray(0, splitAt), payload.subarray(splitAt)));

  assert.deepEqual(parsed, { message: "hello 🙂" });
});

test("readJsonBody rejects malformed UTF-8 with a 400 status", async () => {
  await assert.rejects(readJsonBody(requestChunks(Buffer.from([0xff, 0xfe, 0xfd]))), {
    status: 400,
    message: /invalid UTF-8 body/,
  });
});

test("statusFromError returns only valid HTTP error statuses", () => {
  assert.equal(statusFromError({ status: 404 }), 404);
  assert.equal(statusFromError({ status: 200 }, 500), 500);
  assert.equal(statusFromError({ status: 999 }, 500), 500);
  assert.equal(statusFromError({}, 418), 418);
  assert.equal(statusFromError({}, 200), 500);
  assert.equal(statusFromError({}, 999), 500);
});
