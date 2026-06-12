import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS,
  CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS,
  CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS,
} from "../runtime/src/codex-web-search-tool.mjs";

function rustStructBody(source, name) {
  const pattern = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`, "u");
  const match = source.match(pattern);
  assert.ok(match, `${name} should exist in vendored Codex`);
  return match[1];
}

function rustFields(body) {
  return [...body.matchAll(/^\s*pub\s+(?:r#)?([a-z_]+):/gmu)].map((match) => match[1]).sort();
}

test("Beep acknowledges every vendored Codex web_search top-level field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const variant = source.match(/WebSearch\s*\{([\s\S]*?)\n\s*\},/u);
  assert.ok(variant, "ToolSpec::WebSearch should exist in vendored Codex");

  const fields = [...variant[1].matchAll(/^\s*([a-z_]+):/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(["type", ...fields].sort(), [...CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS].sort());
});

test("Beep acknowledges every vendored Codex web_search filters field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const fields = rustFields(rustStructBody(source, "ResponsesApiWebSearchFilters"));
  assert.deepEqual(fields, [...CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS].sort());
});

test("Beep acknowledges every vendored Codex web_search user_location field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const fields = rustFields(rustStructBody(source, "ResponsesApiWebSearchUserLocation"));
  assert.deepEqual(fields, [...CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS].sort());
});
