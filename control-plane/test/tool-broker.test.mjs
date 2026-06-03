import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PREVIEW_HOST_PORT_BASE, PUBLIC_BASE_URL, RUNTIME_ID } from "../src/config.mjs";
import { StateStore } from "../src/state-store.mjs";
import { ToolBroker } from "../src/tool-broker.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "beep-tool-broker-test-"));
  const store = new StateStore(dir);
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("preview port exposure preserves path-only preview URLs", async () => {
  const { store, cleanup } = tempStore();
  try {
    const broker = new ToolBroker({ store });
    const cases = [
      { path: "/", suffix: "/" },
      { path: "/index.html", suffix: "/index.html" },
      { path: "index.html", suffix: "/index.html" },
      { path: "/docs/page.html", suffix: "/docs/page.html" },
      { path: "/?q=1", suffix: "/?q=1" },
      { path: "#section", suffix: "/#section" },
    ];

    for (const { path, suffix } of cases) {
      const result = await broker.call({
        runtimeId: RUNTIME_ID,
        action: "preview.port.expose",
        args: { port: 3000, path },
      });

      assert.equal(result.ok, true);
      assert.equal(new URL(result.result.url).origin, new URL(PUBLIC_BASE_URL).origin);
      assert.equal(new URL(result.result.directUrl).origin, `http://127.0.0.1:${PREVIEW_HOST_PORT_BASE}`);
      const previewUrl = new URL(result.result.url);
      const directUrl = new URL(result.result.directUrl);
      assert.equal(`${previewUrl.pathname}${previewUrl.search}${previewUrl.hash}`, `/preview/${RUNTIME_ID}/3000${suffix}`);
      assert.equal(`${directUrl.pathname}${directUrl.search}${directUrl.hash}`, suffix);
    }
  } finally {
    cleanup();
  }
});

test("preview port exposure cannot return external URLs from scheme-like paths", async () => {
  const { store, cleanup } = tempStore();
  try {
    const broker = new ToolBroker({ store });
    const poisoningPaths = [
      "https://attacker.test/x",
      "http://attacker.test/x",
      "//attacker.test/x",
      "javascript:alert(1)",
      "\\\\attacker.test\\x",
      " http://attacker.test/x",
      "\nhttps://attacker.test/x",
      "/https://attacker.test/x",
    ];

    for (const path of poisoningPaths) {
      const result = await broker.call({
        runtimeId: RUNTIME_ID,
        action: "preview.port.expose",
        args: { port: 3000, path },
      });

      assert.equal(result.ok, true);
      assert.equal(new URL(result.result.url).origin, new URL(PUBLIC_BASE_URL).origin);
      assert.equal(new URL(result.result.directUrl).origin, `http://127.0.0.1:${PREVIEW_HOST_PORT_BASE}`);
      assert.notEqual(new URL(result.result.url).hostname, "attacker.test");
      assert.notEqual(new URL(result.result.directUrl).hostname, "attacker.test");

      const exposure = store.readState().exposures[`${RUNTIME_ID}:3000`];
      assert.equal(new URL(exposure.url).origin, new URL(PUBLIC_BASE_URL).origin);
      assert.equal(new URL(exposure.directUrl).origin, `http://127.0.0.1:${PREVIEW_HOST_PORT_BASE}`);
    }
  } finally {
    cleanup();
  }
});
