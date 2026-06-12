import {
  buildCodexWebSearchTool,
  injectCodexWebSearchTool,
  readCodexWebSearchConfig,
} from "../src/codex-web-search-tool.mjs";

function statusText(result) {
  if (result.injected) return result.removed > 0 ? "replaced" : "injected";
  return result.removed > 0 ? "removed" : "unchanged";
}

export default function beepCodexWebSearchExtension(pi) {
  const config = readCodexWebSearchConfig();
  const webSearchTool = buildCodexWebSearchTool(config);
  let logged = false;

  pi.on("before_provider_request", (event) => {
    const result = injectCodexWebSearchTool(event?.payload, webSearchTool);
    if (!result.changed) return undefined;

    if (!logged) {
      logged = true;
      console.error(
        `[beep-codex-web-search] ${statusText(result)} hosted web_search mode=${config.mode} removed=${result.removed}`,
      );
    }
    return result.payload;
  });
}
