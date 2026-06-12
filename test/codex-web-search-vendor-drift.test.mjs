import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS,
  CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS,
  CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS,
} from "../runtime/src/codex-web-search-tool.mjs";

function assertRustMatch(source, pattern, message) {
  assert.match(source, pattern, message);
}

function rustStructBody(source, name) {
  const pattern = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`, "u");
  const match = source.match(pattern);
  assert.ok(match, `${name} should exist in vendored Codex`);
  return match[1];
}

function rustEnumVariantBody(source, enumName, variantName) {
  const enumPattern = new RegExp(`pub enum ${enumName} \\{([\\s\\S]*?)\\n\\}`, "u");
  const enumMatch = source.match(enumPattern);
  assert.ok(enumMatch, `${enumName} should exist in vendored Codex`);

  const variantPattern = new RegExp(`${variantName}\\s*\\{([\\s\\S]*?)\\n\\s*\\},`, "u");
  const variantMatch = enumMatch[1].match(variantPattern);
  assert.ok(variantMatch, `${enumName}::${variantName} should exist in vendored Codex`);
  return variantMatch[1];
}

function rustFields(body) {
  return [...body.matchAll(/^\s*pub\s+(?:r#)?([a-z_]+):/gmu)].map((match) => match[1]).sort();
}

function assertRustField(body, fieldName, fieldType) {
  const fieldPattern = new RegExp(`^\\s*(?:pub\\s+)?(?:r#)?${fieldName}:\\s*${fieldType},$`, "mu");
  assertRustMatch(body, fieldPattern, `Expected Rust field ${fieldName}: ${fieldType}`);
}

test("Beep acknowledges every vendored Codex web_search top-level field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const variantBody = rustEnumVariantBody(source, "ToolSpec", "WebSearch");

  assertRustMatch(source, /#\[serde\(tag = "type"\)\]\s*pub enum ToolSpec/u, "ToolSpec should serialize with a type tag");
  assertRustMatch(
    source,
    /#\[serde\(rename = "web_search"\)\]\s*WebSearch\s*\{/u,
    "ToolSpec::WebSearch should serialize with the web_search discriminator",
  );
  assertRustField(variantBody, "external_web_access", "Option<bool>");
  assertRustField(variantBody, "filters", "Option<ResponsesApiWebSearchFilters>");
  assertRustField(variantBody, "user_location", "Option<ResponsesApiWebSearchUserLocation>");
  assertRustField(variantBody, "search_context_size", "Option<WebSearchContextSize>");
  assertRustField(variantBody, "search_content_types", "Option<Vec<String>>");

  const fields = [...variantBody.matchAll(/^\s*([a-z_]+):/gmu)].map((match) => match[1]).sort();
  assert.deepEqual(["type", ...fields].sort(), [...CODEX_WEB_SEARCH_ACKNOWLEDGED_FIELDS].sort());
});

test("Beep acknowledges every vendored Codex web_search filters field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const body = rustStructBody(source, "ResponsesApiWebSearchFilters");
  assertRustField(body, "allowed_domains", "Option<Vec<String>>");
  const fields = rustFields(body);
  assert.deepEqual(fields, [...CODEX_WEB_SEARCH_ACKNOWLEDGED_FILTER_FIELDS].sort());
});

test("Beep acknowledges every vendored Codex web_search user_location field", () => {
  const source = readFileSync("vendor/openai-codex/codex-rs/tools/src/tool_spec.rs", "utf8");
  const body = rustStructBody(source, "ResponsesApiWebSearchUserLocation");
  assertRustMatch(
    body,
    /#\[serde\(rename = "type"\)\]\s*pub r#type:\s*WebSearchUserLocationType,/u,
    "ResponsesApiWebSearchUserLocation.r#type should serialize as JSON field type",
  );
  assertRustField(body, "type", "WebSearchUserLocationType");
  assertRustField(body, "country", "Option<String>");
  assertRustField(body, "region", "Option<String>");
  assertRustField(body, "city", "Option<String>");
  assertRustField(body, "timezone", "Option<String>");
  const fields = rustFields(body);
  assert.deepEqual(fields, [...CODEX_WEB_SEARCH_ACKNOWLEDGED_USER_LOCATION_FIELDS].sort());
});
