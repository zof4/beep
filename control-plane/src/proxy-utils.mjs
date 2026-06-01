const STRIPPED_PROXY_HEADERS = new Set([
  "authorization",
  "connection",
  "cookie",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionHeaderNames(headers) {
  const connection = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === "connection")?.[1];
  return new Set(
    String(connection || "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function localProxyHeaders(headers, hostPort) {
  const hopByHop = connectionHeaderNames(headers);
  const next = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const lowerName = name.toLowerCase();
    if (STRIPPED_PROXY_HEADERS.has(lowerName) || hopByHop.has(lowerName)) continue;
    next[name] = value;
  }
  next.host = `127.0.0.1:${hostPort}`;
  return next;
}

export function buildLocalProxyOptions(request, hostPort, suffixPath = "") {
  const target = new URL(request.url || "/", "http://control-plane.local");
  const safeSuffixPath = String(suffixPath || "").replace(/^\/+/u, "");
  const upstreamHost = "127.0.0.1";
  return {
    protocol: "http:",
    hostname: upstreamHost,
    port: String(hostPort),
    method: request.method,
    path: `/${safeSuffixPath}${target.search}`,
    headers: localProxyHeaders(request.headers, hostPort),
  };
}
