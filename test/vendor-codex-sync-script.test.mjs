import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

test("Codex vendor update script pins vendor/openai-codex to upstream main", () => {
  const script = readFileSync("scripts/update-vendor-openai-codex.sh", "utf8");
  assert.match(script, /git -C "\$CODEX_VENDOR_DIR" fetch --depth 1 origin main/u);
  assert.match(script, /git -C "\$CODEX_VENDOR_DIR" checkout --detach FETCH_HEAD/u);
  assert.match(script, /npm run test:tools/u);
  assert.doesNotMatch(script, /git submodule update --remote/u);
});

test("package.json exposes Codex vendor update and tool tests", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["vendor:codex:update"], "bash scripts/update-vendor-openai-codex.sh");
  assert.equal(
    pkg.scripts["test:tools"],
    "node --test test/vendor-codex-sync-script.test.mjs test/dynamic-sandbox-cli-tool.test.mjs control-plane/test/tool-package-validator.test.mjs control-plane/test/tool-registry.test.mjs control-plane/test/openai-web-search.test.mjs control-plane/test/tool-package-routes.test.mjs test/runtime-control-plane-tools-extension.test.mjs",
  );
});
