import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { handleSiteRoute } from "../src/site-routes.mjs";

function request(method, url, headers = {}, body = null) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = headers;
  process.nextTick(() => {
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
  return req;
}

function captureResponse() {
  let statusCode = 0;
  let body = "";
  return {
    response: {
      writeHead(status) {
        statusCode = status;
      },
      end(chunk = "") {
        body += chunk;
      },
    },
    json() {
      return { statusCode, payload: body ? JSON.parse(body) : null };
    },
  };
}

test("site update route requires operator auth before reading site state", async () => {
  let siteRead = false;
  const req = request("POST", "/api/sites/demo/update", {}, { sourcePath: "/workspace/site" });
  const response = captureResponse();

  await assert.rejects(
    handleSiteRoute({
      request: req,
      response: response.response,
      pathname: "/api/sites/demo/update",
      url: new URL("http://127.0.0.1/api/sites/demo/update"),
      store: {
        getSite() {
          siteRead = true;
          return null;
        },
      },
      requireOperatorAuth() {
        const error = new Error("operator token is invalid");
        error.status = 401;
        throw error;
      },
    }),
    /operator token is invalid/u,
  );

  assert.equal(siteRead, false);
});

test("site update route calls injected updater and returns updated site", async () => {
  const calls = [];
  const site = {
    siteId: "demo",
    runtimeId: "local",
    status: "running",
    sourcePath: "/workspace/old-site",
    proxyUrl: "http://127.0.0.1:8788/sites/demo/",
  };
  const req = request(
    "POST",
    "/api/sites/demo/update",
    { authorization: "Bearer operator" },
    { sourcePath: "/workspace/new-site" },
  );
  const response = captureResponse();
  const store = {
    getSite(siteId) {
      assert.equal(siteId, "demo");
      return site;
    },
  };

  await handleSiteRoute({
    request: req,
    response: response.response,
    pathname: "/api/sites/demo/update",
    url: new URL("http://127.0.0.1/api/sites/demo/update"),
    store,
    requireOperatorAuth(requestForAuth) {
      assert.equal(requestForAuth.headers.authorization, "Bearer operator");
    },
    updateStaticSitePreview: async (input) => {
      calls.push(input);
      return {
        ...site,
        sourcePath: "/workspace/new-site",
        directUrl: "http://127.0.0.1:49199/",
        revision: 2,
      };
    },
  });

  const { statusCode, payload } = response.json();
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.site.siteId, "demo");
  assert.equal(payload.site.revision, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runtimeId, "local");
  assert.equal(calls[0].site, site);
  assert.deepEqual(calls[0].args, { sourcePath: "/workspace/new-site" });
  assert.equal(calls[0].store, store);
});
